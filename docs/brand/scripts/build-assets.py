#!/usr/bin/env python3
"""Rebuild nullrpc's portable, outlined SVG artwork from local fonts.

Requires Python 3 and fonttools. No network calls; run from any directory.
Raster exports are produced separately by render-assets.cjs.
"""
from pathlib import Path
from html import escape
from functools import lru_cache
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'assets'
OUT.mkdir(exist_ok=True)

# Palette — see ../color.md.
CARBON, SURFACE, RAISED = '#0A0D12', '#11151C', '#181D26'
PAPER, WHITE = '#F2F4F7', '#FFFFFF'
MIST, SLATE = '#9BA5B4', '#4A5565'
SIGNAL, DEEP = '#5B8CFF', '#1F4FD1'
LINE_DARK, LINE_LIGHT = '#232A35', '#D5DBE3'
GRID_DARK = '#151A22'
VERIFIED = '#3DD68C'

# The seal: a square enclosure cut along the null diagonal (x + y = 96) into two
# interlocking halves. The centre is left empty. Native 96-unit grid, 12-unit stroke.
SEAL_A = 'M12 12H74L62 24H24V62L12 74Z'
SEAL_B = 'M84 84H22L34 72H72V34L84 22Z'
# Optical master for 16–23 px: whole-pixel 2-unit stroke on a 16-unit grid.
SEAL_SMALL = 'M1 1H13L11 3H3V11L1 13ZM15 15H3L5 13H13V5L15 3Z'


@lru_cache(None)
def font(weight='SemiBold', mono=False):
    family = 'IBMPlexMono' if mono else 'IBMPlexSans'
    return TTFont(ROOT / 'fonts' / f'{family}-{weight}.woff')


def text_width(s, size, weight='Medium', mono=False, tracking=0):
    f = font(weight, mono)
    cmap, scale = f.getBestCmap(), size / f['head'].unitsPerEm
    return sum(f['hmtx'][cmap[ord(c)]][0] * scale + tracking for c in s) - tracking


def label(s, x, y, size, fill=CARBON, weight='Medium', mono=False, tracking=0, anchor='start'):
    """Outline text to eliminate font-installation dependence in exported SVGs."""
    f = font(weight, mono)
    glyphs, cmap = f.getGlyphSet(), f.getBestCmap()
    scale = size / f['head'].unitsPerEm
    if anchor == 'end':
        x -= text_width(s, size, weight, mono, tracking)
    parts = []
    for char in s:
        name = cmap[ord(char)]
        pen = SVGPathPen(glyphs)
        glyphs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, x, y)))
        path = pen.getCommands()
        if path:
            parts.append(f'<path d="{path}"/>')
        x += f['hmtx'][name][0] * scale + tracking
    return f'<g fill="{fill}" aria-label="{escape(s, quote=True)}">' + ''.join(parts) + '</g>'


def mark(color=SIGNAL, x=0, y=0, scale=1):
    return f'<g fill="{color}" transform="translate({x} {y}) scale({scale})"><path d="{SEAL_A}"/><path d="{SEAL_B}"/></g>'


def wordmark(ink, x, y, size=72):
    return label('nullrpc', x, y, size, ink, 'SemiBold', tracking=-1.5)


def logo(ink=PAPER, accent=SIGNAL, x=0, y=0, scale=1):
    # 440 x 112 master: symbol tile at (8, 8), wordmark baseline aligned to the seal's base.
    return f'<g transform="translate({x} {y}) scale({scale})">' + mark(accent, 8, 8) + wordmark(ink, 124, 84, 76) + '</g>'


def rect(x, y, w, h, fill, rx=0, extra=''):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" {extra}/>'


def line(x1, y1, x2, y2, color, width=1, dash=''):
    d = f' stroke-dasharray="{dash}"' if dash else ''
    return f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{color}" stroke-width="{width}"{d}/>'


