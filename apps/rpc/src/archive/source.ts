// Byte access to the archive bucket. The Worker reads R2 through its binding; tests use an
// in-memory map. Only immutable objects go through `cached`, keyed by key and range.

import { ArchiveError } from "./types";

export interface Source {
  /** `length` bytes at `offset` of `key`; the object must exist and cover the range. */
  range(key: string, offset: number, length: number): Promise<Uint8Array>;
  /** The whole object, or null if it does not exist. */
  get(key: string): Promise<Uint8Array | null>;
}

export class R2Source implements Source {
  constructor(private readonly bucket: R2Bucket) {}

  async range(key: string, offset: number, length: number): Promise<Uint8Array> {
    const object = await this.bucket.get(key, { range: { offset, length } });
    if (!object) throw new ArchiveError(`missing object ${key}`);
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.length !== length) throw new ArchiveError(`short read of ${key}`);
    return bytes;
  }

  async get(key: string): Promise<Uint8Array | null> {
    const object = await this.bucket.get(key);
    return object ? new Uint8Array(await object.arrayBuffer()) : null;
  }
}

export class MemorySource implements Source {
  /** Every read, for asserting how many requests a lookup makes. */
  readonly reads: { key: string; offset: number; length: number }[] = [];

  constructor(readonly objects: Map<string, Uint8Array>) {}

  async range(key: string, offset: number, length: number): Promise<Uint8Array> {
    const o = this.objects.get(key);
    if (!o || offset + length > o.length) throw new ArchiveError(`missing object ${key}`);
    this.reads.push({ key, offset, length });
    return o.slice(offset, offset + length);
  }

  async get(key: string): Promise<Uint8Array | null> {
    const o = this.objects.get(key);
    if (o) this.reads.push({ key, offset: 0, length: o.length });
    return o ? o.slice() : null;
  }
}
