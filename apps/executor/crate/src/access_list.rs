//! `eth_createAccessList`: go-ethereum's `AccessListTracer` over the same
//! call path as `eth_call` (ported from exe-execution).
use alloy_primitives::{Address, B256, TxKind};
use revm::{
    Inspector,
    bytecode::opcode,
    context::JournalTr,
    context_interface::{ContextTr, Transaction},
    inspector::JournalExt,
    interpreter::{
        Interpreter,
        interpreter_types::{InputsTr, Jumps},
    },
};
use std::collections::{BTreeMap, BTreeSet};

/// Addresses and storage slots a call touches, in first-touch order (as
/// Erigon lists them). The sender, the recipient (or created address) and
/// precompiles are only listed for their storage slots.
#[derive(Clone, Debug, Default)]
pub(crate) struct AccessListTracer {
    excluded: BTreeSet<Address>,
    entries: Vec<(Address, Vec<B256>)>,
    index: BTreeMap<Address, usize>,
}

impl AccessListTracer {
    /// Start from `list` (the request's access list).
    pub(crate) fn new(list: &[(Address, Vec<B256>)]) -> Self {
        let mut tracer = Self::default();
        for (address, slots) in list {
            tracer.address(*address);
            for slot in slots {
                tracer.slot(*address, *slot);
            }
        }
        tracer
    }

    fn address(&mut self, address: Address) -> usize {
        if let Some(position) = self.index.get(&address) {
            return *position;
        }
        self.entries.push((address, Vec::new()));
        self.index.insert(address, self.entries.len() - 1);
        self.entries.len() - 1
    }

    fn slot(&mut self, address: Address, slot: B256) {
        let position = self.address(address);
        let slots = &mut self.entries[position].1;
        if !slots.contains(&slot) {
            slots.push(slot);
        }
    }

    pub(crate) fn list(&self) -> Vec<(Address, Vec<B256>)> {
        self.entries.clone()
    }

    /// Geth `AccessListTracer.Equal`: the same addresses and slots.
    pub(crate) fn same(a: &[(Address, Vec<B256>)], b: &[(Address, Vec<B256>)]) -> bool {
        let set = |list: &[(Address, Vec<B256>)]| -> BTreeMap<Address, BTreeSet<B256>> {
            list.iter()
                .map(|(address, slots)| (*address, slots.iter().copied().collect()))
                .collect()
        };
        set(a) == set(b)
    }

    fn exclude<CTX: ContextTr<Journal: JournalExt>>(&mut self, context: &CTX) {
        let from = context.tx().caller();
        let to = match context.tx().kind() {
            TxKind::Call(to) => to,
            TxKind::Create => {
                let nonce = context
                    .journal_ref()
                    .evm_state()
                    .get(&from)
                    .map_or(0, |account| account.info.nonce);
                from.create(nonce)
            }
        };
        self.excluded = [from, to]
            .into_iter()
            .chain(context.journal_ref().precompile_addresses().iter().copied())
            .collect();
        // Request entries of excluded addresses go; their slots come back
        // when execution touches them.
        let kept: Vec<_> = std::mem::take(&mut self.entries)
            .into_iter()
            .filter(|(address, _)| !self.excluded.contains(address))
            .collect();
        self.index.clear();
        for (address, slots) in kept {
            self.address(address);
            for slot in slots {
                self.slot(address, slot);
            }
        }
    }
}

impl<CTX> Inspector<CTX> for AccessListTracer
where
    CTX: ContextTr<Journal: JournalExt>,
{
    fn step(&mut self, interp: &mut Interpreter, _context: &mut CTX) {
        match interp.bytecode.opcode() {
            opcode::SLOAD | opcode::SSTORE => {
                if let Ok(slot) = interp.stack.peek(0) {
                    let address = interp.input.target_address();
                    self.slot(address, B256::from(slot.to_be_bytes()));
                }
            }
            opcode::EXTCODECOPY
            | opcode::EXTCODEHASH
            | opcode::EXTCODESIZE
            | opcode::BALANCE
            | opcode::SELFDESTRUCT => {
                if let Ok(word) = interp.stack.peek(0) {
                    let address = Address::from_word(B256::from(word.to_be_bytes()));
                    if !self.excluded.contains(&address) {
                        self.address(address);
                    }
                }
            }
            opcode::DELEGATECALL | opcode::CALL | opcode::STATICCALL | opcode::CALLCODE => {
                if let Ok(word) = interp.stack.peek(1) {
                    let address = Address::from_word(B256::from(word.to_be_bytes()));
                    if !self.excluded.contains(&address) {
                        self.address(address);
                    }
                }
            }
            _ => {}
        }
    }

    fn call(
        &mut self,
        context: &mut CTX,
        _inputs: &mut revm::interpreter::CallInputs,
    ) -> Option<revm::interpreter::CallOutcome> {
        if context.journal().depth() == 0 {
            self.exclude(context);
        }
        None
    }

    fn create(
        &mut self,
        context: &mut CTX,
        _inputs: &mut revm::interpreter::CreateInputs,
    ) -> Option<revm::interpreter::CreateOutcome> {
        if context.journal().depth() == 0 {
            self.exclude(context);
        }
        None
    }
}
