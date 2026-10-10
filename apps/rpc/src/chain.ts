// The chain as the methods see it: blocks and transactions by number or hash, from one pinned
// archive generation (genesis to P) and, when bound, the live window (P+1 to head).
//
// Consistency (storage.md, "Reads above P"): the request pins the live head once and passes it
// to every live read. A stale answer (a reorg removed the pin) re-reads the live state and
// retries once. A promotion moves blocks out of the live window before the cached manifest may
// know they are in R2; a live miss at or below the live `promoted` pointer re-reads HEAD.json.
// Block and transaction reads in the window normally come from R2 records listed by the pinned
// head's live/HEAD.json (src/live.ts); the live Worker is asked only for what those cannot answer.

import type { Archive, BlockFrame, BlockNeed, BlockRun, Pin, RunBlock } from "./archive/archive";
import { blockCandidates, transactionCandidates, type Candidate } from "./archive/hashindex";
import { Lru } from "./archive/lru";
import { StateHistory, type Domain } from "./archive/state";
import { archiveWitness } from "./archive/witness";
import { ArchiveError } from "./archive/types";
import { data, equal, parseData } from "./eth/hex";
import { decodeBlockFrame, decodeRecord, type BlockPart, type BlockRecord } from "./eth/record";
import { StaleError, type BlockId, type Live, type LiveState } from "./live";

/** The live Worker's domain codes (apps/live/src/codec.ts). */
const DOMAIN_CODE = { accounts: 1, storage: 2, code: 3 } as const;

/**
 * Account and storage values the state history answered, per isolate, by (archive, domain,
 * key, block). The history at a block never changes, so a key the window has not changed is
 * read at P once per isolate, not once per call, until P moves. Code is by hash and cached by
 * the executor's shell.
 */
const archiveValues = new Lru<string, Uint8Array>(32_768);
/** Decoded block records by hash, per isolate: a record is immutable, and the head's is
 *  decoded for every call at `latest` otherwise. */
const decodedRecords = new Lru<string, BlockRecord>(32);
/** Decoded layout-2 block frames (no receipts) by hash, likewise. */
const decodedParts = new Lru<string, BlockPart>(32);

function decodedRecord(hash: string, frame: Uint8Array): BlockRecord {
  let rec = decodedRecords.get(hash);
  if (!rec) {
    rec = decodeRecord(frame);
    decodedRecords.set(hash, rec);
  }
  return rec;
}

function decodedPart(hash: string, frame: Uint8Array): BlockPart {
  let part: BlockPart | undefined = decodedRecords.get(hash) ?? decodedParts.get(hash);
  if (!part) {
    part = decodeBlockFrame(frame);
    decodedParts.set(hash, part);
  }
  return part;
}
const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/**
 * Where a hash was found in the archive (hashindex.ts), verified by reading the block. Blocks
 * in the archive never move, so a location holds for every later generation; `generation` is
 * the one that verified it, and a request pinned to an earlier generation (whose archive may
 * not reach the block) does not use it. Hashes the live window answered are not cached: a
 * reorg may move them.
 */
export interface HashLocation extends Candidate {
  generation: number;
}
/** Verified hash locations per isolate, by archive, kind and hash. Exported for tests. */
export const hashLocations = new Lru<string, HashLocation>(8192);

export interface Pointers {
  latest: number;
  safe: number;
  finalized: number;
  earliest: number;
  /** The archive's newest block (P). */
  archived: number;
}

/** What one request's executions read (the `x-nullrpc-exec` response header). */
export interface ExecStats {
  /** Read rounds (StateSource.read calls). */
  rounds: number;
  /** Keys those rounds asked for. */
  keys: number;
  /** Keys answered ahead of the first round from witnesses (StateSource.hints). */
  hints: number;
  /** Keys the live window answered. */
  live: number;
  /** Keys read from the state history (at P or below). */
  archive: number;
}