def grid(w, h, step, color, x0=0, y0=0):
    """Hairline engineering grid used as the quiet background texture."""
    d = ''.join(f'M{x} {y0}V{y0 + h}' for x in range(x0, x0 + w + 1, step))
    d += ''.join(f'M{x0} {y}H{x0 + w}' for y in range(y0, y0 + h + 1, step))
    return f'<path d="{d}" stroke="{color}" stroke-width="1" fill="none"/>'


def eyebrow(s, x, y, color, size=14):
    return label(s.upper(), x, y, size, color, 'Medium', mono=True, tracking=1.6)


def save(name, w, h, content, title, desc='Official nullrpc identity artwork. Lettering is outlined for portable rendering.'):
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" role="img" aria-labelledby="title desc"><title id="title">{escape(title)}</title><desc id="desc">{escape(desc)}</desc>{content}</svg>\n'
    (OUT / f'{name}.svg').write_text(svg)


for name, ink, accent in [('dark', PAPER, SIGNAL), ('light', CARBON, DEEP), ('mono-dark', CARBON, CARBON), ('mono-light', WHITE, WHITE)]:
    save(f'logo-{name}', 440, 112, logo(ink, accent), f'nullrpc — {name} horizontal logo')
for name, color in [('signal', SIGNAL), ('deep', DEEP), ('dark', CARBON), ('light', WHITE)]:
    save(f'mark-{name}', 96, 96, mark(color), f'nullrpc — {name} symbol')
for name, color in [('dark', PAPER), ('light', CARBON)]:
    save(f'wordmark-{name}', 320, 104, wordmark(color, 12, 74, 76), f'nullrpc — {name} wordmark')

save('mark-small', 16, 16, f'<g fill="{SIGNAL}"><path d="{SEAL_SMALL}"/></g>', 'nullrpc — optical small symbol')
save('favicon', 32, 32, rect(0, 0, 32, 32, CARBON, 4) + f'<g fill="{SIGNAL}" transform="translate(4 4) scale(1.5)"><path d="{SEAL_SMALL}"/></g>', 'nullrpc favicon')
save('avatar', 512, 512, rect(0, 0, 512, 512, CARBON) + mark(SIGNAL, 112, 112, 3), 'nullrpc avatar', 'Cobalt seal symbol on a carbon square. Safe within circular avatar crops.')

# Engineering grid with the seal as a faint registration mark.
pattern = rect(0, 0, 1600, 480, CARBON) + grid(1600, 480, 40, GRID_DARK)
pattern += mark(LINE_DARK, 680, 0, 5)
save('pattern', 1600, 480, pattern, 'nullrpc grid background')


def card_footer(y, ink, muted, rule, x0, x1, items):
    out = line(x0, y - 52, x1, y - 52, rule)
    step = (x1 - x0) / len(items)
    for i, (k, v) in enumerate(items):
        out += eyebrow(k, x0 + i * step, y - 18, muted, 13) + label(v, x0 + i * step, y + 14, 22, ink)
    return out


social = rect(0, 0, 1200, 630, CARBON) + grid(1200, 630, 30, GRID_DARK)
social += logo(PAPER, SIGNAL, 60, 48, .5)
social += label('nullrpc.dev', 1140, 86, 18, MIST, 'Regular', mono=True, anchor='end')
social += eyebrow('RPC infrastructure', 68, 220, SIGNAL)
social += label('Affordable RPC.', 64, 312, 80, PAPER, 'SemiBold', tracking=-2)
social += label('Fair pricing. Privacy in focus.', 68, 368, 26, MIST, 'Regular')
social += card_footer(552, PAPER, MIST, LINE_DARK, 68, 1132, [('01', 'Fair pricing'), ('02', 'Privacy in focus')])
save('social-card', 1200, 630, social, 'nullrpc — Affordable RPC.', 'Fair pricing. Privacy in focus.')

