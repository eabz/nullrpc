//! Request bounds and errors (ported from exe-trace `lib`).

use std::cell::RefCell;

/// Failures, mapped to JSON-RPC errors by `api`.
#[derive(Debug)]
pub enum Error {
    /// Malformed or unsupported parameters (`-32602`).
    InvalidParams(String),
    /// A call or transaction is invalid at this state (`-32000` with Geth's message).
    Rejected(String),
    /// A service limit was reached (`-32005`).
    Limit(String),
    /// Execution could not be done: unreadable inputs, an unsupported fork, a replayed block
    /// transaction that did not execute (`-32000`).
    Unavailable(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidParams(m) | Self::Rejected(m) | Self::Limit(m) | Self::Unavailable(m) => {
                f.write_str(m)
            }
        }
    }
}

impl Error {
    pub fn unavailable(message: impl std::fmt::Display) -> Self {
        Self::Unavailable(message.to_string())
    }
}

/// Request-wide counters checked against [`Limits`].
#[derive(Debug, Default)]
pub struct Usage {
    pub rounds: usize,
    pub steps: u64,
    pub struct_logs: u64,
    pub struct_log_bytes: u64,
    pub executions: usize,
    pub reads: usize,
    pub gas: u64,
    pub executed_gas: u64,
}

/// Bounds of one request (every replay and call it makes shares them).
#[derive(Debug)]
pub struct Limits {
    /// Keys read from the state source (accounts, slots, code, block hashes), not counting
    /// the witness.
    pub max_state_reads: usize,
    /// Rounds of dependent reads.
    pub max_rounds: usize,
    /// Gas of the block transactions replayed.
    pub max_gas: u64,
    /// Gas of every execution, including discarded and exploring rounds (the CPU budget).
    pub max_executed_gas: u64,
    /// Gas of exploring executions per round.
    pub explore_gas: u64,
    /// Opcodes executed under a tracer.
    pub max_steps: u64,
    /// Struct log entries of the default tracer, and their JSON size (estimated).
    pub max_struct_logs: u64,
    pub max_struct_log_bytes: u64,
    /// Bytes a tracer may copy (call inputs, outputs, memory snapshots).
    pub max_recorded_bytes: usize,
    pub used: RefCell<Usage>,
}

impl Limits {
    pub const CALL_STATE_READS: usize = 1024;
    pub const TRACE_STATE_READS: usize = 4096;
    pub const DEFAULT_ROUNDS: usize = 256;
    pub const DEFAULT_GAS: u64 = 250_000_000;
    /// The CPU budget: a Worker's clock does not move during synchronous code, so gas is what
    /// bounds a request's execution time. About 300M gas per CPU second under a tracer, so a
    /// few seconds; the heaviest call measured (153 dependent rounds) executed 240M.
    pub const DEFAULT_EXECUTED_GAS: u64 = 500_000_000;
    pub const DEFAULT_EXPLORE_GAS: u64 = 30_000_000;
    pub const DEFAULT_STEPS: u64 = 25_000_000;
    pub const DEFAULT_STRUCT_LOGS: u64 = 50_000;
    pub const DEFAULT_STRUCT_LOG_BYTES: u64 = 8 * 1024 * 1024;
    pub const DEFAULT_RECORDED_BYTES: usize = 16 * 1024 * 1024;

    pub fn traces() -> Self {
        Self {
            max_state_reads: Self::TRACE_STATE_READS,
            max_rounds: Self::DEFAULT_ROUNDS,
            max_gas: Self::DEFAULT_GAS,
            max_executed_gas: Self::DEFAULT_EXECUTED_GAS,
            explore_gas: Self::DEFAULT_EXPLORE_GAS,
            max_steps: Self::DEFAULT_STEPS,
            max_struct_logs: Self::DEFAULT_STRUCT_LOGS,
            max_struct_log_bytes: Self::DEFAULT_STRUCT_LOG_BYTES,
            max_recorded_bytes: Self::DEFAULT_RECORDED_BYTES,
            used: Default::default(),
        }
    }

    pub fn calls() -> Self {
        Self {
            max_state_reads: Self::CALL_STATE_READS,
            ..Self::traces()
        }
    }

    /// Count a round of reads of `keys` keys.
    pub fn charge_round(&self, keys: usize) -> Result<(), Error> {
        let mut used = self.used.borrow_mut();
        used.rounds += 1;
        used.reads += keys;
        if used.reads > self.max_state_reads {
            return Err(Error::Limit(format!(
                "execution exceeds {} state reads",
                self.max_state_reads
            )));
        }
        if used.rounds > self.max_rounds {
            return Err(Error::Limit(format!(
                "execution needs more than {} dependent state read rounds",
                self.max_rounds
            )));
        }
        Ok(())
    }

    pub fn charge_gas(&self, gas: u64) -> Result<(), Error> {
        let mut used = self.used.borrow_mut();
        used.gas = used.gas.saturating_add(gas);
        if used.gas > self.max_gas {
            return Err(Error::Limit(format!(
                "trace exceeds {} gas of replayed transactions and calls",
                self.max_gas
            )));
        }
        Ok(())
    }

    /// Count gas executed (including discarded runs).
    pub fn charge_executed(&self, gas: u64) -> Result<(), Error> {
        let executed = {
            let mut used = self.used.borrow_mut();
            used.executions += 1;
            used.executed_gas = used.executed_gas.saturating_add(gas);
            used.executed_gas
        };
        if executed > self.max_executed_gas {
            return Err(Error::Limit(format!(
                "execution exceeds its budget ({} gas executed, including re-executions)",
                self.max_executed_gas
            )));
        }
        Ok(())
    }

    pub fn usage(&self) -> String {
        let used = self.used.borrow();
        format!(
            "rounds={};reads={};executions={};executed_gas={};steps={}",
            used.rounds, used.reads, used.executions, used.executed_gas, used.steps
        )
    }
}
