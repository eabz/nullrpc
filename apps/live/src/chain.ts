// ChainDO (docs/storage.md, "ChainDO"): the live window's block records and witnesses, and the
// pointers (head, safe, finalized, last promoted block, current generation). One row per group
// of blocks.

import { DurableObject } from "cloudflare:workers";
import { decodeBlockData, decodeSections, encodeSections, hex, join, split, type BlockId, type Section } from "./codec";
import type { Env } from "./env";
import type { GroupRow } from "./shard";

const ORPHAN_TTL_MS = 3600_000;

export interface ChainState {
  head: BlockId | null;
  safe: BlockId | null;
  finalized: BlockId | null;
  promoted: BlockId | null;
  generation: number;
  shards: number | null;
}

export class ChainDO extends DurableObject<Env> {
  private sql: SqlStorage;
  /** hash -> number and number -> hash of every block in the window; built on first use. */
  private byHash: Map<string, number> | null = null;
  private byNumber = new Map<number, string>();
  /** tx hash hex -> block number; built on first use. */
  private txIndex: Map<string, number> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS rows (
      first INTEGER, part INTEGER, last INTEGER, data BLOB, PRIMARY KEY (first, part))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS orphans (hash TEXT PRIMARY KEY, number INTEGER, at INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)`);
  }

  private get<T>(k: string): T | null {
    const row = this.sql.exec<{ v: string }>("SELECT v FROM kv WHERE k = ?", k).toArray()[0];
    return row ? (JSON.parse(row.v) as T) : null;
  }

  private set(k: string, v: unknown): void {
    this.sql.exec("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)", k, JSON.stringify(v));
  }

  private readRows(where = "", ...args: unknown[]): { first: number; last: number; data: Uint8Array }[] {
    const rows = this.sql.exec<{ first: number; last: number; data: ArrayBuffer }>(
      `SELECT first, last, data FROM rows ${where} ORDER BY first, part`, ...args).toArray();
    const out: { first: number; last: number; data: Uint8Array }[] = [];
    let i = 0;
    while (i < rows.length) {
      const { first, last } = rows[i]!;
      const parts: ArrayBuffer[] = [];
      while (i < rows.length && rows[i]!.first === first) parts.push(rows[i++]!.data);
      out.push({ first, last, data: join(parts) });
    }
    return out;
  }

  private writeRow(first: number, last: number, data: Uint8Array): void {
    this.sql.exec("DELETE FROM rows WHERE first = ?", first);
    split(data).forEach((part, i) => {
      this.sql.exec("INSERT INTO rows (first, part, last, data) VALUES (?, ?, ?, ?)", first, i, last, part);
    });
  }

  private invalidate(): void {
    this.byHash = null;
    this.txIndex = null;
  }

  private hashes(): Map<string, number> {
    if (this.byHash) return this.byHash;
    const byHash = new Map<string, number>();
    this.byNumber.clear();
    for (const row of this.readRows()) {
      for (const s of decodeSections(row.first, row.data)) {
        byHash.set(s.hash, s.number);
        this.byNumber.set(s.number, s.hash);
      }
    }
    this.byHash = byHash;
    return byHash;
  }

  private section(number: number): Section | null {
    const row = this.readRows("WHERE first <= ? AND last >= ?", number, number)[0];
    if (!row) return null;
    return decodeSections(row.first, row.data).find((s) => s.number === number) ?? null;
  }

  async state(): Promise<ChainState> {
    return {
      head: this.get<BlockId>("head"),
      safe: this.get<BlockId>("safe"),
      finalized: this.get<BlockId>("finalized"),
      promoted: this.get<BlockId>("promoted"),
      generation: this.get<number>("generation") ?? 0,
      shards: this.get<number>("shards"),
    };
  }

  /** First start after the backfill: records the last promoted block, generation and shard count. */
  async init(promoted: BlockId, generation: number, shards: number): Promise<ChainState> {
    const st = await this.state();
    if (st.shards !== null && st.shards !== shards) throw new Error(`shard count is ${st.shards}, not ${shards}`);
    if (st.promoted === null) {
      this.ctx.storage.transactionSync(() => {
        this.set("promoted", promoted);
        this.set("generation", generation);
        this.set("shards", shards);
        this.set("head", promoted);
      });
    }
    return this.state();
  }

  async putRows(rows: GroupRow[]): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      for (const r of rows) this.writeRow(r.first, r.last, r.data);
    });
    this.invalidate();
  }

  /** Moves the head; the head's block must be in the window, or be the last promoted block. */
  async setHead(head: BlockId, safe: BlockId | null, finalized: BlockId | null): Promise<void> {
    const promoted = this.get<BlockId>("promoted");
    const atPromoted = promoted !== null && promoted.number === head.number && promoted.hash === head.hash;
    if (!atPromoted && this.hashes().get(head.hash) !== head.number) throw new Error(`no row for head ${head.number} ${head.hash}`);
    this.ctx.storage.transactionSync(() => {
      this.set("head", head);
      if (safe) this.set("safe", safe);
      if (finalized) this.set("finalized", finalized);
    });
  }

  async fence(removed: BlockId[]): Promise<void> {
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      for (const b of removed) {
        this.sql.exec("INSERT OR REPLACE INTO orphans (hash, number, at) VALUES (?, ?, ?)", b.hash, b.number, now);
      }
      this.sql.exec("DELETE FROM orphans WHERE at < ?", now - ORPHAN_TTL_MS);
    });
  }

  /** Removes every block above `number`; a group that straddles it keeps its lower blocks. */
  async truncateAbove(number: number): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      for (const row of this.readRows("WHERE first <= ? AND last > ?", number, number)) {
        const kept = decodeSections(row.first, row.data).filter((s) => s.number <= number);
        this.sql.exec("DELETE FROM rows WHERE first = ?", row.first);
        if (kept.length > 0) this.writeRow(row.first, kept[kept.length - 1]!.number, encodeSections(row.first, kept));
      }
      this.sql.exec("DELETE FROM rows WHERE first > ?", number);
    });
    this.invalidate();
  }

  /** After a promotion: groups at or below `promoted` are in R2 now. */
  async pruneAtOrBelow(promoted: BlockId, generation: number): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM rows WHERE last <= ?", promoted.number);
      this.set("promoted", promoted);
      this.set("generation", generation);
    });
    this.invalidate();
  }

  private stale(pin: BlockId): boolean {
    if (this.sql.exec("SELECT 1 FROM orphans WHERE hash = ?", pin.hash).toArray().length > 0) return true;
    this.hashes();
    const at = this.byNumber.get(pin.number);
    return at !== undefined && at !== pin.hash;
  }

  /** A block's record (hex) by number or hash, if at or below the pin. */
  async block(numberOrHash: number | string, pin: BlockId): Promise<{ stale: true } | { stale: false; number: number; hash: string; record: string } | null> {
    if (this.stale(pin)) return { stale: true };
    const number = typeof numberOrHash === "number" ? numberOrHash : this.hashes().get(numberOrHash.toLowerCase());
    if (number === undefined || number > pin.number) return null;
    const s = this.section(number);
    if (!s) return null;
    return { stale: false, number, hash: s.hash, record: hex(decodeBlockData(s.payload).record) };
  }

  async witness(number: number, pin: BlockId): Promise<{ stale: true } | { stale: false; witness: string } | null> {
    if (this.stale(pin)) return { stale: true };
    if (number > pin.number) return null;
    const s = this.section(number);
    return s ? { stale: false, witness: hex(decodeBlockData(s.payload).witness) } : null;
  }

  /** The block of a transaction hash in the live window, at or below the pin. */
  async txBlock(txHash: string, pin: BlockId): Promise<{ stale: true } | { stale: false; number: number } | null> {
    if (this.stale(pin)) return { stale: true };
    if (!this.txIndex) {
      const index = new Map<string, number>();
      for (const row of this.readRows()) {
        for (const s of decodeSections(row.first, row.data)) {
          for (const h of decodeBlockData(s.payload).txHashes) index.set(hex(h), s.number);
        }
      }
      this.txIndex = index;
    }
    const n = this.txIndex.get(txHash.replace(/^0x/, "").toLowerCase());
    return n !== undefined && n <= pin.number ? { stale: false, number: n } : null;
  }
}
