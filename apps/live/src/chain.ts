// ChainDO (docs/storage.md, "ChainDO"): the live window's block records and witnesses, and the
// pointers (head, safe, finalized, last promoted block, current generation). One row per group
// of blocks.

import { DurableObject } from "cloudflare:workers";
import { decodeBlockData, decodeSections, encodeSections, hex, join, recordTimestamp, split, type BlockId, type Section } from "./codec";
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

/** Pipeline status for the status dashboard (GET /internal/status on the LiveStatus entrypoint). */
export interface ChainStatus {
  /** When this status was read (ms). */
  at: number;
  /** The head, with its block's timestamp (seconds; null when unknown). */
  executed_head: (BlockId & { timestamp: number | null }) | null;
  /** The network head the daemon reported (the head once the head passes it); null until it reports one. */
  target: BlockId | null;
  /** target - head, in blocks. */
  lag: number | null;
  safe: BlockId | null;
  finalized: BlockId | null;
  /** The safe block. */
  optimistic: BlockId | null;
  /** The last promoted block P: everything at or below it is in R2. */
  archived_through: BlockId | null;
  r2_tip: (BlockId & { generation: number; checked_at: number }) | null;
  /** Blocks in the live window waiting for promotion (head - P). */
  pending_blocks: number | null;
  /** When the head last moved up (ms). */
  last_progress: number | null;
  /** When the daemon last wrote blocks (ms). */
  last_ingest: number | null;
  promotion: { last: { archived_through: BlockId; generation: number; at: number } | null };
  counters: Record<string, number>;
  halted: boolean;
  /** The last ingest error of the past day. */
  last_error: { message: string; at: number } | null;
  generation: number;
  shards: number | null;
}

export interface HistoryPoint {
  /** Bucket start (seconds). */
  t: number;
  executed: number;
  /** Null while the daemon had not reported a network head. */
  target: number | null;
  lag: number | null;
  /** Blocks per second since the previous sample. */
  rate: number | null;
}

export interface History {
  bucket_s: number;
  from: number;
  to: number;
  retention_s: number;
  points: HistoryPoint[];
}

export const HISTORY_RANGES = { "1h": { span_s: 3600, bucket_s: 60 }, "24h": { span_s: 86_400, bucket_s: 300 }, "7d": { span_s: 604_800, bucket_s: 3600 } } as const;
export type HistoryRange = keyof typeof HISTORY_RANGES;
const SAMPLE_MS = 60_000;
const RETENTION_S = 7 * 86_400;
const ERROR_TTL_MS = 86_400_000;

/** In-memory maps of the window's blocks, mirroring the rows table. */
interface Index {
  byHash: Map<string, number>;
  byNumber: Map<number, string>;
  /** tx hash hex (no 0x) -> block number. */
  txs: Map<string, number>;
  blockTxs: Map<number, string[]>;
  /** block number -> block timestamp (seconds). */
  times: Map<number, number>;
  /** row first -> the row's last and its blocks. */
  rows: Map<number, { last: number; numbers: number[] }>;
}