/** One request's view of the chain. Decoded blocks are shared within the request. */
export class Chain {
  private readonly blocks = new Map<number, Promise<BlockRecord | null>>();
  /** Blocks read without their receipts (`part`); a block in `blocks` is never read again here. */
  private readonly parts = new Map<number, Promise<BlockPart | null>>();
  readonly exec: ExecStats = { rounds: 0, keys: 0, hints: 0, live: 0, archive: 0 };
  private historyPin: Pin | null = null;
  private historyOf: StateHistory | null = null;

  private constructor(
    private readonly archive: Archive,
    public pin: Pin,
    private readonly live: Live | null,
    public state: LiveState | null,
  ) {}

  static async open(archive: Archive, live: Live | null, now = Date.now()): Promise<Chain> {
    const [pin, state] = await Promise.all([archive.pin(now), live ? live.state(false, now) : null]);
    const chain = new Chain(archive, pin, live, state);
    await chain.catchUpArchive();
    return chain;
  }

  /** The chain config object (storage.md, "Chain config"), cached by digest. */
  async config(): Promise<Record<string, unknown>> {
    // The object is the chain's genesis.json; its `config` member is the fork schedule.
    const genesis = await this.archive.json<Record<string, unknown>>(this.pin.manifest.config);
    return (genesis.config as Record<string, unknown> | undefined) ?? genesis;
  }

  /** The archive this request reads (for index lookups by method modules). */
  get archiveHandle(): Archive {
    return this.archive;
  }

  /** The archive tip P of the pinned generation. */
  get archived(): number {
    return this.pin.manifest.archived_through.number;
  }

  private get head(): BlockId | null {
    const h = this.state?.head;
    return h && h.number > this.archived ? h : null;
  }

  /** Re-reads HEAD.json when the live window says blocks were promoted past the cached P. */
  private async catchUpArchive(): Promise<void> {
    const promoted = this.state?.promoted?.number ?? 0;
    if (promoted > this.archived) this.pin = await this.archive.pin(Date.now(), true);
  }

  pointers(): Pointers {
    const p = this.archived;
    const s = this.state;
    const above = (b: BlockId | null | undefined) => (b && b.number > p ? b.number : p);
    return { latest: above(this.head), safe: above(s?.safe), finalized: above(s?.finalized), earliest: this.pin.manifest.first_block, archived: p };
  }

  /** Runs a live read with the pinned head; on a stale pin, re-pins once and retries. */
  private async withHead<T>(read: (head: BlockId) => Promise<T>): Promise<T | null> {
    if (!this.live || !this.head) return null;
    try {
      return await read(this.head);
    } catch (e) {
      if (!(e instanceof StaleError)) throw e;
      this.state = await this.live.state(true);
      this.blocks.clear();
      this.parts.clear();
      await this.catchUpArchive();
      return this.head ? read(this.head) : null;
    }
  }

  /** Block `n`, or null if it is above the head or not stored. */
  block(n: number): Promise<BlockRecord | null> {
    let p = this.blocks.get(n);
    if (!p) {
      p = this.readBlock(n);
      this.blocks.set(n, p);
      p.catch(() => this.blocks.get(n) === p && this.blocks.delete(n));
    }
    return p;
  }

  private async readBlock(n: number): Promise<BlockRecord | null> {
    if (n <= this.archived) return this.archiveBlock(n);
    const found = await this.withHead((head) => this.live!.block(n, head));
    if (found) return this.liveRecord(found);
    // Promoted since this request pinned the archive: the block is now in R2.
    if (n <= (this.state?.promoted?.number ?? 0)) {
      await this.catchUpArchive();
      if (n <= this.archived) return this.archiveBlock(n);
    }
    return null;
  }

