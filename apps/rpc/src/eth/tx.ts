// JSON-RPC transaction objects for every Ethereum transaction type (legacy, 0x01 access list,
// 0x02 dynamic fee, 0x03 blob, 0x04 set code). Senders come from the archive, never from
// signature recovery.

import type { RawTx } from "./block";
import { data, quantity, quantityBytes, toBigInt } from "./hex";
import { bytes, list, type Rlp } from "./rlp";

export interface TxContext {
  blockHash: Uint8Array;
  blockNumber: number;
  blockTimestamp: number;
  index: number;
  from: Uint8Array;
  baseFee: bigint | null;
}

function accessList(item: Rlp | undefined) {
  return list(item).map((entry) => {
    const [address, keys] = list(entry);
    return { address: data(bytes(address)), storageKeys: list(keys).map((k) => data(bytes(k))) };
  });
}

function authorizationList(item: Rlp | undefined) {
  return list(item).map((entry) => {
    const [chainId, address, nonce, yParity, r, s] = list(entry);
    return {
      chainId: quantityBytes(bytes(chainId)),
      address: data(bytes(address)),
      nonce: quantityBytes(bytes(nonce)),
      yParity: quantityBytes(bytes(yParity)),
      r: quantityBytes(bytes(r)),
      s: quantityBytes(bytes(s)),
    };
  });
}

function to(item: Rlp | undefined): string | null {
  const v = bytes(item);
  return v.length ? data(v) : null;
}

/** The price per gas the transaction paid (the receipt's effectiveGasPrice). */
export function effectiveGasPrice(tx: RawTx, baseFee: bigint | null): bigint {
  if (tx.type === 0) return toBigInt(bytes(tx.fields[1]));
  if (tx.type === 1) return toBigInt(bytes(tx.fields[2]));
  const tip = toBigInt(bytes(tx.fields[2]));
  const max = toBigInt(bytes(tx.fields[3]));
  if (baseFee === null) return max;
  return baseFee + tip < max ? baseFee + tip : max;
}

/** The recipient (null for contract creation). */
export function recipient(tx: RawTx): Uint8Array | null {
  const v = bytes(tx.fields[tx.type === 0 ? 3 : tx.type === 1 ? 4 : 5]);
  return v.length ? v : null;
}

/** The sender's nonce, for contract addresses. */
export function nonce(tx: RawTx): bigint {
  return toBigInt(bytes(tx.fields[tx.type === 0 ? 0 : 1]));
}

/** The number of blobs (type 0x03 only). */
export function blobCount(tx: RawTx): number {
  return tx.type === 3 ? list(tx.fields[10]).length : 0;
}

export function txJson(tx: RawTx, ctx: TxContext): Record<string, unknown> {
  const f = tx.fields;
  const out: Record<string, unknown> = {
    blockHash: data(ctx.blockHash),
    blockNumber: quantity(ctx.blockNumber),
    blockTimestamp: quantity(ctx.blockTimestamp),
    from: data(ctx.from),
    hash: data(tx.hash),
    transactionIndex: quantity(ctx.index),
    type: quantity(tx.type),
  };
  if (tx.type === 0) {
    const v = toBigInt(bytes(f[6]));
    Object.assign(out, {
      nonce: quantityBytes(bytes(f[0])),
      gasPrice: quantityBytes(bytes(f[1])),
      gas: quantityBytes(bytes(f[2])),
      to: to(f[3]),
      value: quantityBytes(bytes(f[4])),
      input: data(bytes(f[5])),
      v: quantity(v),
      r: quantityBytes(bytes(f[7])),
      s: quantityBytes(bytes(f[8])),
    });
    // EIP-155: v = chainId * 2 + 35 + yParity.
    if (v >= 35n) out.chainId = quantity((v - 35n) / 2n);
    return out;
  }
  const n = f.length;
  const yParity = quantityBytes(bytes(f[n - 3]));
  Object.assign(out, {
    chainId: quantityBytes(bytes(f[0])),
    nonce: quantityBytes(bytes(f[1])),
    v: yParity,
    yParity,
    r: quantityBytes(bytes(f[n - 2])),
    s: quantityBytes(bytes(f[n - 1])),
  });
  if (tx.type === 1) {
    Object.assign(out, {
      gasPrice: quantityBytes(bytes(f[2])),
      gas: quantityBytes(bytes(f[3])),
      to: to(f[4]),
      value: quantityBytes(bytes(f[5])),
      input: data(bytes(f[6])),
      accessList: accessList(f[7]),
    });
    return out;
  }
  Object.assign(out, {
    maxPriorityFeePerGas: quantityBytes(bytes(f[2])),
    maxFeePerGas: quantityBytes(bytes(f[3])),
    gasPrice: quantity(effectiveGasPrice(tx, ctx.baseFee)),
    gas: quantityBytes(bytes(f[4])),
    to: to(f[5]),
    value: quantityBytes(bytes(f[6])),
    input: data(bytes(f[7])),
    accessList: accessList(f[8]),
  });
  if (tx.type === 3) {
    out.maxFeePerBlobGas = quantityBytes(bytes(f[9]));
    out.blobVersionedHashes = list(f[10]).map((h) => data(bytes(h)));
  }
  if (tx.type === 4) out.authorizationList = authorizationList(f[9]);
  return out;
}
