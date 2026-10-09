# nullrpc color and implementation tokens

The identity uses a carbon field, cool neutral type and a single blue signal. Blue marks an action, a selected state, a link, the logo, or the part of a diagram that needs attention. It should not wash over panels. Structure comes from hairline borders and a quiet engineering grid, not from tinted fills, gradients or glow.

Dark mode splits the accent in two. **Signal** `#5B8CFF` is light enough to read as text on carbon, so it carries links, marks and focus. It is too light to carry white text (3.16:1), so filled buttons use the deeper **Cobalt** `#2F62E9` with **white** text. Light mode uses **Deep signal** `#1F4FD1` for both jobs.

For a typical brand composition, aim for roughly **80% background, 15% text and structural neutrals, and at most 5% saturated accent** by visible area. These are composition targets, not measurement requirements. Use one primary action per region.

## Core palette

All values are opaque sRGB colors. Use the exact hex values in digital artwork; do not add opacity to text or control outlines without checking the resulting contrast.

| Name | Hex | Role |
| --- | --- | --- |
| Carbon | `#0A0D12` | Main dark canvas; primary text on light |
| Surface | `#11151C` | Dark cards and panels |
| Raised | `#181D26` | Dark inset controls and elevated regions |
| Paper | `#F2F4F7` | Primary text on dark; light canvas |
| White | `#FFFFFF` | Light cards; text on every filled button |
| Mist | `#9BA5B4` | Secondary text on dark; meaningful dark control outlines |
| Slate | `#4A5565` | Secondary text on light; meaningful light control outlines |
| Signal | `#5B8CFF` | Dark-mode links, accent text, marks, selected states and focus |
| Deep signal | `#1F4FD1` | Light-mode links, accent text, marks, focus and button fill |
| Cobalt | `#2F62E9` | Dark-mode button fill, always with white text |
| Line dark | `#232A35` | Decorative dark hairlines and dividers |
| Line light | `#D5DBE3` | Decorative light hairlines and dividers |

The generator also uses `#151A22` for the grid lines drawn on Carbon in the pattern, social card and brand board, and `#E7EBF0` for the grid on the Paper banner. These are artwork values, not interface tokens.

**Do not use Signal for text on white or Paper** (3.16:1 and 2.87:1). Use Deep signal. **Do not put white text on Signal**; use Cobalt. Do not use Cobalt or Deep signal as text on Carbon (3.75:1 and 2.87:1). Keep links underlined in prose so their role is visible without hue recognition. Do not use Mist on white (2.49:1) or Slate on a dark surface (2.57:1).

## Semantic mapping

Consume the semantic token rather than copying a primitive into each component. Every token below is prefixed with `--nr-` in CSS. The same unprefixed keys appear in the `themes` objects in [brand.json](tokens/brand.json).

| Token | Dark | Light |
| --- | --- | --- |
| `bg` | Carbon | Paper |
| `surface` | Surface | White |
| `surface-raised` | Raised | White |
| `text` | Paper | Carbon |
| `text-secondary` | Mist | Slate |
| `accent` | Signal | Deep signal |
| `border` | Line dark | Line light |
| `border-strong` | Mist | Slate |
| `focus` | Signal | Deep signal |
| `button-bg` | Cobalt | Deep signal |
| `button-text` | White | White |

`border` is a 1px hairline for dividers, cards and decoration. It is too subtle to be the only visible boundary of an input or unfilled button; use `border-strong` there. The two light surfaces are both white: distinguish adjacent regions with layout, spacing and hairlines rather than inventing another tint.

Elevation is flat. Separate layers with a surface step (Carbon → Surface → Raised) and a hairline. If an overlay needs depth, a single subtle 1px shadow is the limit; no blurred drop shadows, glows or gradients.

### Status

Status colors are functional, not extra brand accents. Always pair them with a word and, where helpful, a distinct icon: **Operational ✓**, **Degraded !**, **Unavailable ×**. A green dot alone is insufficient. Blue remains the action color.

| Token | Meaning | Dark | Light |
| --- | --- | --- | --- |
| `status-success` | Successful / available | `#3DD68C` | `#15803D` |
| `status-warning` | Delayed / needs attention | `#F5B83D` | `#B45309` |
| `status-error` | Failed / unavailable | `#F7637A` | `#C0262D` |

Use these as text or icons on the three theme surfaces. They are not background colors for white labels. For a status panel, keep the normal surface, add the colored icon and label, and keep descriptive text in `text` or `text-secondary`. Light-mode success and warning on Paper pass with little margin (4.55:1 and 4.56:1); do not lighten them.

### Charts

| Token | Dark | Light |
| --- | --- | --- |
| `chart-1` | `#5B8CFF` | `#1F4FD1` |
| `chart-2` | `#A897FF` | `#6D28D9` |
| `chart-3` | `#F0A35E` | `#9A3412` |
| `chart-4` | `#4FD1C5` | `#0F766E` |

Use up to four series. Label them directly and vary line styles or markers: solid/circle, dashed/square, dotted/triangle, dash-dot/diamond. Use at least a 2px line in small charts. These colors have been checked against the theme surfaces, **not against each other**. Separate touching filled regions with a theme-colored gap or outline; avoid overlapping translucent fills. A series must remain identifiable in grayscale and without relying on a legend's color alone.

## Measured contrast

The kit targets at least **4.5:1 for text** and **3:1 for meaningful control outlines, focus indicators and chart marks against their surface**. These follow the W3C explanations of [text contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) and [non-text contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html). Ratios are evaluated before rounding; values below are rounded to two decimals.