export class ChainDO extends DurableObject<Env> {
  private sql: SqlStorage;
  /** Built from the rows on first use after a wake, then kept up to date by every write. */
  private idx: Index | null = null;
  private alarmChecked = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS rows (
      first INTEGER, part INTEGER, last INTEGER, data BLOB, PRIMARY KEY (first, part))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS orphans (hash TEXT PRIMARY KEY, number INTEGER, at INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)`);
    // One sample a minute of the head and the network head, kept 7 days.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS samples (t INTEGER PRIMARY KEY, executed INTEGER, target INTEGER)`);
    // Once: samples taken before the daemon reported a network head stored the head as the
    // target (a false lag of 0); mark them unknown.
    if (this.get<boolean>("samples_unknown_target") === null) {
      this.sql.exec("UPDATE samples SET target = NULL WHERE t < (SELECT MIN(t) FROM samples WHERE target <> executed)");
      this.set("samples_unknown_target", true);
    }
  }

  private get<T>(k: string): T | null {
    const row = this.sql.exec<{ v: string }>("SELECT v FROM kv WHERE k = ?", k).toArray()[0];
    return row ? (JSON.parse(row.v) as T) : null;
  }

  private set(k: string, v: unknown): void {
    this.sql.exec("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)", k, JSON.stringify(v));
  }

  private count(add: Record<string, number>): void {
    const counters = this.get<Record<string, number>>("counters") ?? {};
    for (const [k, n] of Object.entries(add)) counters[k] = (counters[k] ?? 0) + n;
    this.set("counters", counters);
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

  private index(): Index {
    if (this.idx) return this.idx;
    const idx: Index = { byHash: new Map(), byNumber: new Map(), txs: new Map(), blockTxs: new Map(), times: new Map(), rows: new Map() };
    for (const row of this.readRows()) addRow(idx, row.first, row.last, decodeSections(row.first, row.data));
    this.idx = idx;
    return idx;
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
    await this.ensureAlarm();
    return this.state();
  }

  async putRows(rows: GroupRow[]): Promise<void> {
    const decoded = rows.map((r) => decodeSections(r.first, r.data));
    this.ctx.storage.transactionSync(() => {
      for (const r of rows) this.writeRow(r.first, r.last, r.data);
      this.count({ ingest_batches: 1, rows_written: rows.length });
      this.set("last_ingest", Date.now());
    });
    if (this.idx) {
      rows.forEach((r, i) => {
        dropRow(this.idx!, r.first);
        addRow(this.idx!, r.first, r.last, decoded[i]!);
      });
    }
  }

  /** Moves the head; the head's block must be in the window, or be the last promoted block. */
  async setHead(head: BlockId, safe: BlockId | null, finalized: BlockId | null, networkHead: BlockId | null = null): Promise<void> {
    const promoted = this.get<BlockId>("promoted");
    const atPromoted = promoted !== null && promoted.number === head.number && promoted.hash === head.hash;
    const idx = this.index();
    if (!atPromoted && idx.byHash.get(head.hash) !== head.number) throw new Error(`no row for head ${head.number} ${head.hash}`);
    const prev = this.get<BlockId>("head");
    this.ctx.storage.transactionSync(() => {
      this.set("head", head);
      if (safe) this.set("safe", safe);
      if (finalized) this.set("finalized", finalized);
      if (networkHead) this.set("network_head", networkHead);
      if (prev?.hash !== head.hash) this.set("head_time", idx.times.get(head.number) ?? null);
      if (!prev || head.number > prev.number) {
        this.set("last_progress", Date.now());
        this.count({ blocks_advanced: prev ? head.number - prev.number : 0 });
      }
    });
    await this.ensureAlarm();
  }

  async fence(removed: BlockId[]): Promise<void> {
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      for (const b of removed) {
        this.sql.exec("INSERT OR REPLACE INTO orphans (hash, number, at) VALUES (?, ?, ?)", b.hash, b.number, now);
      }
      this.sql.exec("DELETE FROM orphans WHERE at < ?", now - ORPHAN_TTL_MS);
      this.count({ reorgs: 1, reorged_blocks: removed.length });
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
    const idx = this.idx;
    if (idx) {
      for (const [first, row] of idx.rows) {
        if (!row.numbers.some((n) => n > number)) continue;
        for (const n of row.numbers) if (n > number) dropBlock(idx, n);
        const kept = row.numbers.filter((n) => n <= number);
        if (kept.length > 0) idx.rows.set(first, { last: kept[kept.length - 1]!, numbers: kept });
        else idx.rows.delete(first);
      }
    }
  }

  /** After a promotion: groups at or below `promoted` are in R2 now. */
  async pruneAtOrBelow(promoted: BlockId, generation: number): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM rows WHERE last <= ?", promoted.number);
      this.set("promoted", promoted);
      this.set("generation", generation);
      this.set("promotion_last", { archived_through: promoted, generation, at: Date.now() });
      this.count({ prunes: 1 });
    });
    const idx = this.idx;
    if (idx) for (const [first, row] of idx.rows) if (row.last <= promoted.number) dropRow(idx, first);
  }

  /** Records an ingest error for the status page. */
  async noteError(message: string): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      this.set("last_error", { message: message.slice(0, 500), at: Date.now() });
      this.count({ ingest_errors: 1 });
    });
  }

  async status(): Promise<ChainStatus> {
    const now = Date.now();
    const st = await this.state();
    const target = this.target(st.head);
    const promotionLast = this.get<ChainStatus["promotion"]["last"]>("promotion_last");
    const lastError = this.get<{ message: string; at: number }>("last_error");
    return {
      at: now,
      executed_head: st.head ? { ...st.head, timestamp: this.get<number>("head_time") } : null,
      target,
      lag: st.head && target ? Math.max(0, target.number - st.head.number) : null,
      safe: st.safe,
      finalized: st.finalized,
      optimistic: st.safe,
      archived_through: st.promoted,
      r2_tip: st.promoted ? { ...st.promoted, generation: st.generation, checked_at: now } : null,
      pending_blocks: st.head && st.promoted ? Math.max(0, st.head.number - st.promoted.number) : null,
      last_progress: this.get<number>("last_progress"),
      last_ingest: this.get<number>("last_ingest"),
      promotion: { last: promotionLast },
      counters: this.get<Record<string, number>>("counters") ?? {},
      halted: false,
      last_error: lastError && now - lastError.at < ERROR_TTL_MS ? lastError : null,
      generation: st.generation,
      shards: st.shards,
    };
  }

  /**
   * The network head the daemon reported; the head once the head has passed it (caught up).
   * Null until the daemon reports one: the head is not evidence of being at the network head.
   */
  private target(head: BlockId | null): BlockId | null {
    const net = this.get<BlockId>("network_head");
    if (!net) return null;
    return !head || net.number >= head.number ? net : head;
  }

  /**
   * The head and network head over a range, one point per bucket (its last sample); rate is
   * blocks per second between that sample and the one before it.
   */
  async history(range: HistoryRange): Promise<History> {
    const { span_s, bucket_s } = HISTORY_RANGES[range];
    const to = Math.floor(Date.now() / 1000);
    const from = to - span_s;
    const rows = this.sql.exec<{ t: number; executed: number; target: number | null }>(
      "SELECT t, executed, target FROM samples WHERE t >= ? ORDER BY t", from - bucket_s).toArray();
    const last = new Map<number, { t: number; executed: number; target: number | null }>();
    for (const r of rows) last.set(Math.floor(r.t / bucket_s) * bucket_s, r);
    const points: HistoryPoint[] = [];
    let prev: { t: number; executed: number } | null = null;
    for (const [t, r] of last) {
      if (t >= from - (from % bucket_s)) {
        const rate = prev && r.t > prev.t ? Math.max(0, (r.executed - prev.executed) / (r.t - prev.t)) : null;
        points.push({ t, executed: r.executed, target: r.target, lag: r.target === null ? null : Math.max(0, r.target - r.executed), rate });
      }
      prev = r;
    }
    return { bucket_s, from, to, retention_s: RETENTION_S, points };
  }

  /** Starts the once-a-minute sampling alarm once the chain has a head. */
  private async ensureAlarm(): Promise<void> {
    if (this.alarmChecked) return;
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(nextMinute(Date.now()));
    this.alarmChecked = true;
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    const head = this.get<BlockId>("head");
    if (head) {
      const target = this.target(head);
      this.sql.exec("INSERT OR REPLACE INTO samples (t, executed, target) VALUES (?, ?, ?)",
        Math.floor(now / SAMPLE_MS) * (SAMPLE_MS / 1000), head.number, target ? target.number : null);
    }
    this.sql.exec("DELETE FROM samples WHERE t < ?", Math.floor(now / 1000) - RETENTION_S);
    await this.ctx.storage.setAlarm(nextMinute(now));
  }

  private stale(pin: BlockId): boolean {
    if (this.sql.exec("SELECT 1 FROM orphans WHERE hash = ?", pin.hash).toArray().length > 0) return true;
    const at = this.index().byNumber.get(pin.number);
    return at !== undefined && at !== pin.hash;
  }

  /** A block's record (hex) by number or hash, if at or below the pin. */
  async block(numberOrHash: number | string, pin: BlockId): Promise<{ stale: true } | { stale: false; number: number; hash: string; record: string } | null> {
    if (this.stale(pin)) return { stale: true };
    const number = typeof numberOrHash === "number" ? numberOrHash : this.index().byHash.get(numberOrHash.toLowerCase());
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
    const n = this.index().txs.get(txHash.replace(/^0x/, "").toLowerCase());
    return n !== undefined && n <= pin.number ? { stale: false, number: n } : null;
  }
}

