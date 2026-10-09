//! A cursor over RLP: items are located, never materialized, so eth_getLogs touches only the
//! fields it needs of a block record. Canonical-form checks follow apps/rpc/src/eth/rlp.ts for
//! the items visited; items that are skipped (transactions without matching logs) are not
//! validated beyond their framing.

#[derive(Clone, Copy)]
pub struct Item<'a> {
    pub list: bool,
    /// The item's content: the string's bytes, or the concatenated items of a list.
    pub payload: &'a [u8],
    /// The item's whole encoding (hashes are computed over it).
    pub raw: &'a [u8],
}

#[derive(Debug)]
pub struct Malformed;

fn length(input: &[u8], at: usize, n: usize) -> Result<usize, Malformed> {
    if n > 4 || at + n > input.len() || input[at] == 0 {
        return Err(Malformed);
    }
    let mut v = 0usize;
    for &b in &input[at..at + n] {
        v = (v << 8) | b as usize;
    }
    if v < 56 { Err(Malformed) } else { Ok(v) }
}

/// The item starting at `at`, and the offset after it.
pub fn item_at(input: &[u8], at: usize) -> Result<(Item<'_>, usize), Malformed> {
    let b = *input.get(at).ok_or(Malformed)?;
    if b < 0x80 {
        return Ok((Item { list: false, payload: &input[at..at + 1], raw: &input[at..at + 1] }, at + 1));
    }
    let (list, start, n) = if b < 0xb8 {
        let n = (b - 0x80) as usize;
        if n == 1 && input.get(at + 1).copied().unwrap_or(0) < 0x80 {
            return Err(Malformed);
        }
        (false, at + 1, n)
    } else if b < 0xc0 {
        let ll = (b - 0xb7) as usize;
        (false, at + 1 + ll, length(input, at + 1, ll)?)
    } else if b < 0xf8 {
        (true, at + 1, (b - 0xc0) as usize)
    } else {
        let ll = (b - 0xf7) as usize;
        (true, at + 1 + ll, length(input, at + 1, ll)?)
    };
    let end = start.checked_add(n).ok_or(Malformed)?;
    if end > input.len() {
        return Err(Malformed);
    }
    Ok((Item { list, payload: &input[start..end], raw: &input[at..end] }, end))
}

/// The item that is exactly `input` (trailing bytes are an error).
pub fn item(input: &[u8]) -> Result<Item<'_>, Malformed> {
    let (it, end) = item_at(input, 0)?;
    if end != input.len() { Err(Malformed) } else { Ok(it) }
}

/// The items of a list, in order.
pub struct Items<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Items<'a> {
    pub fn of(list: &Item<'a>) -> Result<Items<'a>, Malformed> {
        if !list.list {
            return Err(Malformed);
        }
        Ok(Items { data: list.payload, pos: 0 })
    }

    /// The next item, which must exist.
    pub fn expect(&mut self) -> Result<Item<'a>, Malformed> {
        self.next().ok_or(Malformed)?
    }

    /// How many items follow (a framing pass; the cursor is unchanged).
    pub fn remaining(&self) -> Result<usize, Malformed> {
        let mut n = 0;
        let mut pos = self.pos;
        while pos < self.data.len() {
            pos = item_at(self.data, pos)?.1;
            n += 1;
        }
        Ok(n)
    }
}

impl<'a> Iterator for Items<'a> {
    type Item = Result<Item<'a>, Malformed>;
    fn next(&mut self) -> Option<Self::Item> {
        if self.pos >= self.data.len() {
            return None;
        }
        match item_at(self.data, self.pos) {
            Ok((it, end)) => {
                self.pos = end;
                Some(Ok(it))
            }
            Err(e) => {
                self.pos = self.data.len();
                Some(Err(e))
            }
        }
    }
}

/// The string item's bytes.
pub fn bytes<'a>(it: Item<'a>) -> Result<&'a [u8], Malformed> {
    if it.list { Err(Malformed) } else { Ok(it.payload) }
}
