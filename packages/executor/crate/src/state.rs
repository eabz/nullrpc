//! State known to a request: values the RPC Worker answered so far (a witness, then rounds of
//! reads), and a revm database over them that records what it does not know yet.
//!
//! revm reads state synchronously and the executor never does I/O, so execution runs in rounds:
//! a value that is not known yet is answered with a placeholder (absent account, empty code,
//! zero slot or hash) and recorded as a miss. Only an execution without misses is kept, so every
//! value a kept execution observed came from the state source. (Ported from exe-trace `state`.)

use alloy_primitives::{Address, B256, KECCAK256_EMPTY, U256};
use revm::{
    DatabaseRef,
    database_interface::DBErrorMarker,
    state::{AccountInfo, Bytecode},
};
use std::{
    cell::{Cell, RefCell},
    collections::{BTreeMap, HashMap},
};

/// A key the executor needs (`StateKey` in the contract).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Miss {
    Account(Address),
    Code(B256),
    Storage(Address, U256),
    BlockHash(u64),
}

/// A database miss; never surfaces from a kept execution.
#[derive(Debug)]
pub struct MissError;
impl std::fmt::Display for MissError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("uncached state access")
    }
}
impl std::error::Error for MissError {}
impl DBErrorMarker for MissError {}

/// Values answered by the state source.
#[derive(Clone, Debug, Default)]
pub struct Known {
    pub(crate) accounts: HashMap<Address, Option<AccountInfo>>,
    pub(crate) code: HashMap<B256, Bytecode>,
    pub(crate) storage: HashMap<(Address, U256), U256>,
    pub(crate) hashes: HashMap<u64, B256>,
}

impl Known {
    pub fn has(&self, miss: &Miss) -> bool {
        match miss {
            Miss::Account(a) => self.accounts.contains_key(a),
            Miss::Code(h) => *h == KECCAK256_EMPTY || self.code.contains_key(h),
            Miss::Storage(a, s) => self.storage.contains_key(&(*a, *s)),
            Miss::BlockHash(n) => self.hashes.contains_key(n),
        }
    }

    pub fn insert_account(&mut self, address: Address, info: Option<AccountInfo>) {
        self.accounts.insert(address, info);
    }

    pub fn insert_code(&mut self, hash: B256, code: Bytecode) {
        self.code.insert(hash, code);
    }

    pub fn insert_storage(&mut self, address: Address, slot: U256, value: U256) {
        self.storage.insert((address, slot), value);
    }

    pub fn insert_hash(&mut self, number: u64, hash: B256) {
        self.hashes.insert(number, hash);
    }

    /// Code hashes of known accounts whose code is not known yet.
    pub fn missing_code(&self) -> Vec<B256> {
        let mut hashes: Vec<B256> = self
            .accounts
            .values()
            .flatten()
            .map(|info| info.code_hash)
            .filter(|hash| *hash != KECCAK256_EMPTY && !self.code.contains_key(hash))
            .collect();
        hashes.sort_unstable();
        hashes.dedup();
        hashes
    }
}

/// revm database over [`Known`]: unknown values are recorded in `misses` and answered with
/// placeholders. An account whose code is not known yet records its code as missing too.
#[derive(Debug)]
pub struct KnownRef<'a> {
    known: &'a Known,
    /// Each miss with the first program step that made it.
    pub misses: RefCell<BTreeMap<Miss, usize>>,
    /// The step being executed.
    pub step: Cell<usize>,
}

impl<'a> KnownRef<'a> {
    pub fn new(known: &'a Known) -> Self {
        Self {
            known,
            misses: RefCell::default(),
            step: Cell::new(0),
        }
    }

    pub fn missed(&self) -> usize {
        self.misses.borrow().len()
    }

    fn miss(&self, miss: Miss) {
        let step = self.step.get();
        self.misses
            .borrow_mut()
            .entry(miss)
            .and_modify(|first| *first = (*first).min(step))
            .or_insert(step);
    }
}

impl DatabaseRef for KnownRef<'_> {
    type Error = MissError;

    fn basic_ref(&self, address: Address) -> Result<Option<AccountInfo>, MissError> {
        match self.known.accounts.get(&address) {
            Some(Some(info)) => {
                let mut info = info.clone();
                if info.code_hash != KECCAK256_EMPTY {
                    match self.known.code.get(&info.code_hash) {
                        Some(code) => info.code = Some(code.clone()),
                        None => self.miss(Miss::Code(info.code_hash)),
                    }
                }
                Ok(Some(info))
            }
            Some(None) => Ok(None),
            None => {
                self.miss(Miss::Account(address));
                Ok(None)
            }
        }
    }

    fn code_by_hash_ref(&self, hash: B256) -> Result<Bytecode, MissError> {
        if hash == KECCAK256_EMPTY {
            return Ok(Bytecode::default());
        }
        match self.known.code.get(&hash) {
            Some(code) => Ok(code.clone()),
            None => {
                self.miss(Miss::Code(hash));
                Ok(Bytecode::default())
            }
        }
    }

    fn storage_ref(&self, address: Address, slot: U256) -> Result<U256, MissError> {
        match self.known.storage.get(&(address, slot)) {
            Some(value) => Ok(*value),
            None => {
                self.miss(Miss::Storage(address, slot));
                Ok(U256::ZERO)
            }
        }
    }

    fn block_hash_ref(&self, number: u64) -> Result<B256, MissError> {
        match self.known.hashes.get(&number) {
            Some(hash) => Ok(*hash),
            None => {
                self.miss(Miss::BlockHash(number));
                Ok(B256::ZERO)
            }
        }
    }
}
