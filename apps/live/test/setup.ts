// `cloudflare:workers` exists only in the Workers runtime; tests use minimal stand-ins.
import { mock } from "bun:test";

class Base {
  constructor(
    readonly ctx: unknown,
    readonly env: unknown,
  ) {}
}

mock.module("cloudflare:workers", () => ({ DurableObject: Base, WorkerEntrypoint: Base }));
