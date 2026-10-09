//! What the module keeps across sessions (one instance serves every request of an isolate):
//! decoded block records by hash, and the state known at the end of a block by its hash (the
//! snapshot the shell asks for after a call's first wave: hints, profile and the executor's own
//! first keys, with their bytecode analysed). A request at a block the module has seen sends
//! neither the record nor the hints again: it names the hash and starts from the snapshot.
//! Both are immutable per hash; the newest few blocks are kept.

use crate::{record::Block, state::Known};
use alloy_primitives::B256;
use std::{cell::RefCell, collections::VecDeque, rc::Rc};

/// Blocks and snapshots kept (a head changes every block; calls run at the newest few).
const KEEP: usize = 8;

thread_local! {
    static BLOCKS: RefCell<VecDeque<(B256, Rc<Block>)>> = RefCell::new(VecDeque::new());
    static KNOWN: RefCell<VecDeque<(B256, Known)>> = RefCell::new(VecDeque::new());
}

fn put<T>(deque: &mut VecDeque<(B256, T)>, hash: B256, value: T) {
    deque.retain(|(h, _)| *h != hash);
    deque.push_back((hash, value));
    while deque.len() > KEEP {
        deque.pop_front();
    }
}

pub fn block(hash: &B256) -> Option<Rc<Block>> {
    BLOCKS.with(|b| b.borrow().iter().find(|(h, _)| h == hash).map(|(_, block)| Rc::clone(block)))
}

pub fn remember_block(block: Block) -> Rc<Block> {
    let rc = Rc::new(block);
    BLOCKS.with(|b| put(&mut b.borrow_mut(), rc.hash, Rc::clone(&rc)));
    rc
}

pub fn has_block(hash: &B256) -> bool {
    BLOCKS.with(|b| b.borrow().iter().any(|(h, _)| h == hash))
}

/// A copy of the state snapshot taken at `hash`.
pub fn known(hash: &B256) -> Option<Known> {
    KNOWN.with(|k| k.borrow().iter().find(|(h, _)| h == hash).map(|(_, known)| known.clone()))
}

pub fn remember_known(hash: B256, known: &Known) {
    KNOWN.with(|k| put(&mut k.borrow_mut(), hash, known.clone()));
}

pub fn has_known(hash: &B256) -> bool {
    KNOWN.with(|k| k.borrow().iter().any(|(h, _)| h == hash))
}

/// Forgets everything (tests).
#[allow(dead_code)]
pub fn reset() {
    BLOCKS.with(|b| b.borrow_mut().clear());
    KNOWN.with(|k| k.borrow_mut().clear());
}
