# Bundled typefaces

These files are local so the visual guide, the token CSS and the asset generator work offline. They are redistributed unchanged with their SIL Open Font License notices. The identity uses one superfamily, IBM Plex.

| File | Format | Role | Source |
|---|---|---|---|
| `IBMPlexSans-Regular` | `.woff2`, `.woff` | Sans 400: reading text | npm [`@ibm/plex-sans`](https://www.npmjs.com/package/@ibm/plex-sans) 1.1.0 (font version 3.005) |
| `IBMPlexSans-Medium` | `.woff2`, `.woff` | Sans 500: UI labels, headings, card text | same |
| `IBMPlexSans-SemiBold` | `.woff2`, `.woff` | Sans 600: headlines; the wordmark is outlined from this weight | same |
| `IBMPlexMono-Regular` | `.woff2`, `.woff` | Mono 400: code, hashes, methods, numeric data | npm [`@ibm/plex-mono`](https://www.npmjs.com/package/@ibm/plex-mono) 2.5.0 (font version 2.005) |
| `IBMPlexMono-Medium` | `.woff2`, `.woff` | Mono 500: uppercase eyebrow labels | same |

Upstream project: [IBM Plex](https://github.com/IBM/plex). Keep [IBMPlexSans-OFL.txt](IBMPlexSans-OFL.txt) and [IBMPlexMono-OFL.txt](IBMPlexMono-OFL.txt) with any redistributed font file. "Plex" is a Reserved Font Name under the license: do not modify these files and redistribute them under the Plex name. No font binaries have been edited.

**Which format is used where.** The `.woff2` files are for the web: [tokens/brand.css](../tokens/brand.css) and the [visual guide](../index.html) load them. The `.woff` files exist for [build-assets.py](../scripts/build-assets.py), which reads glyph outlines with fontTools (fontTools reads WOFF without the optional Brotli dependency that WOFF2 needs). Exported logos and cards contain outlined paths and do not request fonts at runtime.

Only the five weights above are bundled. Do not request other weights or italics from these families in an interface; the browser would synthesize them.