  /**
   * The hash of block `n` (lowercase, 0x) when it is known without reading the block: from the
   * archive's offsets record at or below P, from the pinned head's listing of the window above
   * it. Null when only the record says (above the head, a window the document does not list,
   * or a pin from state()). A hash fixes a block's contents, so what a method derives from a
   * block can be kept under it across requests and heads (src/methods/fees.ts).
   */
  async hashOf(n: number): Promise<string | null> {
    if (n <= this.archived) {
      const hash = await this.archive.blockHash(this.pin, n);
      return hash ? data(hash) : null;
    }
    const head = this.head;
    return head && this.live ? this.live.listedHash(n, head) : null;
  }

  private async archiveBlock(n: number): Promise<BlockRecord | null> {
    const found = await this.archive.blockFrame(this.pin, n);
    return found && this.archiveRecord(n, found);
  }

  private archiveRecord(n: number, found: BlockFrame): BlockRecord {
    const rec = decodedRecord(data(found.hash), found.frame);
    return this.checked(n, found.hash, rec);
  }

  private checked<T extends BlockPart>(n: number, hash: Uint8Array, rec: T): T {
    if (rec.block.header.number !== n || !equal(rec.block.header.hash, hash)) throw new ArchiveError(`block ${n} does not match its offsets record`);
    return rec;
  }

  /**
   * Block `n` without its receipts, or null if it is above the head or not stored: what the
   * block, header and transaction methods need. A layout-2 segment answers from its block
   * frame alone (one frame read fewer); any other source answers with the whole record.
   */
  part(n: number): Promise<BlockPart | null> {
    let p: Promise<BlockPart | null> | undefined = this.blocks.get(n) ?? this.parts.get(n);
    if (!p) {
      p = this.readPart(n);
      this.parts.set(n, p);
      p.catch(() => this.parts.get(n) === p && this.parts.delete(n));
    }
    return p;
  }

  private async readPart(n: number): Promise<BlockPart | null> {
    if (n > this.archived) return this.block(n);
    const found = await this.archive.blockFrame(this.pin, n, "block");
    if (!found) return null;
    if (found.kind === "record") {
      // A layout-1 segment: the whole record came back; the request keeps it as such.
      const rec = this.archiveRecord(n, found);
      if (!this.blocks.has(n)) this.blocks.set(n, Promise.resolve(rec));
      return rec;
    }
    return this.checked(n, found.hash, decodedPart(data(found.hash), found.frame));
  }

  /** `block` or `part`, by what the caller needs. */
  private read(n: number, need: BlockNeed): Promise<BlockPart | null> {
    return need === "block" ? this.part(n) : this.block(n);
  }

  // ---- hashes

  private locationKey(kind: "tx" | "block", hash: Uint8Array): string {
    return `${this.archive.namespace}:${kind}:${hexOf(hash)}`;
  }

  /** The isolate's verified location of a hash, when the pinned generation's archive reaches it. */
  private cachedLocation(key: string): HashLocation | null {
    const c = hashLocations.get(key);
    return c && c.generation <= this.pin.generation && c.block <= this.archived ? c : null;
  }

  // ---- bulk reads (eth_getLogs)

  /** Per archived block of `numbers` (sorted), whether it adds an offsets page read. */
  offsetsPages(numbers: number[]): boolean[] {
    return this.archive.offsetsPages(this.pin, numbers);
  }

  /**
   * The coalesced range reads that fetch what a log query decodes of archived blocks `numbers`
   * (sorted): receipts frames where the segment stores them apart, whole records otherwise.
   * Reads their offsets.
   */
  planArchived(numbers: number[]): Promise<BlockRun[]> {
    return this.archive.planBlockRuns(this.pin, numbers, "receipts");
  }

  /**
   * Reads planned runs `wave` at a time, in order, and hands every block's checked frame (a
   * record or a receipts frame, by its `kind`) to `each` in block order; the next wave is in
   * flight while a wave is decoded. `each` returning false stops.
   */
  async readArchived(runs: BlockRun[], wave: number, each: (block: RunBlock) => boolean | void): Promise<void> {
    const read = (i: number) => Promise.all(runs.slice(i, i + wave).map((r) => this.archive.readRun(r)));
    let pending = runs.length ? read(0) : null;
    for (let i = 0; pending; i += wave) {
      const found = await pending;
      pending = i + wave < runs.length ? read(i + wave) : null;
      for (const run of found) for (const b of run) if (each(b) === false) return;
    }
  }

