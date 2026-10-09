//! nullrpc's EVM executor: `eth_call`, `eth_estimateGas`, `eth_createAccessList`, Geth's
//! `debug_trace*` and Erigon's `trace_*`, built on revm and revm-inspectors. Pure compute: no
//! I/O and no async. State arrives in rounds through the TypeScript shell (apps/executor/src):
//! a session runs as far as the values it knows allow and answers either the response or the
//! keys it needs next.
//!
//! The logic is ported from exe (`exe-execution`, `exe-trace`); its storage code is not.

mod access_list;
pub mod api;
pub mod cache;
mod calls;
pub mod config;
mod format;
mod limits;
mod options;
pub mod protocol;
mod record;
mod replay;
pub mod state;

#[cfg(test)]
mod tests;

use serde_json::json;

/// JSON of a round's [`api::Progress`]: `{"done":true,"response":…}`,
/// `{"witness":n,"hash":…}` or `{"missing":[StateKey…],"at":n}`.
pub fn progress_json(progress: api::Progress) -> String {
    match progress {
        api::Progress::Done(response) => json!({"done": true, "response": response}),
        api::Progress::Witness(number, hash) => {
            json!({"witness": number, "hash": format!("{hash:#x}")})
        }
        api::Progress::Need(keys, at) => json!({
            "missing": keys.iter().map(protocol::key_json).collect::<Vec<_>>(),
            "at": at,
        }),
    }
    .to_string()
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use wasm_bindgen::prelude::*;

    /// One request's execution across rounds (keeps its checkpoint and known values).
    #[wasm_bindgen]
    pub struct Session(crate::api::Session);

    #[wasm_bindgen]
    impl Session {
        /// A session for an `ExecRequest` (JSON).
        #[wasm_bindgen(constructor)]
        pub fn new(request_json: &str) -> Session {
            Session(crate::api::Session::new(request_json))
        }

        /// Answer the last round (`{"keys","values","witness"?}` JSON, empty for the first
        /// round) and run the next one.
        pub fn run(&mut self, state_json: &str) -> String {
            crate::progress_json(self.0.run(state_json))
        }

        /// What the request used so far.
        pub fn usage(&self) -> String {
            self.0.usage()
        }
    }

    /// Whether the module holds the decoded record of the block with this hash (a request may
    /// then name `blockHash` and leave `block` out).
    #[wasm_bindgen]
    pub fn has_block(hash: &str) -> bool {
        hash.parse().is_ok_and(|h| crate::cache::has_block(&h))
    }

    /// Whether the module holds a state snapshot for the block with this hash (a request may
    /// then start from it with `seed` and skip its hints).
    #[wasm_bindgen]
    pub fn has_known(hash: &str) -> bool {
        hash.parse().is_ok_and(|h| crate::cache::has_known(&h))
    }

    /// Stateless form: run `request_json` over the values in `state_json` (everything known
    /// so far, `{"keys","values","witness"?}`).
    #[wasm_bindgen]
    pub fn run(request_json: &str, state_json: &str) -> String {
        let mut session = crate::api::Session::new(request_json);
        let first = session.run("");
        if state_json.trim().is_empty() {
            return crate::progress_json(first);
        }
        crate::progress_json(session.run(state_json))
    }
}
