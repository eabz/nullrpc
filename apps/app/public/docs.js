// nullrpc method reference for the account page's Docs tab. One entry per method
// the RPC Worker serves (credits in
// src/credits.json, which the app test keeps in sync with this list).
// Examples use Ethereum mainnet values (USDC, the first ETH transfer); on another network the
// same calls work but may return null or zero for these addresses and hashes.
"use strict";
(function () {
  var ADDR = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
  var USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  var TX = "0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060";
  var BLOCK_HASH = "0x4e3a3754410177e6937ef1f84bba68ea139e8d1a2258c5f85db9f1cd715a1bdd";
  var BLOCK = "0x1312d00"; // 20,000,000
  var BALANCE_OF = "0x70a08231000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045";
  var TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  var CALL = { to: USDC, data: BALANCE_OF };

  var TAG = { name: "block", type: "string", desc: "Block number (hex) or tag: latest, finalized, earliest. pending means latest (no mempool)." };
  var HASH_FULL = { name: "full", type: "boolean", desc: "true returns full transaction objects, false only their hashes." };
  var TRACER = { name: "options", type: "object", desc: "Tracer config, e.g. {\"tracer\":\"callTracer\"}. Supported: structLogger (default), callTracer, prestateTracer, 4byteTracer, noopTracer, flatCallTracer, muxTracer." };
  var TYPES = { name: "traceTypes", type: "string[]", desc: "Any of trace, stateDiff, vmTrace." };

  var GROUPS = [
    "Chain and node",
    "Blocks",
    "Transactions and receipts",
    "Accounts and state",
    "Execution and gas",
    "Logs",
    "Raw data",
    "Debug tracing",
    "Trace API"
  ];

  var M = [
    // ---- Chain and node
    { name: "eth_chainId", group: 0, summary: "The chain ID of the network, e.g. 0x1 for Ethereum mainnet. Use it to make sure you are on the right network.", params: [], returns: "Chain ID as a hex string.", example: [] },
    { name: "eth_blockNumber", group: 0, summary: "The number of the newest block the endpoint serves.", params: [], returns: "Block number as a hex string.", example: [] },
    { name: "net_version", group: 0, summary: "The network ID as a decimal string (\"1\" on mainnet).", params: [], returns: "Network ID string.", example: [] },
    { name: "eth_syncing", group: 0, summary: "Whether the node is syncing. Always false: the endpoint only serves verified data.", params: [], returns: "false", example: [] },
    { name: "net_listening", group: 0, summary: "Whether the node listens for network connections. Always true.", params: [], returns: "true", example: [] },
    { name: "net_peerCount", group: 0, summary: "Number of connected peers. Always 0x0: the endpoint has no peer-to-peer connections of its own.", params: [], returns: "\"0x0\"", example: [] },
    { name: "eth_accounts", group: 0, summary: "Accounts held by the node. Always empty: the endpoint holds no keys, so sign transactions in your wallet or app.", params: [], returns: "[]", example: [] },
    { name: "web3_clientVersion", group: 0, summary: "The name and version of the server software.", params: [], returns: "Version string.", example: [] },
    { name: "web3_sha3", group: 0, summary: "Keccak-256 hash of the given data.", params: [{ name: "data", type: "hex", desc: "Bytes to hash." }], returns: "32-byte hash.", example: ["0x68656c6c6f20776f726c64"] },
    { name: "rpc_modules", group: 0, summary: "The JSON-RPC namespaces this endpoint registers (eth, net, web3, debug, trace, nullrpc).", params: [], returns: "Object of namespace to version.", example: [] },
    { name: "nullrpc_getCapabilities", group: 0, summary: "Everything this endpoint supports: every method with its data requirements, archive coverage, limits and how block tags resolve. Start here when exploring.", params: [], returns: "Capabilities object.", example: [] },

    // ---- Blocks
    { name: "eth_getBlockByNumber", group: 1, summary: "A block by number or tag, with its header and transactions.", params: [TAG, HASH_FULL], returns: "Block object, or null if the block does not exist.", example: ["latest", false] },
    { name: "eth_getBlockByHash", group: 1, summary: "A block by its hash.", params: [{ name: "hash", type: "hash", desc: "Block hash." }, HASH_FULL], returns: "Block object or null.", example: [BLOCK_HASH, false] },
    { name: "eth_getBlockTransactionCountByNumber", group: 1, summary: "How many transactions a block has, by number or tag.", params: [TAG], returns: "Count as hex.", example: ["latest"] },
    { name: "eth_getBlockTransactionCountByHash", group: 1, summary: "How many transactions a block has, by block hash.", params: [{ name: "hash", type: "hash", desc: "Block hash." }], returns: "Count as hex, or null.", example: [BLOCK_HASH] },
    { name: "eth_getUncleCountByBlockNumber", group: 1, summary: "How many uncle blocks a block references. Always 0 after the Merge.", params: [TAG], returns: "Count as hex.", example: ["latest"] },
    { name: "eth_getUncleCountByBlockHash", group: 1, summary: "How many uncle blocks a block references, by block hash.", params: [{ name: "hash", type: "hash", desc: "Block hash." }], returns: "Count as hex, or null.", example: [BLOCK_HASH] },
    { name: "eth_getUncleByBlockNumberAndIndex", group: 1, summary: "An uncle header by block number and position. Proof-of-stake blocks have none and return null.", params: [TAG, { name: "index", type: "hex", desc: "Uncle position." }], returns: "Header object or null.", example: ["0xb443", "0x0"] },
    { name: "eth_getUncleByBlockHashAndIndex", group: 1, summary: "An uncle header by block hash and position.", params: [{ name: "hash", type: "hash", desc: "Block hash." }, { name: "index", type: "hex", desc: "Uncle position." }], returns: "Header object or null.", example: [BLOCK_HASH, "0x0"] },

    // ---- Transactions and receipts
    { name: "eth_getTransactionByHash", group: 2, summary: "A transaction by its hash.", params: [{ name: "hash", type: "hash", desc: "Transaction hash." }], returns: "Transaction object or null.", example: [TX] },
    { name: "eth_getTransactionByBlockNumberAndIndex", group: 2, summary: "A transaction by block number and its position in the block.", params: [TAG, { name: "index", type: "hex", desc: "Position in the block." }], returns: "Transaction object or null.", example: ["0xb443", "0x0"] },
    { name: "eth_getTransactionByBlockHashAndIndex", group: 2, summary: "A transaction by block hash and its position in the block.", params: [{ name: "hash", type: "hash", desc: "Block hash." }, { name: "index", type: "hex", desc: "Position in the block." }], returns: "Transaction object or null.", example: [BLOCK_HASH, "0x0"] },
    { name: "eth_getTransactionReceipt", group: 2, summary: "The receipt of a mined transaction: status, gas used, logs and contract address.", params: [{ name: "hash", type: "hash", desc: "Transaction hash." }], returns: "Receipt object or null.", example: [TX] },
    { name: "eth_getBlockReceipts", group: 2, summary: "All receipts of a block in one call. Cheaper than one eth_getTransactionReceipt per transaction.", params: [TAG], returns: "Array of receipts, or null.", example: [BLOCK] },
    { name: "eth_sendRawTransaction", group: 2, summary: "Broadcasts a transaction you already signed in your wallet or app. It is relayed to a private transaction relay; the endpoint never sees your keys.", params: [{ name: "data", type: "hex", desc: "The signed, RLP-encoded transaction." }], returns: "Transaction hash.", notes: "Available where a relay is configured for the network; otherwise the call returns an error saying relaying is not configured.", example: ["0xSIGNED_TRANSACTION"] },

    // ---- Accounts and state
    { name: "eth_getBalance", group: 3, summary: "The ETH balance of an address at any block, including the full history.", params: [{ name: "address", type: "address", desc: "Account address." }, TAG], returns: "Balance in wei, as hex.", example: [ADDR, "latest"] },
    { name: "eth_getTransactionCount", group: 3, summary: "The nonce of an address: how many transactions it has sent, at any block.", params: [{ name: "address", type: "address", desc: "Account address." }, TAG], returns: "Nonce as hex.", example: [ADDR, "latest"] },
    { name: "eth_getCode", group: 3, summary: "The bytecode of a contract at any block. Empty for regular accounts.", params: [{ name: "address", type: "address", desc: "Contract address." }, TAG], returns: "Bytecode as hex.", example: [USDC, "latest"] },
    { name: "eth_getStorageAt", group: 3, summary: "The value of one storage slot of a contract at any block.", params: [{ name: "address", type: "address", desc: "Contract address." }, { name: "slot", type: "hex", desc: "Storage slot." }, TAG], returns: "32-byte value as hex.", example: [USDC, "0x0", "latest"] },
    { name: "debug_codeByHash", group: 3, summary: "Contract bytecode by its code hash (the codeHash of an account). The example is the hash of empty code.", params: [{ name: "codeHash", type: "hash", desc: "Keccak-256 hash of the bytecode." }], returns: "Bytecode as hex.", example: ["0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"] },

    // ---- Execution and gas
    { name: "eth_call", group: 4, summary: "Runs a read-only contract call at any block without sending a transaction, for example a token balance.", params: [{ name: "call", type: "object", desc: "{to, data, from?, value?, gas?}." }, TAG], returns: "The call's return data as hex. Reverts return error code 3 with the revert data.", notes: "Calls are capped at 5M gas.", example: [CALL, "latest"] },
    { name: "eth_estimateGas", group: 4, summary: "How much gas a transaction would use if sent now.", params: [{ name: "tx", type: "object", desc: "{from?, to, data?, value?}." }, TAG], returns: "Gas as hex.", example: [{ from: ADDR, to: USDC, data: BALANCE_OF }, "latest"] },
    { name: "eth_gasPrice", group: 4, summary: "A suggested gas price for a legacy transaction, based on recent blocks.", params: [], returns: "Price in wei, as hex.", example: [] },
    { name: "eth_maxPriorityFeePerGas", group: 4, summary: "A suggested priority fee (tip) for an EIP-1559 transaction.", params: [], returns: "Fee in wei, as hex.", example: [] },
    { name: "eth_feeHistory", group: 4, summary: "Base fees and reward percentiles over recent blocks, for building your own fee estimate.", params: [{ name: "blockCount", type: "hex", desc: "Number of blocks (up to 256)." }, TAG, { name: "percentiles", type: "number[]", desc: "Reward percentiles, e.g. [25, 75] (up to 100)." }], returns: "{oldestBlock, baseFeePerGas, gasUsedRatio, reward}.", example: ["0x5", "latest", [25, 75]] },
    { name: "debug_chainConfig", group: 4, summary: "The chain configuration: chain ID and fork activation blocks and times.", params: [], returns: "Chain config object.", example: [] },

    // ---- Logs
    { name: "eth_getLogs", group: 5, summary: "Event logs matching a filter: contract address(es) and topics over a block range. Use it to read token transfers and other contract events.", params: [{ name: "filter", type: "object", desc: "{address?, topics?, fromBlock?, toBlock?} or {blockHash}. address can be a list (any of); topics match by position, null is a wildcard." }], returns: "Array of log objects.", notes: "Ranges up to 10,000 blocks and 10,000 logs per call. Priced by range: 50 credits up to 1,000 blocks, then +5 per further 1,000.", example: [{ address: USDC, topics: [TRANSFER], fromBlock: BLOCK, toBlock: "0x1312d0a" }] },

    // ---- Raw data
    { name: "debug_getRawBlock", group: 6, summary: "A whole block, RLP-encoded, as stored on chain.", params: [TAG], returns: "RLP bytes as hex.", example: ["latest"] },
    { name: "debug_getRawHeader", group: 6, summary: "A block header, RLP-encoded.", params: [TAG], returns: "RLP bytes as hex.", example: ["latest"] },
    { name: "debug_getRawTransactions", group: 6, summary: "All transactions of a block in their signed binary form.", params: [TAG], returns: "Array of hex strings.", example: [BLOCK] },
    { name: "debug_getRawTransaction", group: 6, summary: "One transaction in its signed binary form, by hash.", params: [{ name: "hash", type: "hash", desc: "Transaction hash." }], returns: "Hex bytes.", example: [TX] },
    { name: "debug_getRawReceipts", group: 6, summary: "All receipts of a block, consensus-encoded.", params: [TAG], returns: "Array of hex strings.", example: [BLOCK] },
    { name: "eth_getRawTransactionByHash", group: 6, summary: "A transaction in its signed binary form, by hash.", params: [{ name: "hash", type: "hash", desc: "Transaction hash." }], returns: "Hex bytes or null.", example: [TX] },
    { name: "eth_getRawTransactionByBlockNumberAndIndex", group: 6, summary: "A transaction's signed binary form by block number and position.", params: [TAG, { name: "index", type: "hex", desc: "Position in the block." }], returns: "Hex bytes or null.", example: ["0xb443", "0x0"] },
    { name: "eth_getRawTransactionByBlockHashAndIndex", group: 6, summary: "A transaction's signed binary form by block hash and position.", params: [{ name: "hash", type: "hash", desc: "Block hash." }, { name: "index", type: "hex", desc: "Position in the block." }], returns: "Hex bytes or null.", example: [BLOCK_HASH, "0x0"] },

    // ---- Debug tracing (Geth style)
    { name: "debug_traceTransaction", group: 7, summary: "Replays a mined transaction and shows what happened inside it: internal calls, state changes or every opcode, depending on the tracer.", params: [{ name: "hash", type: "hash", desc: "Transaction hash." }, TRACER], returns: "Trace in the chosen tracer's format.", example: [TX, { tracer: "callTracer" }] },
    { name: "debug_traceCall", group: 7, summary: "Traces a call at a block without sending it, like eth_call with a full trace.", params: [{ name: "call", type: "object", desc: "{to, data, from?, value?, gas?}." }, TAG, TRACER], returns: "Trace in the chosen tracer's format.", example: [CALL, "latest", { tracer: "callTracer" }] },
    { name: "debug_traceBlockByNumber", group: 7, summary: "Traces every transaction in a block, by number or tag.", params: [TAG, TRACER], returns: "Array of {txHash, result}.", example: [BLOCK, { tracer: "callTracer" }] },
    { name: "debug_traceBlockByHash", group: 7, summary: "Traces every transaction in a block, by block hash.", params: [{ name: "hash", type: "hash", desc: "Block hash." }, TRACER], returns: "Array of {txHash, result}.", example: [BLOCK_HASH, { tracer: "callTracer" }] },
    { name: "debug_traceBlock", group: 7, summary: "Traces every transaction in a block you pass as RLP.", params: [{ name: "block", type: "hex", desc: "RLP-encoded block (from debug_getRawBlock)." }, TRACER], returns: "Array of {txHash, result}.", example: ["0xRLP_ENCODED_BLOCK", { tracer: "callTracer" }] },

    // ---- Trace API (Parity / OpenEthereum style)
    { name: "trace_transaction", group: 8, summary: "All internal calls (traces) of a mined transaction, as a flat list.", params: [{ name: "hash", type: "hash", desc: "Transaction hash." }], returns: "Array of trace objects.", example: [TX] },
    { name: "trace_block", group: 8, summary: "All traces of every transaction in a block.", params: [TAG], returns: "Array of trace objects.", example: [BLOCK] },
    { name: "trace_get", group: 8, summary: "One trace of a transaction by its position in the call tree.", params: [{ name: "hash", type: "hash", desc: "Transaction hash." }, { name: "path", type: "hex[]", desc: "Trace address, e.g. [\"0x0\"]." }], returns: "Trace object or null.", example: [TX, ["0x0"]] },
    { name: "trace_filter", group: 8, summary: "Traces matching a filter over a block range: calls from or to given addresses.", params: [{ name: "filter", type: "object", desc: "{fromBlock?, toBlock?, fromAddress?, toAddress?, after?, count?}." }], returns: "Array of trace objects.", notes: "Ranges up to 10,000 blocks and 10,000 traces per call.", example: [{ fromBlock: BLOCK, toBlock: "0x1312d02", toAddress: [USDC] }] },
    { name: "trace_call", group: 8, summary: "Traces a call at a block without sending it.", params: [{ name: "call", type: "object", desc: "{to, data, from?, value?, gas?}." }, TYPES, TAG], returns: "{output, trace, stateDiff, vmTrace} for the requested types.", example: [CALL, ["trace"], "latest"] },
    { name: "trace_callMany", group: 8, summary: "Traces several calls in sequence at one block, each seeing the previous calls' effects.", params: [{ name: "calls", type: "array", desc: "List of [call, traceTypes] pairs." }, TAG], returns: "Array of results, one per call.", example: [[[CALL, ["trace"]], [CALL, ["trace"]]], "latest"] },
    { name: "trace_rawTransaction", group: 8, summary: "Traces a signed transaction without broadcasting it.", params: [{ name: "data", type: "hex", desc: "Signed, RLP-encoded transaction." }, TYPES], returns: "{output, trace, stateDiff, vmTrace}.", example: ["0xSIGNED_TRANSACTION", ["trace"]] },
    { name: "trace_replayTransaction", group: 8, summary: "Replays a mined transaction and returns the requested trace types, including state changes.", params: [{ name: "hash", type: "hash", desc: "Transaction hash." }, TYPES], returns: "{output, trace, stateDiff, vmTrace}.", example: [TX, ["trace", "stateDiff"]] },
    { name: "trace_replayBlockTransactions", group: 8, summary: "Replays every transaction in a block with the requested trace types.", params: [TAG, TYPES], returns: "Array of results, one per transaction.", example: [BLOCK, ["trace"]] }
  ];

  window.NULLRPC_DOCS = { groups: GROUPS, methods: M };
})();