  /** Reads blocks `numbers` (any source) `wave` at a time and hands them to `each` in order. */
  async readBlocks(numbers: number[], wave: number, each: (rec: BlockRecord) => boolean | void): Promise<void> {
    for (let i = 0; i < numbers.length; i += wave) {
      const found = await Promise.all(numbers.slice(i, i + wave).map((n) => this.block(n)));
      for (const rec of found) if (rec && each(rec) === false) return;
    }
  }

  // ---- live-window log reads (eth_getLogs)

  /**
   * The live blocks of [from, to] (clipped at the pinned head) that may hold a log the filter
   * accepts: those whose header logs bloom `admits`, and every block the pin's blooms do not
   * cover (an older daemon, a pin from state(), a block below the listed range). Reads the
   * blooms object once per isolate and head; no live call.
   */
  async liveLogBlocks(from: number, to: number, admits: (bloom: Uint8Array) => boolean): Promise<number[]> {
    const head = this.head;
    if (!this.live || !head) return [];
    to = Math.min(to, head.number);
    const out: number[] = [];
    if (from > to) return out;
    const table = await this.live.logBlooms(head);
    for (let n = from; n <= to; n++) {
      const bloom = table?.bloom(n);
      if (!bloom || admits(bloom)) out.push(n);
    }
    return out;
  }

  /**
   * Reads the raw records of live blocks `numbers` (sorted) `wave` at a time and hands each
   * one's frame and hash to `each` in block order, undecoded; `each` returning false stops.
   * A block the window no longer holds because it was promoted since the request pinned the
   * archive is read from the archive, as block() does. A stale pin re-pins once (as withHead
   * does) and the blocks not yet read are narrowed again under the new head by `narrow`,
   * since the old head's blooms no longer apply.
   */
  async readLiveFrames(numbers: number[], wave: number, narrow: (from: number, to: number) => Promise<number[]>, each: (b: { n: number; hash: Uint8Array; frame: Uint8Array }) => boolean | void): Promise<void> {
    let list = numbers;
    let repinned = false;
    for (let i = 0; i < list.length; ) {
      const slice = list.slice(i, i + wave);
      let found: ({ n: number; hash: Uint8Array; frame: Uint8Array } | null)[];
      try {
        found = await Promise.all(slice.map((n) => this.liveFrame(n)));
      } catch (e) {
        if (!(e instanceof StaleError) || repinned || !this.live) throw e;
        repinned = true;
        this.state = await this.live.state(true);
        this.blocks.clear();
        this.parts.clear();
        await this.catchUpArchive();
        const rest = await narrow(slice[0]!, list[list.length - 1]!);
        list = [...list.slice(0, i), ...rest];
        continue;
      }
      i += wave;
      for (const b of found) if (b && each(b) === false) return;
    }
  }

  /** Block `n`'s raw record and hash from the live window at the pinned head, else from the archive when promoted meanwhile; null when neither has it. */
  private async liveFrame(n: number): Promise<{ n: number; hash: Uint8Array; frame: Uint8Array } | null> {
    if (n > this.archived && this.live && this.head) {
      const found = await this.live.block(n, this.head);
      if (found) {
        if (found.number !== n) throw new ArchiveError(`live block ${found.number} answered for ${n}`);
        return { n, hash: parseData(found.hash, 32)!, frame: found.record };
      }
      if (n > (this.state?.promoted?.number ?? 0)) return null;
    }
    // Promoted since this request pinned the archive (or at or below P after a re-pin).
    const rec = await this.block(n);
    return rec && { n, hash: rec.block.header.hash, frame: rec.frame };
  }

