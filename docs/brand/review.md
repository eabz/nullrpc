# Brand review notes

The checks performed on the bundled kit, and how to repeat them. Commands are in the [README](README.md#rebuilding-and-verification).

## Results

| Check | Result |
|---|---|
| Text, button, focus, status and chart-to-surface contrast (`check-contrast.py`) | **74 / 74 required pairs pass** in both themes; see [color.md](color.md#measured-contrast) |
| Visual guide at **1440, 768, 390 and 320 px** (`check-guide.cjs`) | No horizontal overflow at any width |
| Guide resources | **67 local references** resolve; all five IBM Plex faces load; no broken images, browser errors or external requests |
| Symbol and logo at actual size | Viewed the **16/20 px optical marks**, **24/32/48/64 px regular marks** and **144/220/330 px lockups** on Carbon |
| Deliverables | **18 SVGs, 13 PNGs, one ICO** with 16/32/48 px frames |
| Portability | All SVGs parse as XML; logo lettering is outlined with no font dependency; PNG logos keep alpha |

## What the checks cover

- **Contrast.** Color math on the token pairs in [brand.json](tokens/brand.json), evaluated before rounding. Decorative hairline borders are reported separately and are never counted as control boundaries. Chart colors are checked against surfaces, not against each other, so series still need labels and markers.
- **Guide rendering.** `check-guide.cjs` loads [index.html](index.html) in headless Chromium with all network requests blocked, waits for fonts, then records overflow, font status, image loading, missing local files and anchors. It writes section captures, an actual-size symbol and lockup sheet, and `browser-review.json` to `previews/`. Inspect the captures, then delete the folder.
- **Artwork.** The [brand overview](assets/brand-board.png), [social card](assets/social-card.png) and [banner](assets/banner.png) were inspected for hierarchy, spacing, wordmark fidelity, palette consistency and clipped text.

## Limits

These checks review the kit itself. They do not test the applications in `apps/`, the deployed RPC service, or any claim about its performance or data practices. Recheck focus visibility, component states, text sizes and layout in each finished interface, and keep claims aligned with documented product policies.
