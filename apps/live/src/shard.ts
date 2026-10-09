// StateShard (docs/storage.md, "StateShard"): the state diffs of the live window for the keys
// routed to this shard. One row per group of blocks that touches the shard; the daemon is the
// only writer.

import { DurableObject } from "cloudflare:workers";
import { decodeEntries, decodeSections, DOMAIN, encodeSections, hex, join, split, type BlockId } from "./codec";
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

export type PinnedResult = { stale: true } | { stale: false; block: number | null; value: string | null };

export class StateShard extends DurableObject<Env> {
  private sql: SqlStorage;
  /** domain:keyHex -> versions ascending by block; built from the rows on first use. */
  private index: Map<string, Version[]> | null = null;
  /** block number -> hash of every block with a section here. */
  private hashes = new Map<number, string>();

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

  private load(): Map<string, Version[]> {
    if (this.index) return this.index;
    const index = new Map<string, Version[]>();
    this.hashes.clear();
    for (const row of this.readRows()) {
      for (const sec of decodeSections(row.first, row.data)) {
        this.hashes.set(sec.number, sec.hash);
        for (const e of decodeEntries(sec.payload)) {
          const id = `${e.domain}:${hex(e.key)}`;
          let vs = index.get(id);
          if (!vs) index.set(id, (vs = []));
          vs.push({ block: sec.number, value: e.value });
        }
      }
    }
    this.index = index;
    return index;
  }

  private writeRow(first: number, last: number, data: Uint8Array): void {
    this.sql.exec("DELETE FROM rows WHERE first = ?", first);
    split(data).forEach((part, i) => {
      this.sql.exec("INSERT INTO rows (first, part, last, data) VALUES (?, ?, ?, ?)", first, i, last, part);
    });
  }

  /** Writes rows in one transaction. Rewriting a group replaces it. */
  async applyMany(rows: GroupRow[]): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      for (const r of rows) this.writeRow(r.first, r.last, r.data);
    });
    this.index = null;
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
    this.index = null;
  }

  /** After a promotion: groups at or below `number` are in R2 now. */
  async pruneAtOrBelow(number: number): Promise<void> {
    this.sql.exec("DELETE FROM rows WHERE last <= ?", number);
    this.index = null;
  }

  private stale(pin: BlockId): boolean {
    if (this.sql.exec("SELECT 1 FROM orphans WHERE hash = ?", pin.hash).toArray().length > 0) return true;
    const at = this.hashes.get(pin.number);
    return at !== undefined && at !== pin.hash;
  }

  /**
   * The newest value of a key at or below min(n, pin.number), or block null when the shard has
   * no section with it (the key is unchanged since the last promoted block). Values are hex
   * without 0x; an empty value means no account or a zero slot.
   */
  async getPinned(domain: number, keyHex: string, n: number, pin: BlockId): Promise<PinnedResult> {
    const index = this.load();
    if (this.stale(pin)) return { stale: true };
    const cap = Math.min(n, pin.number);
    const newest = (vs: Version[] | undefined) => {
      let best: Version | null = null;
      for (const v of vs ?? []) if (v.block <= cap && (!best || v.block >= best.block)) best = v;
      return best;
    };
    const found = newest(index.get(`${domain}:${keyHex}`));
    if (domain === DOMAIN.storage) {
      const wipe = newest(index.get(`${DOMAIN.wipe}:${keyHex.slice(0, 40)}`));
      if (wipe && (!found || wipe.block > found.block)) return { stale: false, block: wipe.block, value: "" };
    }
    if (!found) return { stale: false, block: null, value: null };
    return { stale: false, block: found.block, value: found.value ? hex(found.value) : "" };
  }

  /** Storage slots of an account changed in the window at or below min(n, pin.number), with their newest values. */
  async scanPinned(addressHex: string, n: number, pin: BlockId): Promise<{ stale: true } | { stale: false; slots: Record<string, string> }> {
    const index = this.load();
    if (this.stale(pin)) return { stale: true };
    const cap = Math.min(n, pin.number);
    const slots: Record<string, string> = {};
    const prefix = `${DOMAIN.storage}:${addressHex}`;
    for (const [id, vs] of index) {
      if (!id.startsWith(prefix)) continue;
      let best: Version | null = null;
      for (const v of vs) if (v.block <= cap && (!best || v.block >= best.block)) best = v;
      if (best) slots[id.slice(prefix.length)] = best.value ? hex(best.value) : "";
    }
    return { stale: false, slots };
  }
}
