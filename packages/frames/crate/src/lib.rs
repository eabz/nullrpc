//! Archive frame decoding for the RPC Worker (apps/rpc, packages/frames/src/index.ts): zstd
//! decompression of one frame at a time into a buffer the caller sized from the manifest, and
//! eth_getLogs extraction from a decompressed block record. Plain C-ABI exports, no bindgen glue:
//! the JavaScript side owns buffers in this module's memory (`nullrpc_alloc`) and copies frames in;
//! results come back through the caller's buffer or the module's output buffer (`nullrpc_out_ptr`).

mod logs;
mod rlp;

use std::alloc::{Layout, alloc, dealloc};
use std::cell::RefCell;
use zstd_safe::DCtx;

thread_local! {
    // One decompression context per instance, reused by every call: its workspace is allocated
    // once, and one-shot decompression writes straight into the caller's buffer.
    static DCTX: RefCell<Option<DCtx<'static>>> = const { RefCell::new(None) };
    // The JSON of the last `nullrpc_frame_logs`, kept allocated between calls.
    static OUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

fn layout(len: usize) -> Layout {
    Layout::from_size_align(len.max(1), 8).expect("layout")
}

/// `len` bytes of module memory, 8-aligned; null when the allocation fails.
#[unsafe(no_mangle)]
pub extern "C" fn nullrpc_alloc(len: usize) -> *mut u8 {
    // SAFETY: the layout has a non-zero size.
    unsafe { alloc(layout(len)) }
}

/// Returns a block from `nullrpc_alloc` of the same `len`.
#[unsafe(no_mangle)]
pub extern "C" fn nullrpc_free(ptr: *mut u8, len: usize) {
    if ptr.is_null() {
        return;
    }
    // SAFETY: the caller passes a pointer and length from `nullrpc_alloc`.
    unsafe { dealloc(ptr, layout(len)) }
}

/// Decompresses the frame at `src` into `dst`. Returns the number of bytes written, or the
/// negated zstd error code (the output not fitting in `dst_len` bytes is an error).
#[unsafe(no_mangle)]
pub extern "C" fn nullrpc_decompress(src: *const u8, src_len: usize, dst: *mut u8, dst_len: usize) -> i32 {
    if src.is_null() || dst.is_null() || dst_len > i32::MAX as usize {
        return -1;
    }
    // SAFETY: both ranges are inside buffers from `nullrpc_alloc` that the caller still owns.
    let (input, output) = unsafe { (std::slice::from_raw_parts(src, src_len), std::slice::from_raw_parts_mut(dst, dst_len)) };
    DCTX.with(|cell| {
        let mut slot = cell.borrow_mut();
        let dctx = slot.get_or_insert_with(DCtx::create);
        match dctx.decompress(output, input) {
            Ok(n) => n as i32,
            Err(code) => -(code as i32).max(1),
        }
    })
}

/// The logs of the block record at `frame` (decompressed) that the filter at `filter` accepts,
/// written as a JSON array to the output buffer (`nullrpc_out_ptr`). `hash` is the block's
/// 32-byte hash from the offsets record. Returns the JSON's length in bytes (0 when no log is
/// accepted) or a negative code: -1 malformed record, -2 header with too few fields, -3 the
/// header does not hash to `hash`, -4 receipts and transactions differ in number, -5 an integer
/// outside JavaScript's safe range, -6 malformed filter.
#[unsafe(no_mangle)]
pub extern "C" fn nullrpc_frame_logs(frame: *const u8, frame_len: usize, hash: *const u8, filter: *const u8, filter_len: usize) -> i32 {
    if frame.is_null() || hash.is_null() || filter.is_null() {
        return -1;
    }
    // SAFETY: the ranges are inside buffers from `nullrpc_alloc` that the caller still owns.
    let (frame, hash, filter) = unsafe { (std::slice::from_raw_parts(frame, frame_len), std::slice::from_raw_parts(hash, 32), std::slice::from_raw_parts(filter, filter_len)) };
    let filter = match logs::parse_filter(filter) {
        Ok(f) => f,
        Err(e) => return e.code(),
    };
    OUT.with(|cell| {
        let mut out = cell.borrow_mut();
        out.clear();
        match logs::frame_logs(frame, hash, &filter, &mut out) {
            Ok(_) if out.len() > i32::MAX as usize => -1,
            Ok(_) => out.len() as i32,
            Err(e) => e.code(),
        }
    })
}

/// Where the last `nullrpc_frame_logs` output starts (valid until the next call into the module).
#[unsafe(no_mangle)]
pub extern "C" fn nullrpc_out_ptr() -> *const u8 {
    OUT.with(|cell| cell.borrow().as_ptr())
}