  private liveRecord(found: { number: number; hash: string; record: Uint8Array }): BlockRecord {
    const rec = decodedRecord(found.hash.toLowerCase(), found.record);
    if (rec.block.header.number !== found.number || data(rec.block.header.hash) !== found.hash.toLowerCase()) {
      throw new ArchiveError(`live block ${found.number} does not match its hash`);
    }
    return rec;
  }

  /**
   * The block with hash `hash`, or null: the whole record, or with `need` "block" only the block
   * (`part`). The isolate's verified locations answer first (no live or index read), then the
   * live window (recent hashes are the common case), then the hash index; an index hit is
   * verified against the block's header and remembered.
   */
  blockByHash(hash: Uint8Array): Promise<BlockRecord | null>;
  blockByHash(hash: Uint8Array, need: "block"): Promise<BlockPart | null>;
  blockByHash(hash: Uint8Array, need: BlockNeed): Promise<BlockPart | null>;
  async blockByHash(hash: Uint8Array, need: BlockNeed = "record"): Promise<BlockPart | null> {
    const key = this.locationKey("block", hash);
    const cached = this.cachedLocation(key);
    if (cached) {
      const rec = await this.read(cached.block, need);
      if (rec && equal(rec.block.header.hash, hash)) return rec;
      hashLocations.delete(key);
    }
    const found = await this.withHead((head) => this.live!.block(data(hash), head));
    if (found) {
      const rec = this.liveRecord(found);
      this.blocks.set(rec.block.header.number, Promise.resolve(rec));
      return rec;
    }
    for (const n of await blockCandidates(this.archive, this.pin, hash)) {
      const rec = await this.read(n, need);
      if (rec && equal(rec.block.header.hash, hash)) {
        hashLocations.set(key, { block: n, index: 0, generation: this.pin.generation });
        return rec;
      }
    }
    return null;
  }

  /** The state history of the pinned generation, one per request (its reads share a budget). */
  history(): StateHistory {
    if (!this.historyOf || this.historyPin !== this.pin) {
      this.historyPin = this.pin;
      this.historyOf = new StateHistory(this.archive, this.pin);
    }
    return this.historyOf;
  }

  /** The value of a state key at the end of block `n` (empty when absent or zero). */
  async stateValue(domain: Domain, key: Uint8Array, n: number): Promise<Uint8Array> {
    if (n > this.archived) {
      const v = await this.withHead((head) => this.live!.stateValue(DOMAIN_CODE[domain], key, Math.min(n, head.number), head));
      if (v !== null) return v;
      // Unchanged since P: the archive at P answers.
      return this.archiveValue(domain, key, this.archived);
    }
    return this.archiveValue(domain, key, n);
  }

  /** The block the archive answers a key at: `n` capped at P; code is immutable, so P. */
  private archiveAt(domain: Domain, n: number): number {
    return domain === "code" ? this.archived : Math.min(n, this.archived);
  }

  /** The state history's value of a key at `n` (at or below P), through the isolate's value cache. */
  private archiveValue(domain: Domain, key: Uint8Array, n: number): Promise<Uint8Array> {
    if (domain === "code") return this.history().get(domain, key, n);
    const id = `${this.archive.namespace}:${domain}:${hexOf(key)}:${n}`;
    const cached = archiveValues.get(id);
    if (cached) return Promise.resolve(cached);
    return this.history()
      .get(domain, key, n)
      .then((v) => {
        archiveValues.set(id, v);
        return v;
      });
  }

  /**
   * The live window's values for many keys at the end of block `n`, in order; null for a key
   * the window has no row for (unchanged since P) and for every key when `n` is at or below P.
   */
  async liveValues(keys: { domain: Domain; key: Uint8Array }[], n: number): Promise<(Uint8Array | null)[]> {
    if (keys.length === 0 || n <= this.archived) return keys.map(() => null);
    const live = await this.withHead((head) => this.live!.stateValues(keys.map((k) => ({ domain: DOMAIN_CODE[k.domain], key: k.key })), Math.min(n, head.number), head));
    return keys.map((k, i) => {
      const v = live?.[i] ?? null;
      return v !== null && (k.domain !== "code" || v.length) ? v : null;
    });
  }

