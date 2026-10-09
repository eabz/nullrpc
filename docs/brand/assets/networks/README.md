# Network marks

Small marks that identify a supported or planned network next to its name in product
details (endpoint pages, the status dashboard, the landing page). They are not part of
the nullrpc identity.

| File | Network | Artwork |
|---|---|---|
| [ethereum.svg](ethereum.svg) | Ethereum mainnet (chain ID 1) | The Ethereum diamond (glyph), proportions 256:417 |
| [hoodi.svg](hoodi.svg) | Hoodi testnet (chain ID 560048) | The same diamond inside a dashed ring, 32 × 32 |

## Source and attribution

The diamond follows the geometry of the Ethereum Foundation's official ETH glyph from
[ethereum.org/assets](https://ethereum.org/assets/), redrawn as six facets in a single
ink. The facet tones (100%, 80%, 45% opacity) mirror the official grayscale glyph; the
outline and proportions are unchanged. ethereum.org offers these assets for referring to
Ethereum. Use them only to name the network; they must not suggest that the Ethereum
Foundation endorses nullrpc. Before publishing in a new medium, compare against the
current download on ethereum.org/assets and its terms.

Hoodi has no separate official logo. Its mark is the Ethereum diamond with a dashed ring,
the testnet treatment used across nullrpc. The dashed ring means "test network"; do not
use it for mainnet.

## Usage

- Both files fill with `currentColor`. Inline the SVG (or use it as a CSS `mask-image`)
  and set `color` to the theme's text color: Paper on dark, Carbon on light. As an `<img>`
  it renders in black, which is only correct on a light field.
- Do not recolor beyond a single ink (text color, or the brand's one-color white/black).
  Do not add gradients, outlines, shadows, or stretch the diamond.
- Always pair a mark with the network name in text: "Hoodi testnet", "Ethereum mainnet".
  Decorative next to that label: `alt=""` / `aria-hidden="true"`.
- Minimum size: `ethereum.svg` 16 CSS px tall; `hoodi.svg` 20 CSS px (the dashed ring
  closes up below that; use the plain diamond plus the word "testnet" instead).
- Clear space: at least a quarter of the mark's width on every side.
- Network marks never replace, merge with, or lock up with the nullrpc logo or symbol.
  Keep them in product details (a network list, a status row), never in the logo's clear
  space, the favicon, the avatar, or the social card.
- Distinguish planned networks from live ones in words ("Live", "Coming soon"), not only by
  dimming the mark.
