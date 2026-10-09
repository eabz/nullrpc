// StateShard (docs/storage.md, "StateShard"): the state diffs of the live window for the keys
// routed to this shard. One row per group of blocks that touches the shard; the daemon is the
// only writer.

import { DurableObject } from "cloudflare:workers";
import { decodeEntries, decodeSections, DOMAIN, encodeSections, hex, join, split, type BlockId, type Section } from "./codec";
import type { Env } from "./env";

/** How long fenced (reorged-away) hashes are remembered. */
const ORPHAN_TTL_MS = 3600_000;

interface Version {
  block: number;
  value: Uint8Array | null; // null: a wipe
}

export interface GroupRow {
  first: number;
  last: number;
  data: Uint8Array;
}

export interface PinnedValue {
  /** The block of the value, or null when the shard has no entry for the key. */
  block: number | null;
  value: string | null;
}
export type PinnedResult = { stale: true } | ({ stale: false } & PinnedValue);
export type PinnedManyResult = { stale: true } | { stale: false; values: PinnedValue[] };

/** In-memory maps of the shard's blocks, mirroring the rows table. */
interface Index {
  /** domain:keyHex -> versions ascending by block. */
  keys: Map<string, Version[]>;
  /** block number -> hash of every block with a section here. */
  hashes: Map<number, string>;
  /** block number -> the keys its section changes. */
  blockKeys: Map<number, string[]>;
  /** row first -> the row's last and its blocks. */
  rows: Map<number, { last: number; numbers: number[] }>;
}

