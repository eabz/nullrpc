# Typography and composition

The system uses one superfamily. **IBM Plex Sans** sets the wordmark, headings, prose and interface. **IBM Plex Mono** sets code, data and short uppercase labels. Plex was drawn for engineering contexts: its letterforms are neutral and rational, and the shared skeleton keeps sans and mono aligned on the same line. Mono gives addresses, methods, hashes and quantities consistent widths.

## Type roles

| Role | Family / weight | Size / line height | Tracking |
|---|---|---|---|
| Large cover | Plex Sans 600 | 72 / 76 px; 44 / 48 px on narrow screens | −0.025em |
| Page title | Plex Sans 600 | 48 / 54 px; 36 / 42 px on narrow screens | −0.02em |
| Section heading | Plex Sans 600 | 32 / 40 px | −0.015em |
| Subheading | Plex Sans 500 | 20 / 28 px | −0.005em |
| Reading text | Plex Sans 400 | 16 / 26 px; 18 / 29 px for introductions | 0 |
| UI label / action | Plex Sans 500 | 14–15 / 20 px | 0 |
| Code / data | Plex Mono 400 | 13–14 / 21–23 px | 0 |
| Eyebrow label | Plex Mono 500, uppercase | 11–12 / 16–18 px | +0.12em |

**Eyebrows** are the system's signature label: a short uppercase mono line above a heading or a figure, such as `RPC INFRASTRUCTURE` or `02 / COLOR`. Keep them to a few words, in `text-secondary` or the accent color, at about 0.12em tracking. Do not set sentences or the brand name in uppercase.

Use sentence case for headings and controls. The name **nullrpc** stays lowercase everywhere. Use no more than three sizes in a small application. Only the bundled weights exist (Sans 400/500/600, Mono 400/500); set `font-synthesis: none` and never request other weights or italics. For prose emphasis use Sans 600.

Reading columns should stay near 60–72 characters. Left-align long copy and code. Let long addresses wrap with `overflow-wrap: anywhere` when copying is not affected; scroll code examples horizontally without hiding their content. Use `font-variant-numeric: tabular-nums` for metrics, latencies and block numbers. Never invent metrics for decorative purposes.

The bundled `.woff2` files work without a font service. [Font provenance and licenses](fonts/README.md) accompany them. The token CSS contains fallback stacks for consumers that choose not to bundle fonts. Do not replace the outlined wordmark with live text.

## Layout

Use a four-pixel base with these spacing steps: **4, 8, 12, 16, 24, 32, 48, 64, 96**. A normal content container has a maximum width near 1280 px, 48–64 px desktop gutters, and 16–24 px mobile gutters. Use a 12-column desktop grid, collapsing to a single reading column on phones. Align section numbers, eyebrows, headings and body copy to shared edges.

The identity should read as engineered: aligned, measured, quiet. Keep large covers sparse, with one message and one focal mark. For a normal composition, aim for roughly 75–85% neutral area, 10–20% text and structure, and no more than 5–10% accent. This is an art-direction guide, not a pixel-count requirement.

**Shape language.**

- **Corners** are tight: **2 px** for inputs, chips and tags; **4 px** for buttons and cards; **6 px** at most for large panels and dialogs. No pills, no large rounded cards.
- **Edges** are 1 px hairlines (`--nr-border`). Use them to frame cards, divide table rows and separate sections. Use `--nr-border-strong` where a boundary identifies a control.
- **Depth** is flat. Step surfaces (Carbon → Surface → Raised) instead of adding shadows. A single subtle 1 px shadow is the limit for an overlay.
- **Texture** is the engineering grid: hairline lines on a regular step, one shade off the background (see [pattern.svg](assets/pattern.svg)). Use it behind covers and cards, never behind running text.
- **Not used:** glow, gradients, glass or blur effects, drop shadows, gradient lettering, 3D or metallic treatments.

Avoid making every paragraph a card. Use hairline rules to separate editorial sections and surfaces to group interface controls.

## Graphics and iconography

The central motif is **the seal**: a closed square cut on its diagonal, with an empty centre. It can appear as a large symbol, a faint registration mark on the grid, or the structure behind paired request/response panels. The [pattern](assets/pattern.svg) is decoration only; it does not show real activity or measured traffic. Keep text on a quiet, solid part of a composition.

Interface icons should use a 24 px grid, 1.5 px strokes, square or mitred joins and simple geometry. Keep them separate from the filled brand symbol. Pair ambiguous or consequential icons with labels. Status must have words or symbols in addition to color. Use solid/dashed strokes, markers and labels for charts when multiple series touch; contrast against the background alone does not distinguish series from each other.

For imagery, prefer diagrams, code, tables and carefully labeled product captures. Keep storage diagrams in technical documentation. Avoid stock cryptocurrency coins, rockets, glowing server racks, padlock clip art and network-specific symbols in the core identity. Use a network mark (see [assets/networks/](assets/networks/README.md)) only to identify an actual supported network in product details. A screenshot is evidence: label prototypes and example data honestly.

## Motion

The brand works without motion. If added in an application, use 120–160 ms ease-out transitions for hover, focus and state changes. Preserve layout; avoid animated logos, pulsing or blinking status dots, and looping ambient movement. Respect `prefers-reduced-motion: reduce`. Never rely on an animation to communicate a completed request or an error.

## Print and handoff

SVGs are vector masters, and logo lettering is already outlined. Deliver the one-color marks for single-ink printing. The documented hex values are **sRGB**; CMYK conversion depends on the printer, paper and output profile. Ask the printer to convert from the supplied source using the actual production profile and approve a proof. An arbitrary CMYK approximation is not a universal color specification.

For a new placement, check the smallest intended size, the actual background, a monochrome version and any crop. Preserve clear space and keep technical qualifications readable. Use the [review notes](review.md) as the reference for the checks already performed on the bundled files.
