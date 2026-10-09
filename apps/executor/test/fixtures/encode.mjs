// Test-only writer of block records (docs/storage.md, "Block records") from a reference node's
// JSON, after apps/rpc/test/encode.ts; and the canonical form of a StateKey for fixture lookups.

const hexBytes = (v) => Buffer.from(v.slice(2).length % 2 ? "0" + v.slice(2) : v.slice(2), "hex");

function intBytes(n) {
  if (n === 0n) return Buffer.alloc(0);
  let s = n.toString(16);
  if (s.length % 2) s = "0" + s;
  return Buffer.from(s, "hex");
}

function length(len, offset) {
  if (len < 56) return Buffer.from([offset + len]);
  const l = intBytes(BigInt(len));
  return Buffer.concat([Buffer.from([offset + 55 + l.length]), l]);
}

export function encodeBytes(b) {
  if (b.length === 1 && b[0] < 0x80) return Buffer.from(b);
  return Buffer.concat([length(b.length, 0x80), b]);
}

export function encodeList(items) {
  const body = Buffer.concat(items);
  return Buffer.concat([length(body.length, 0xc0), body]);
}

const int = (v) => encodeBytes(intBytes(BigInt(v ?? "0x0")));
const str = (v) => encodeBytes(hexBytes(v));
const addr = (v) => encodeBytes(v ? hexBytes(v) : Buffer.alloc(0));

const HEADER = [
  ["parentHash", "data"], ["sha3Uncles", "data"], ["miner", "data"], ["stateRoot", "data"],
  ["transactionsRoot", "data"], ["receiptsRoot", "data"], ["logsBloom", "data"], ["difficulty", "int"],
  ["number", "int"], ["gasLimit", "int"], ["gasUsed", "int"], ["timestamp", "int"], ["extraData", "data"],
  ["mixHash", "data"], ["nonce", "data"], ["baseFeePerGas", "int"], ["withdrawalsRoot", "data"],
  ["blobGasUsed", "int"], ["excessBlobGas", "int"], ["parentBeaconBlockRoot", "data"], ["requestsHash", "data"],
];

function encodeHeader(h) {
  const items = [];
  for (const [key, kind] of HEADER) {
    if (h[key] === undefined) break;
    items.push(kind === "int" ? int(h[key]) : str(h[key]));
  }
  return encodeList(items);
}

const accessList = (l) => encodeList(l.map((e) => encodeList([str(e.address), encodeList(e.storageKeys.map(str))])));

function encodeTx(t) {
  const sig = [int(t.yParity ?? t.v), int(t.r), int(t.s)];
  const type = Number(t.type);
  if (type === 0) return encodeList([int(t.nonce), int(t.gasPrice), int(t.gas), addr(t.to), int(t.value), str(t.input), int(t.v), int(t.r), int(t.s)]);
  let body;
  if (type === 1) body = [int(t.chainId), int(t.nonce), int(t.gasPrice), int(t.gas), addr(t.to), int(t.value), str(t.input), accessList(t.accessList)];
  else {
    body = [int(t.chainId), int(t.nonce), int(t.maxPriorityFeePerGas), int(t.maxFeePerGas), int(t.gas), addr(t.to), int(t.value), str(t.input), accessList(t.accessList)];
    if (type === 3) body.push(int(t.maxFeePerBlobGas), encodeList(t.blobVersionedHashes.map(str)));
    if (type === 4)
      body.push(encodeList(t.authorizationList.map((a) => encodeList([int(a.chainId), str(a.address), int(a.nonce), int(a.yParity), int(a.r), int(a.s)]))));
  }
  return Buffer.concat([Buffer.from([type]), encodeList([...body, ...sig])]);
}

function encodeRawBlock(f) {
  const b = f.block;
  const txs = b.transactions.map((t) => {
    const raw = encodeTx(t);
    return Number(t.type) === 0 ? raw : encodeBytes(raw);
  });
  const items = [encodeHeader(b), encodeList(txs), encodeList(f.uncles.map(encodeHeader))];
  if (b.withdrawals) items.push(encodeList(b.withdrawals.map((w) => encodeList([int(w.index), int(w.validatorIndex), str(w.address), int(w.amount)]))));
  return encodeList(items);
}

/** The block record of `{block, receipts, uncles}` (reference node JSON), RLP hex. */
export function encodeRecord(f) {
  const senders = Buffer.concat(f.block.transactions.map((t) => hexBytes(t.from)));
  const receipts = f.receipts.map((r) => {
    const status = r.root ? str(r.root) : r.status === "0x1" ? encodeBytes(Buffer.from([1])) : encodeBytes(Buffer.alloc(0));
    const logs = encodeList(r.logs.map((l) => encodeList([str(l.address), encodeList(l.topics.map(str)), str(l.data)])));
    return encodeList([int(r.type), status, int(r.cumulativeGasUsed), logs]);
  });
  const blobGasPrice = f.receipts.find((r) => r.blobGasPrice)?.blobGasPrice ?? "0x0";
  return "0x" + encodeList([encodeBytes(encodeRawBlock(f)), encodeBytes(senders), encodeList(receipts), int(blobGasPrice), encodeList([])]).toString("hex");
}

/** A StateKey's canonical form (lowercase, numbers normalized). */
export function canonicalKey(k) {
  switch (k.kind) {
    case "account":
      return `account:${k.address.toLowerCase()}`;
    case "storage":
      return `storage:${k.address.toLowerCase()}:${BigInt(k.slot).toString(16)}`;
    case "code":
      return `code:${k.hash.toLowerCase()}`;
    case "blockHash":
      return `blockHash:${Number(k.number)}`;
  }
  throw new Error("unknown state key");
}
