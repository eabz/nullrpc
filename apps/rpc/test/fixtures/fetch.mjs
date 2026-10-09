// Fetches the mainnet blocks used as test fixtures from a public RPC and stores, per block,
// the full block and its receipts exactly as the reference node returns them (zstd JSON).
// The tests encode these into a real archive (test/archive.ts) and expect the Worker to
// reproduce the JSON. Run: node test/fixtures/fetch.mjs [rpc-url]
import { writeFileSync } from "node:fs";
import { zstdCompressSync } from "node:zlib";

const RPC = process.argv[2] ?? "https://eth.drpc.org";
// Two consecutive blocks per era: Frontier, Byzantium (4,000,014 has an uncle), Berlin,
// Cancun (blobs), Prague (EIP-7702 authorizations).
const BLOCKS = [1_000_000, 1_000_001, 4_000_014, 4_000_015, 12_250_000, 12_250_001, 20_000_000, 20_000_001, 23_000_000, 23_000_001];

async function call(method, params) {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

for (const n of BLOCKS) {
  const tag = "0x" + n.toString(16);
  const block = await call("eth_getBlockByNumber", [tag, true]);
  const receipts = await call("eth_getBlockReceipts", [tag]);
  const uncles = [];
  for (let i = 0; i < block.uncles.length; i++) uncles.push(await call("eth_getUncleByBlockNumberAndIndex", [tag, "0x" + i.toString(16)]));
  writeFileSync(new URL(`./mainnet/${n}.json.zst`, import.meta.url), zstdCompressSync(Buffer.from(JSON.stringify({ block, receipts, uncles }))));
  console.log(n, block.transactions.length, "txs", uncles.length, "uncles");
}