const nextMinute = (now: number): number => (Math.floor(now / SAMPLE_MS) + 1) * SAMPLE_MS;

function addRow(idx: Index, first: number, last: number, sections: Section[]): void {
  const numbers: number[] = [];
  for (const s of sections) {
    const data = decodeBlockData(s.payload);
    const txs = data.txHashes.map(hex);
    numbers.push(s.number);
    idx.byHash.set(s.hash, s.number);
    idx.byNumber.set(s.number, s.hash);
    idx.blockTxs.set(s.number, txs);
    for (const h of txs) idx.txs.set(h, s.number);
    const ts = recordTimestamp(data.record);
    if (ts !== null) idx.times.set(s.number, ts);
  }
  idx.rows.set(first, { last, numbers });
}

function dropBlock(idx: Index, n: number): void {
  const hash = idx.byNumber.get(n);
  if (hash !== undefined && idx.byHash.get(hash) === n) idx.byHash.delete(hash);
  idx.byNumber.delete(n);
  for (const h of idx.blockTxs.get(n) ?? []) if (idx.txs.get(h) === n) idx.txs.delete(h);
  idx.blockTxs.delete(n);
  idx.times.delete(n);
}

function dropRow(idx: Index, first: number): void {
  for (const n of idx.rows.get(first)?.numbers ?? []) dropBlock(idx, n);
  idx.rows.delete(first);
}