banner = rect(0, 0, 1600, 480, PAPER) + grid(1600, 480, 40, '#E7EBF0')
banner += logo(CARBON, DEEP, 72, 44, .5)
banner += eyebrow('RPC infrastructure', 80, 196, DEEP)
banner += label('Affordable RPC.', 76, 290, 96, CARBON, 'SemiBold', tracking=-2)
banner += label('Fair pricing. Privacy in focus.', 80, 352, 28, SLATE, 'Regular')
banner += label('nullrpc.dev', 80, 424, 17, SLATE, 'Regular', mono=True)
banner += mark(DEEP, 1236, 96, 3)
save('banner', 1600, 480, banner, 'nullrpc documentation banner')

clear = rect(0, 0, 960, 320, PAPER)
clear += rect(86, 80, 488, 160, 'none', extra=f'stroke="{DEEP}" stroke-dasharray="4 4"')
clear += logo(CARBON, DEEP, 110, 104)
clear += line(86, 63, 110, 63, DEEP) + line(86, 57, 86, 69, DEEP) + line(110, 57, 110, 69, DEEP)
clear += label('x', 94, 49, 16, DEEP, 'Regular', mono=True)
clear += label('Give the identity room.', 624, 124, 22, CARBON, 'SemiBold')
clear += label('x = 24 units', 624, 164, 16, SLATE, 'Regular', mono=True)
clear += label('¼ of the symbol tile', 624, 194, 16, SLATE, 'Regular')
clear += label('Keep x outside the SVG bounds.', 624, 224, 14, SLATE, 'Regular')
save('clearspace', 960, 320, clear, 'nullrpc logo clear space', 'Leave at least one quarter of the 96-unit symbol tile outside the logo SVG bounds, on every side.')

board = rect(0, 0, 1600, 1200, PAPER)
board += rect(0, 0, 1600, 492, CARBON) + grid(1600, 492, 41, GRID_DARK)
board += eyebrow('nullrpc / identity system', 64, 62, MIST)
board += logo(PAPER, SIGNAL, 54, 120, 1.4)
board += label('Affordable RPC.', 70, 370, 64, PAPER, 'SemiBold', tracking=-1.5)
board += label('Fair pricing. Privacy in focus.', 72, 422, 23, MIST, 'Regular')
board += mark(SIGNAL, 1210, 120, 2.7)
board += eyebrow('01 / The identity', 64, 548, SLATE)
board += logo(CARBON, DEEP, 50, 589, .95)
board += rect(548, 582, 478, 146, CARBON)
board += logo(WHITE, WHITE, 568, 599, .9)
board += mark(CARBON, 1125, 605, 1.0) + mark(DEEP, 1270, 620, .65) + mark(DEEP, 1390, 634, .36)
board += eyebrow('02 / Color', 64, 800, SLATE)
colors = [('Carbon', CARBON), ('Paper', PAPER), ('Signal', SIGNAL), ('Deep signal', DEEP), ('Mist', MIST), ('Slate', SLATE)]
for i, (name, color) in enumerate(colors):
    x = 64 + i * 247
    board += rect(x, 829, 230, 100, color, 2, f'stroke="{LINE_LIGHT}" stroke-width="1"' if color == PAPER else '')
    board += label(name, x, 958, 18, CARBON) + label(color, x, 985, 13, SLATE, 'Regular', mono=True)
board += line(64, 1027, 1536, 1027, LINE_LIGHT)
board += eyebrow('03 / Type', 64, 1071, SLATE)
board += label('IBM Plex Sans', 64, 1141, 46, CARBON, 'SemiBold', tracking=-.5)
board += label('IBM Plex Mono', 714, 1124, 27, CARBON, 'Medium', mono=True)
board += label('eth_getBalance  0x01  { }', 716, 1165, 18, SLATE, 'Regular', mono=True)
save('brand-board', 1600, 1200, board, 'nullrpc identity overview', 'Brand overview showing the primary and monochrome logos, palette, and type families.')

print(f'Wrote {len(list(OUT.glob("*.svg")))} SVG assets to {OUT}')