  /**
   * stateValue for many keys at once, in order. Above P the live window (one call) and the
   * archive at P are read together: the window's answer wins for the keys it has a row for,
   * the archive's stands for the rest, and the round takes the slower of the two instead of
   * both. Code is by hash and immutable, so a code key is answered wherever its bytes are (the
   * window for new code, else the archive at P), as code() does.
   */
  async stateValues(keys: { domain: Domain; key: Uint8Array }[], n: number): Promise<Uint8Array[]> {
    if (keys.length === 0) return [];
    const pin = this.pin;
    const archive = keys.map((k) => this.archiveValue(k.domain, k.key, this.archiveAt(k.domain, n)));
    for (const p of archive) p.catch(() => {});
    if (n <= this.archived) {
      this.exec.archive += keys.length;
      return Promise.all(archive);
    }
    const live = await this.liveValues(keys, n);
    // A stale pin re-read HEAD.json: the archive reads above were at the old P, so a key the
    // window no longer has (promoted since) is read again at the new one.
    const fresh = this.pin === pin ? archive : keys.map((k) => this.archiveValue(k.domain, k.key, this.archiveAt(k.domain, n)));
    return Promise.all(
      keys.map((k, i) => {
        const v = live[i] ?? null;
        if (v !== null) {
          this.exec.live++;
          return v;
        }
        this.exec.archive++;
        return fresh[i]!;
      }),
    );
  }

  /** Bytecode by hash (immutable: the archive's code domain, or the live window for new code). */
  async code(hash: Uint8Array): Promise<Uint8Array> {
    if (this.head) {
      const v = await this.withHead((head) => this.live!.stateValue(3, hash, head.number, head));
      if (v !== null && v.length) return v;
    }
    return this.history().get("code", hash, this.archived);
  }

  /** A block's witness bytes (pre-state), or null when none is stored. */
  async witness(n: number): Promise<Uint8Array | null> {
    if (n <= this.archived) return archiveWitness(this.archive, this.pin, n);
    return this.withHead((head) => this.live!.witness(n, head));
  }

  /**
   * The block and index of a transaction hash, or null: the block's whole record, or with
   * `need` "block" only the block (`part`: enough for the transaction itself; a receipt needs
   * the record). Resolved as blockByHash is: cached location, live window, hash index.
   */
  transaction(hash: Uint8Array): Promise<{ rec: BlockRecord; index: number } | null>;
  transaction(hash: Uint8Array, need: "block"): Promise<{ rec: BlockPart; index: number } | null>;
  async transaction(hash: Uint8Array, need: BlockNeed = "record"): Promise<{ rec: BlockPart; index: number } | null> {
    const key = this.locationKey("tx", hash);
    const verify = async (c: Candidate) => {
      const rec = await this.read(c.block, need);
      const tx = rec?.block.txs[c.index];
      return rec && tx && equal(tx.hash, hash) ? { rec, index: c.index } : null;
    };
    const cached = this.cachedLocation(key);
    if (cached) {
      const found = await verify(cached);
      if (found) return found;
      hashLocations.delete(key);
    }
    const liveNumber = await this.withHead((head) => this.live!.txBlock(data(hash), head));
    if (liveNumber !== null) {
      const rec = await this.read(liveNumber, need);
      const index = rec ? rec.block.txs.findIndex((t) => equal(t.hash, hash)) : -1;
      if (rec && index >= 0) return { rec, index };
    }
    for (const c of await transactionCandidates(this.archive, this.pin, hash)) {
      const found = await verify(c);
      if (found) {
        hashLocations.set(key, { ...c, generation: this.pin.generation });
        return found;
      }
    }
    return null;
  }
}