export class StateShard extends DurableObject<Env> {
  private sql: SqlStorage;
  /** Built from the rows on first use after a wake, then kept up to date by every write. */
  private idx: Index | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS rows (
      first INTEGER, part INTEGER, last INTEGER, data BLOB, PRIMARY KEY (first, part))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS orphans (hash TEXT PRIMARY KEY, number INTEGER, at INTEGER)`);
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

  private load(): Index {
    if (this.idx) return this.idx;
    const idx: Index = { keys: new Map(), hashes: new Map(), blockKeys: new Map(), rows: new Map() };
    for (const row of this.readRows()) addRow(idx, row.first, row.last, decodeSections(row.first, row.data));
    this.idx = idx;
    return idx;
  }

  private writeRow(first: number, last: number, data: Uint8Array): void {
    this.sql.exec("DELETE FROM rows WHERE first = ?", first);
    split(data).forEach((part, i) => {
      this.sql.exec("INSERT INTO rows (first, part, last, data) VALUES (?, ?, ?, ?)", first, i, last, part);
    });
  }

  /** Writes rows in one transaction. Rewriting a group replaces it. */
  async applyMany(rows: GroupRow[]): Promise<void> {
    const decoded = rows.map((r) => decodeSections(r.first, r.data));
    this.ctx.storage.transactionSync(() => {
      for (const r of rows) this.writeRow(r.first, r.last, r.data);
    });
    if (this.idx) {
      rows.forEach((r, i) => {
        dropRow(this.idx!, r.first);
        addRow(this.idx!, r.first, r.last, decoded[i]!);
      });
    }
  }

  /** Records the hashes of blocks a reorg removes, before any of their rows change. */
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

  /** After a promotion: groups at or below `number` are in R2 now. */
  async pruneAtOrBelow(number: number): Promise<void> {
    this.sql.exec("DELETE FROM rows WHERE last <= ?", number);
    const idx = this.idx;
    if (idx) for (const [first, row] of idx.rows) if (row.last <= number) dropRow(idx, first);
  }

  private stale(idx: Index, pin: BlockId): boolean {
    if (this.sql.exec("SELECT 1 FROM orphans WHERE hash = ?", pin.hash).toArray().length > 0) return true;
    const at = idx.hashes.get(pin.number);
    return at !== undefined && at !== pin.hash;
  }

  /**
   * The newest value of a key at or below min(n, pin.number), or block null when the shard has
   * no section with it (the key is unchanged since the last promoted block). Values are hex
   * without 0x; an empty value means no account or a zero slot.
   */
  async getPinned(domain: number, keyHex: string, n: number, pin: BlockId): Promise<PinnedResult> {
    const idx = this.load();
    if (this.stale(idx, pin)) return { stale: true };
    return { stale: false, ...this.lookup(idx, domain, keyHex, Math.min(n, pin.number)) };
  }

  /**
   * getPinned for many keys in one call: the whole batch is stale when the pin is (every key
   * is read against the same index, so one answer covers all of them), else one value per
   * key, in order.
   */
  async getPinnedMany(keys: { domain: number; key: string }[], n: number, pin: BlockId): Promise<PinnedManyResult> {
    const idx = this.load();
    if (this.stale(idx, pin)) return { stale: true };
    const cap = Math.min(n, pin.number);
    return { stale: false, values: keys.map((k) => this.lookup(idx, k.domain, k.key, cap)) };
  }

  private lookup(idx: Index, domain: number, keyHex: string, cap: number): PinnedValue {
    const newest = (vs: Version[] | undefined) => {
      let best: Version | null = null;
      for (const v of vs ?? []) if (v.block <= cap && (!best || v.block >= best.block)) best = v;
      return best;
    };
    const found = newest(idx.keys.get(`${domain}:${keyHex}`));
    if (domain === DOMAIN.storage) {
      const wipe = newest(idx.keys.get(`${DOMAIN.wipe}:${keyHex.slice(0, 40)}`));
      if (wipe && (!found || wipe.block > found.block)) return { block: wipe.block, value: "" };
    }
    if (!found) return { block: null, value: null };
    return { block: found.block, value: found.value ? hex(found.value) : "" };
  }

  /** Storage slots of an account changed in the window at or below min(n, pin.number), with their newest values. */
  async scanPinned(addressHex: string, n: number, pin: BlockId): Promise<{ stale: true } | { stale: false; slots: Record<string, string> }> {
    const idx = this.load();
    if (this.stale(idx, pin)) return { stale: true };
    const cap = Math.min(n, pin.number);
    const slots: Record<string, string> = {};
    const prefix = `${DOMAIN.storage}:${addressHex}`;
    for (const [id, vs] of idx.keys) {
      if (!id.startsWith(prefix)) continue;
      let best: Version | null = null;
      for (const v of vs) if (v.block <= cap && (!best || v.block >= best.block)) best = v;
      if (best) slots[id.slice(prefix.length)] = best.value ? hex(best.value) : "";
    }
    return { stale: false, slots };
  }
}

function addRow(idx: Index, first: number, last: number, sections: Section[]): void {
  const numbers: number[] = [];
  for (const sec of sections) {
    const ids: string[] = [];
    numbers.push(sec.number);
    idx.hashes.set(sec.number, sec.hash);
    for (const e of decodeEntries(sec.payload)) {
      const id = `${e.domain}:${hex(e.key)}`;
      let vs = idx.keys.get(id);
      if (!vs) idx.keys.set(id, (vs = []));
      vs.push({ block: sec.number, value: e.value });
      // Rows usually arrive in block order; a rewritten older group needs a re-sort.
      if (vs.length > 1 && vs[vs.length - 2]!.block > sec.number) vs.sort((a, b) => a.block - b.block);
      ids.push(id);
    }
    idx.blockKeys.set(sec.number, ids);
  }
  idx.rows.set(first, { last, numbers });
}

function dropBlock(idx: Index, n: number): void {
  for (const id of new Set(idx.blockKeys.get(n))) {
    const vs = idx.keys.get(id)?.filter((v) => v.block !== n) ?? [];
    if (vs.length > 0) idx.keys.set(id, vs);
    else idx.keys.delete(id);
  }
  idx.blockKeys.delete(n);
  idx.hashes.delete(n);
}

function dropRow(idx: Index, first: number): void {
  for (const n of idx.rows.get(first)?.numbers ?? []) dropBlock(idx, n);
  idx.rows.delete(first);
}