| Pair | Ratio |
| --- | ---: |
| Paper text on Carbon | 17.66:1 |
| Paper text on Raised | 15.34:1 |
| Mist secondary text on Carbon | 7.82:1 |
| Mist secondary text on Raised | 6.79:1 |
| Signal on Carbon | 6.15:1 |
| Signal on Raised | 5.34:1 |
| White text on Cobalt button (dark) | 5.19:1 |
| Carbon text on Paper | 17.66:1 |
| Carbon text on White | 19.46:1 |
| Slate secondary text on Paper | 6.86:1 |
| Deep signal on Paper | 6.15:1 |
| White text on Deep signal button (light) | 6.78:1 |
| Lowest checked status pairing: light success on Paper | 4.55:1 |
| Lowest checked dark status pairing: dark error on Raised | 5.65:1 |
| Lowest checked chart pairing: light mint on Paper | 4.97:1 |

[check-contrast.py](scripts/check-contrast.py) checks **74 required pairings**, all passing: primary and secondary text, accents, status labels, buttons, strong boundaries, focus rings and chart marks on all three surfaces in both themes. Decorative borders are printed separately and excluded from control boundaries; their ratios are 1.17–1.35:1 in dark mode and 1.26–1.39:1 in light mode.

```sh
python3 docs/brand/scripts/check-contrast.py
```

The checker reads [brand.json](tokens/brand.json), uses only Python's standard library, and exits nonzero on a failed required pairing. It verifies color math, not full-page accessibility. Verify real component states, focus visibility, responsive layout and text sizes in the finished interface.

The dark focus ring (Signal) against a Cobalt button is only 1.64:1. That is why the ring sits at a 3px offset: what it must contrast with is the surface in the gap (6.15:1 on Carbon), not the button. Cobalt as a button boundary against Carbon is 3.75:1, so a filled button is identifiable without an outline.

## Using the tokens

[brand.css](tokens/brand.css) registers the local IBM Plex `.woff2` files and scopes theme styles to `.nullrpc-brand` or `[data-nullrpc-theme]`. There is no global `:root` theme or element reset. Both font licenses are kept in [fonts/](fonts/).

```html
<link rel="stylesheet" href="docs/brand/tokens/brand.css">

<!-- A wrapper without an explicit theme uses dark mode. -->
<section class="nullrpc-brand">
  <!-- Your content -->
</section>

<!-- Use an explicit theme to create a light region. -->
<section class="nullrpc-brand" data-nullrpc-theme="light">
  <!-- Your content -->
</section>
```

Adjust the stylesheet URL to your page location. Preserve the `tokens/` and `fonts/` relative relationship when copying the files into an application. Theme attributes support `dark` and `light`. The kit does not switch with the operating system; applications choose the value explicitly.

```css
/* Example component styles; these are not global resets. */
.nullrpc-brand .rpc-card {
  padding: var(--nr-space-5); /* 24px */
  border: 1px solid var(--nr-border);
  border-radius: var(--nr-radius-md); /* 4px */
  background: var(--nr-surface);
}

.nullrpc-brand .rpc-input {
  color: var(--nr-text);
  background: var(--nr-surface-raised);
  border: 1px solid var(--nr-border-strong);
  border-radius: var(--nr-radius-sm); /* 2px */
}

.nullrpc-brand .rpc-primary {
  min-height: 44px;
  padding: var(--nr-space-3) var(--nr-space-5);
  color: var(--nr-button-text);
  background: var(--nr-button-bg);
  border: 0;
  border-radius: var(--nr-radius-md);
  font: 500 0.9375rem/1.25 var(--nr-font-sans);
}

.nullrpc-brand .rpc-eyebrow {
  color: var(--nr-text-secondary);
  font: 500 0.75rem/1.5 var(--nr-font-mono);
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
```

The stylesheet applies a **2px focus outline with a 3px offset** inside themed regions. Leave at least 6px of unclipped room around focusable controls. The ring must sit against a theme surface; the offset separates it from a button fill. Recheck if the surrounding background differs or an overflow container clips the outline. Do not remove visible keyboard focus.

### Shared dimensions and fonts

| Token | Value |
| --- | --- |
| `space-1` | 4px |
| `space-2` | 8px |
| `space-3` | 12px |
| `space-4` | 16px |
| `space-5` | 24px |
| `space-6` | 32px |
| `space-7` | 48px |
| `space-8` | 64px |
| `space-9` | 96px |
| `radius-sm` | 2px — inputs, chips, tags |
| `radius-md` | 4px — buttons, cards |
| `radius-lg` | 6px — large panels, dialogs (maximum) |
| `font-sans` | IBM Plex Sans, system sans fallbacks |
| `font-mono` | IBM Plex Mono, system mono fallbacks |

Corners are tight by design. Do not round beyond 6px and do not use pill shapes for buttons. IBM Plex Sans is bundled at 400, 500 and 600; IBM Plex Mono at 400 and 500. Request only those weights so the browser never synthesizes bold. See [typography.md](typography.md) for roles and sizes. The stylesheet leaves font sizes and component layout to the application.

Raw primitive CSS variables use `--nr-color-*`, for example `--nr-color-carbon`, `--nr-color-cobalt` and `--nr-color-deep-signal`. Use them for brand artwork; prefer semantic tokens in interfaces. Keep the JSON and CSS definitions aligned when changing the system and rerun the contrast checker.
