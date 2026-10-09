// The chain as the methods see it: blocks and transactions by number or hash, from one pinned
// archive generation (genesis to P) and, when bound, the live window (P+1 to head).
//
// Consistency (storage.md, "Reads above P"): the request pins the live head once and passes it
// to every live read. A stale answer (a reorg removed the pin) re-reads the live state and
// retries once. A promotion moves blocks out of the live window before the cached manifest may
// know they are in R2; a live miss at or below the live `promoted` pointer re-reads HEAD.json.
// Block and transaction reads in the window normally come from R2 records listed by the pinned
// head's live/HEAD.json (src/live.ts); the live Worker is asked only for what those cannot answer.

import type { Archive, BlockRun, Pin } from "./archive/archive";
import { blockCandidates, transactionCandidates } from "./archive/hashindex";
import { Lru } from "./archive/lru";
import { StateHistory, type Domain } from "./archive/state";
import { archiveWitness } from "./archive/witness";
import { ArchiveError } from "./archive/types";
import { data, equal } from "./eth/hex";
import { decodeRecord, type BlockRecord } from "./eth/record";
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

function decodedRecord(hash: string, frame: Uint8Array): BlockRecord {
  let rec = decodedRecords.get(hash);
  if (!rec) {
    rec = decodeRecord(frame);
    decodedRecords.set(hash, rec);
  }
  return rec;
}
const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

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

  private async archiveBlock(n: number): Promise<BlockRecord | null> {
    const found = await this.archive.blockFrame(this.pin, n);
    return found && this.archiveRecord(n, found);
  }

  private archiveRecord(n: number, found: { hash: Uint8Array; frame: Uint8Array }): BlockRecord {
    const rec = decodedRecord(data(found.hash), found.frame);
    if (rec.block.header.number !== n || !equal(rec.block.header.hash, found.hash)) throw new ArchiveError(`block ${n} does not match its offsets record`);
    return rec;
  }

  // ---- bulk reads (eth_getLogs)

  /** Per archived block of `numbers` (sorted), whether it adds an offsets page read. */
  offsetsPages(numbers: number[]): boolean[] {
    return this.archive.offsetsPages(this.pin, numbers);
  }

  /** The coalesced range reads that fetch archived blocks `numbers` (sorted); reads their offsets. */
  planArchived(numbers: number[]): Promise<BlockRun[]> {
    return this.archive.planBlockRuns(this.pin, numbers);
  }

  /**
   * Reads planned runs `wave` at a time, in order, and hands every block's checked frame to
   * `each` in block order; the next wave is in flight while a wave is decoded. `each`
   * returning false stops.
   */
  async readArchived(runs: BlockRun[], wave: number, each: (block: { n: number; hash: Uint8Array; frame: Uint8Array }) => boolean | void): Promise<void> {
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

  private liveRecord(found: { number: number; hash: string; record: Uint8Array }): BlockRecord {
    const rec = decodedRecord(found.hash.toLowerCase(), found.record);
    if (rec.block.header.number !== found.number || data(rec.block.header.hash) !== found.hash.toLowerCase()) {
      throw new ArchiveError(`live block ${found.number} does not match its hash`);
    }
    return rec;
  }

  async blockByHash(hash: Uint8Array): Promise<BlockRecord | null> {
    // Recent hashes are the common case: ask the live window first.
    const found = await this.withHead((head) => this.live!.block(data(hash), head));
    if (found) {
      const rec = this.liveRecord(found);
      this.blocks.set(rec.block.header.number, Promise.resolve(rec));
      return rec;
    }
    for (const n of await blockCandidates(this.archive, this.pin, hash)) {
      const rec = await this.block(n);
      if (rec && equal(rec.block.header.hash, hash)) return rec;
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

  /** The block and index of a transaction hash, or null. */
  async transaction(hash: Uint8Array): Promise<{ rec: BlockRecord; index: number } | null> {
    const liveNumber = await this.withHead((head) => this.live!.txBlock(data(hash), head));
    if (liveNumber !== null) {
      const rec = await this.block(liveNumber);
      const index = rec ? rec.block.txs.findIndex((t) => equal(t.hash, hash)) : -1;
      if (rec && index >= 0) return { rec, index };
    }
    for (const c of await transactionCandidates(this.archive, this.pin, hash)) {
      const rec = await this.block(c.block);
      const tx = rec?.block.txs[c.index];
      if (rec && tx && equal(tx.hash, hash)) return { rec, index: c.index };
    }
    return null;
  }
}
