#!/usr/bin/env python3
"""Builds every SVG in docs/diagrams/.

Run from anywhere:

    python3 docs/diagrams/diagrams.py

Each diagram is a function below. Colors follow one legend everywhere:
blue = runs on our machines, orange = Cloudflare compute, green = storage,
grey = outside nullrpc, red = stops the pipeline.
"""

import html
import os

OUT = os.path.dirname(os.path.abspath(__file__))

STYLE = """
.bg{fill:#ffffff}.lb{fill:#ffffff}
.h{fill:#1f2328;font-weight:600}.t{fill:#1f2328}.s{fill:#59636e;font-size:12px}
.ln{stroke:#818b98;stroke-width:1.5;fill:none}.ln.d{stroke-dasharray:5 4}.ah{fill:#818b98}
.al{fill:#59636e;font-size:12px}
.n{fill:#f6f8fa;stroke:#d1d9e0}.ext{fill:#f6f8fa;stroke:#d1d9e0;stroke-dasharray:4 3}
.host{fill:#ddf4ff;stroke:#54aeff}.cf{fill:#fff1e5;stroke:#fb8f44}
.st{fill:#dafbe1;stroke:#4ac26b}.warn{fill:#ffebe9;stroke:#ff8182}
.grp{fill:none;stroke:#d1d9e0;stroke-dasharray:6 4}.gl{fill:#59636e;font-size:12px;font-weight:600}
@media (prefers-color-scheme: dark){
.bg,.lb{fill:#0d1117}
.h,.t{fill:#e6edf3}.s,.al,.gl{fill:#9198a1}
.ln{stroke:#656c76}.ah{fill:#656c76}
.n,.ext{fill:#151b23;stroke:#3d444d}
.host{fill:#0c2d6b;stroke:#1f6feb}.cf{fill:#3b1d0a;stroke:#db6d28}
.st{fill:#04260f;stroke:#2ea043}.warn{fill:#3c0d0d;stroke:#f85149}
.grp{stroke:#3d444d}
}
"""

LINE = 17  # line height of box text


def esc(s):
    return html.escape(s, quote=True)


def text_width(s, size=13):
    return len(s) * size * 0.56


class Diagram:
    def __init__(self, name, w, h):
        self.name, self.w, self.h = name, w, h
        self.boxes = {}
        self.back = []   # groups, drawn first
        self.lines = []  # arrows, drawn under boxes
        self.front = []  # boxes and labels

    # shapes

    def group(self, x, y, w, h, label):
        self.back.append(
            f'<rect class="grp" x="{x}" y="{y}" width="{w}" height="{h}" rx="12"/>'
            f'<text class="gl" x="{x + 14}" y="{y + 20}">{esc(label)}</text>'
        )

    def box(self, key, x, y, w, h, kind, title, sub=()):
        self.boxes[key] = (x, y, w, h)
        parts = [f'<rect class="{kind}" x="{x}" y="{y}" width="{w}" height="{h}" rx="8"/>']
        n = 1 + len(sub)
        cx, cy = x + w / 2, y + h / 2
        y0 = cy - (n - 1) * LINE / 2 + 4.5
        parts.append(f'<text class="h" x="{cx}" y="{y0}" text-anchor="middle">{esc(title)}</text>')
        for i, line in enumerate(sub, 1):
            parts.append(
                f'<text class="s" x="{cx}" y="{y0 + i * LINE}" text-anchor="middle">{esc(line)}</text>'
            )
        self.front.append("".join(parts))

    def node(self, key, cx, y, title, sub=(), kind="n", w=200, h=54):
        self.box(key, cx - w / 2, y, w, h, kind, title, sub)

    def text(self, x, y, s, cls="t", anchor="start"):
        self.front.append(f'<text class="{cls}" x="{x}" y="{y}" text-anchor="{anchor}">{esc(s)}</text>')

    def label(self, x, y, s):
        lines = s.split("\n")
        w = max(text_width(l, 12) for l in lines) + 10
        h = len(lines) * 15 + 4
        out = [f'<rect class="lb" x="{x - w / 2}" y="{y - h / 2}" width="{w}" height="{h}" rx="3"/>']
        for i, l in enumerate(lines):
            ly = y - (len(lines) - 1) * 7.5 + i * 15 + 4
            out.append(f'<text class="al" x="{x}" y="{ly}" text-anchor="middle">{esc(l)}</text>')
        self.front.append("".join(out))

    # arrows

    def anchor(self, key, side, off=0):
        x, y, w, h = self.boxes[key]
        return {
            "t": (x + w / 2 + off, y),
            "b": (x + w / 2 + off, y + h),
            "l": (x, y + h / 2 + off),
            "r": (x + w, y + h / 2 + off),
        }[side]

    def path(self, pts, label=None, dashed=False, at=None, lpos=None):
        d = "M" + " L".join(f"{x},{y}" for x, y in pts)
        cls = "ln d" if dashed else "ln"
        self.lines.append(f'<path class="{cls}" d="{d}" marker-end="url(#ah)"/>')
        if label:
            if lpos:
                lx, ly = lpos
            else:
                i = at if at is not None else (len(pts) - 1) // 2
                (x1, y1), (x2, y2) = pts[i], pts[i + 1]
                lx, ly = (x1 + x2) / 2, (y1 + y2) / 2
            self.label(lx, ly, label)

    def arrow(self, a, b, sa="b", sb="t", label=None, dashed=False, oa=0, ob=0,
              mid=None, at=None, lpos=None):
        x1, y1 = self.anchor(a, sa, oa)
        x2, y2 = self.anchor(b, sb, ob)
        if sa in "tb" and sb in "tb":
            if abs(x1 - x2) < 0.5:
                pts = [(x1, y1), (x2, y2)]
            else:
                my = mid if mid is not None else (y1 + y2) / 2
                pts = [(x1, y1), (x1, my), (x2, my), (x2, y2)]
        elif sa in "lr" and sb in "lr":
            if abs(y1 - y2) < 0.5:
                pts = [(x1, y1), (x2, y2)]
            else:
                mx = mid if mid is not None else (x1 + x2) / 2
                pts = [(x1, y1), (mx, y1), (mx, y2), (x2, y2)]
        elif sa in "lr":
            pts = [(x1, y1), (x2, y1), (x2, y2)]
        else:
            pts = [(x1, y1), (x1, y2), (x2, y2)]
        self.path(pts, label, dashed, at, lpos)

    def save(self):
        svg = (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {self.w} {self.h}" '
            f'width="{self.w}" height="{self.h}" '
            'font-family="-apple-system, BlinkMacSystemFont, \'Segoe UI\', Helvetica, Arial, sans-serif" '
            'font-size="13">\n'
            f"<style>{STYLE}</style>\n"
            '<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" '
            'markerHeight="7" orient="auto-start-reverse"><path class="ah" d="M0,0 L10,5 L0,10 z"/>'
            "</marker></defs>\n"
            f'<rect class="bg" width="{self.w}" height="{self.h}" rx="12"/>\n'
            + "\n".join(self.back + self.lines + self.front)
            + "\n</svg>\n"
        )
        with open(os.path.join(OUT, self.name + ".svg"), "w") as f:
            f.write(svg)


ROW = 90  # vertical distance between DAG rows


def r(i, top=30):
    return top + i * ROW


# README.md


def architecture():
    d = Diagram("architecture", 1120, 560)
    d.group(20, 40, 330, 410, "Live machine")
    d.group(500, 40, 600, 410, "Cloudflare")
    d.box("net", 45, 70, 280, 56, "ext", "Blockchain network", ["P2P · consensus"])
    d.box("node", 45, 170, 280, 64, "host", "Node", ["the chain's client, pruned"])
    d.box("daemon", 45, 280, 280, 64, "host", "nullrpc daemon", ["extract · verify · write · promote"])
    d.box("spool", 45, 384, 280, 48, "n", "Spool", ["local disk"])
    d.box("chain", 540, 90, 230, 64, "cf", "ChainDO", ["head · block records · witnesses"])
    d.box("shard", 540, 200, 230, 64, "cf", "StateShard × N", ["state diffs, P+1 … head"])
    d.box("r2", 540, 330, 230, 64, "st", "R2", ["immutable history, genesis … P"])
    d.box("worker", 850, 200, 220, 64, "cf", "RPC Worker", ["JSON-RPC, reads only"])
    d.box("clients", 850, 480, 220, 50, "ext", "Clients", ["wallets · apps · indexers"])
    d.box("b2", 540, 480, 230, 50, "st", "Backblaze B2", ["backup copy of R2"])
    d.arrow("net", "node", label="blocks")
    d.arrow("node", "daemon", label="local RPC")
    d.arrow("daemon", "spool")
    d.arrow("daemon", "chain", "r", "l", oa=-16, mid=365, at=2, label="blocks, witnesses")
    d.arrow("daemon", "shard", "r", "l", oa=0, mid=380, at=2, label="state diffs")
    d.arrow("daemon", "r2", "r", "l", oa=16, mid=395, at=2, label="promote")
    d.arrow("worker", "chain", "l", "r", oa=-16, mid=795)
    d.arrow("worker", "shard", "l", "r", label="reads")
    d.arrow("worker", "r2", "l", "r", oa=16, mid=825)
    d.arrow("clients", "worker", "t", "b", label="JSON-RPC")
    d.arrow("r2", "b2", label="copy", dashed=True)
    d.save()


def ranges():
    d = Diagram("ranges", 960, 210)
    x0, xp, xf, xh = 60, 600, 760, 900
    d.box("r2", x0, 70, xp - x0, 30, "st", "R2 · immutable generations")
    d.box("do", xp, 70, xh - xp, 30, "cf", "ChainDO + StateShards")
    d.box("node", 480, 130, xh - 480, 22, "host", "")
    d.text(480, 172, "Node: tip state and history within its prune distance", "s")
    for x, top, sub in [(x0, "genesis", ""), (xp, "P", "last promoted"),
                        (xf, "F", "finalized"), (xh, "head", "")]:
        d.lines.append(f'<path class="ln" d="M{x},52 L{x},118"/>')
        d.text(x, 30, top, "h", "middle")
        if sub:
            d.text(x, 45, sub, "s", "middle")
    d.text(xf + (xh - xf) / 2, 195, "reorgs happen only above F", "s", "middle")
    d.save()




# pipeline.md


def phases():
    d = Diagram("phases", 1000, 230)
    d.box("a", 30, 40, 280, 150, "n", "1 · Backfill",
          ["once, hourly machine", "archive snapshot → R2", "genesis … B", "done when HEAD = B"])
    d.box("b", 360, 40, 280, 150, "n", "2 · Prune",
          ["once", "pruned node from a snapshot", "check the state root at B",
           "delete the archive disk"])
    d.box("c", 690, 40, 280, 150, "n", "3 · Live",
          ["forever, monthly machine", "node → daemon → DOs", "promote finalized blocks to R2",
           "runs for as long as the chain is served"])
    d.arrow("a", "b", "r", "l")
    d.arrow("b", "c", "r", "l")
    d.save()


def spool():
    d = Diagram("spool", 1130, 240)
    xs = [20, 260, 500, 740, 980]
    names = [("tmp", "being written"), ("ready/", "on disk, durable"), ("live/", "visible in the DOs"),
             ("acked/", "in an R2 generation"), ("deleted", "after retention")]
    for i, (x, (t, s)) in enumerate(zip(xs, names)):
        d.box(f"s{i}", x, 50, 130, 56, "n", t, [s])
    d.box("orph", 500, 160, 130, 56, "warn", "orphaned/", ["removed by a reorg"])
    d.arrow("s0", "s1", "r", "l", label="fsync,\nrename")
    d.arrow("s1", "s2", "r", "l", label="shards and\nhead written")
    d.arrow("s2", "s3", "r", "l", label="HEAD moved\npast it")
    d.arrow("s3", "s4", "r", "l", label="7 days")
    d.arrow("s2", "orph", label="reorg")
    d.save()


# dags.md


def dag_backfill():
    d = Diagram("dag-backfill", 1000, r(8) + 84)
    d.node("b1", 500, r(0), "B1 · Restore snapshot", ["streamed into extraction"], "host")
    d.node("b2", 500, r(1), "B2 · Pick B", ["the node's finalized block"])
    d.node("b3", 500, r(2), "B3 · Block boundaries", ["transaction ranges per block"])
    d.node("b4", 170, r(3), "B4 · Block bundles", ["receipts root checked"])
    d.node("b5", 500, r(3), "B5 · State dump", ["every change, from files"])
    d.node("b6", 830, r(3), "B6 · Witnesses", ["prestateTracer, parallel"])
    w = 170
    d.node("b7", 100, r(4), "B7 · Hash index", w=w)
    d.node("b8", 290, r(4), "B8 · Log index", w=w)
    d.node("b9", 480, r(4), "B9 · State history", ["layers + filters"], w=w)
    d.node("b10", 670, r(4), "B10 · Root check", ["trie root = stateRoot"], w=w)
    d.node("b11", 870, r(4), "B11 · Witness check", ["sampled replays"], w=w)
    d.node("b12", 500, r(5), "B12 · Upload", ["multipart, SHA-256 checked"], "st")
    d.node("b13", 500, r(6), "B13 · Manifest", ["generation 1"], "st")
    d.node("b14", 500, r(7), "B14 · HEAD", ["create-if-absent"], "st")
    d.node("b15", 500, r(8), "B15 · Copy to B2", ["every object"], "st")
    for a, b in [("b1", "b2"), ("b2", "b3"), ("b3", "b4"), ("b3", "b5"), ("b3", "b6"),
                 ("b4", "b7"), ("b4", "b8"), ("b5", "b9"), ("b5", "b10"), ("b6", "b11"),
                 ("b7", "b12"), ("b8", "b12"), ("b9", "b12"), ("b10", "b12"), ("b11", "b12"),
                 ("b12", "b13"), ("b13", "b14"), ("b14", "b15")]:
        d.arrow(a, b)
    d.save()


def dag_handoff():
    d = Diagram("dag-handoff", 700, r(5, 30) + 84)
    d.node("h1", 180, r(0), "H1 · Backfill done", ["HEAD = B"], "st", w=240)
    d.node("h2", 520, r(0), "H2 · Restore live node", ["pruned snapshot, new datadir"], "host", w=240)
    d.node("h3", 520, r(1), "H3 · Live node synced", ["past block B+1"], "host", w=240)
    d.node("h4", 350, r(2), "H4 · Check state root at B", ["live node = header B"], w=260)
    d.node("h5", 350, r(3), "H5 · Start daemon at B+1", ["writes the DOs from B+1"], "host", w=260)
    d.node("h6", 350, r(4), "H6 · Daemon at head", ["live window complete"], "host", w=260)
    d.node("h7", 350, r(5), "H7 · Delete archive", ["release the backfill machine"], w=260)
    d.arrow("h1", "h4", ob=-60)
    d.arrow("h2", "h3")
    d.arrow("h3", "h4", ob=60)
    d.arrow("h4", "h5")
    d.arrow("h5", "h6")
    d.arrow("h6", "h7")
    d.save()


def dag_block():
    d = Diagram("dag-block", 1000, r(9) + 84)
    d.node("k1", 500, r(0), "K1 · New head", ["newHeads, or a poll"], "host")
    d.node("k2", 500, r(1), "K2 · Parent check", ["parent = spooled head?"], w=220)
    d.node("rg", 850, r(1), "Reorg DAG", ["mismatch"], "warn", w=180)
    w = 210
    d.node("k3", 125, r(2), "K3 · Block", ["eth_getBlockByNumber"], w=w)
    d.node("k4", 375, r(2), "K4 · Receipts", ["eth_getBlockReceipts"], w=w)
    d.node("k5", 625, r(2), "K5 · Pre-state", ["prestateTracer"], w=w)
    d.node("k6", 875, r(2), "K6 · Diff", ["prestateTracer, diffMode"], w=w)
    d.node("k7", 500, r(3), "K7 · Verify", ["header hash · tx root · receipts root"], w=300)
    d.node("k8", 500, r(4), "K8 · Assemble", ["record · witness · diff per shard"], w=300)
    d.node("k9", 500, r(5), "K9 · Spool", ["tmp, fsync, rename to ready/"], w=300)
    d.node("k10", 300, r(6), "K10 · StateShard rows", ["applyMany, in parallel"], "cf", w=240)
    d.node("k11", 700, r(6), "K11 · ChainDO row", ["record + witness"], "cf", w=240)
    d.node("k12", 500, r(7), "K12 · Move head", ["ChainDO, after every row"], "cf", w=300)
    d.node("k13", 500, r(8), "K13 · Spool to live/", w=300)
    d.node("k14", 500, r(9), "K14 · Promotion check", ["F ≥ P + batch → promotion DAG"], w=300)
    d.arrow("k1", "k2")
    d.arrow("k2", "rg", "r", "l", label="mismatch")
    for k in ["k3", "k4", "k5", "k6"]:
        d.arrow("k2", k)
        d.arrow(k, "k7")
    for a, b in [("k7", "k8"), ("k8", "k9"), ("k9", "k10"), ("k9", "k11"), ("k10", "k12"),
                 ("k11", "k12"), ("k12", "k13")]:
        d.arrow(a, b)
    d.arrow("k13", "k14", dashed=True)
    d.save()


def dag_promotion():
    d = Diagram("dag-promotion", 1000, r(8) + 84)
    d.node("p1", 500, r(0), "P1 · Trigger", ["F ≥ P + batch, or the batch is 2 h old"], w=300)
    d.node("p2", 500, r(1), "P2 · Read spool live/", ["blocks P+1 … P′, parent links"], "host", w=300)
    w = 170
    d.node("p3", 100, r(2), "P3 · Bundle", ["blocks + offsets"], "host", w=w)
    d.node("p4", 295, r(2), "P4 · Hash index", ["delta + merges"], "host", w=w)
    d.node("p5", 490, r(2), "P5 · Log index", ["delta + merges"], "host", w=w)
    d.node("p6", 685, r(2), "P6 · State layer", ["delta + merges"], "host", w=w)
    d.node("p7", 880, r(2), "P7 · Witness pack", ["one frame per block"], "host", w=w)
    d.node("p8", 500, r(3), "P8 · Upload", ["create-if-absent"], "st", w=300)
    d.node("p9", 500, r(4), "P9 · Manifest", ["generation N"], "st", w=300)
    d.node("p10", 500, r(5), "P10 · Move HEAD", ["If-Match on N−1"], "st", w=300)
    d.node("stop", 850, r(5), "Stop and alert", ["ETag changed"], "warn", w=180)
    d.node("p11", 300, r(6), "P11 · Prune StateShards", ["pruneAtOrBelow(P′)"], "cf", w=240)
    d.node("p12", 700, r(6), "P12 · Prune ChainDO", ["rows ≤ P′, set P = P′"], "cf", w=240)
    d.node("p13", 500, r(7), "P13 · Spool to acked/", w=300)
    d.node("p14", 300, r(8), "P14 · Copy to B2", ["new objects"], "st", w=240)
    d.node("p15", 700, r(8), "P15 · Schedule GC", ["unreferenced, after 7 days"], "st", w=240)
    d.arrow("p1", "p2")
    for k in ["p3", "p4", "p5", "p6", "p7"]:
        d.arrow("p2", k)
        d.arrow(k, "p8")
    d.arrow("p8", "p9")
    d.arrow("p9", "p10")
    d.arrow("p10", "stop", "r", "l", label="conflict")
    for a, b in [("p10", "p11"), ("p10", "p12"), ("p11", "p13"), ("p12", "p13"),
                 ("p13", "p14"), ("p13", "p15")]:
        d.arrow(a, b)
    d.save()


def dag_reorg():
    d = Diagram("dag-reorg", 800, r(6) + 84)
    w = 300
    d.node("g1", 300, r(0), "G1 · Parent mismatch", ["at block n"], w=w)
    d.node("g2", 300, r(1), "G2 · Find ancestor A", ["walk back on the node"], "host", w=w)
    d.node("stop", 640, r(1), "Stop and alert", ["A < F"], "warn", w=200)
    d.node("g3", 300, r(2), "G3 · Fence", ["fence(removed) on every shard"], "cf", w=w)
    d.node("g4", 300, r(3), "G4 · Lower head", ["ChainDO head = A"], "cf", w=w)
    d.node("g5", 300, r(4), "G5 · Truncate", ["truncateAbove(A), shards and ChainDO"], "cf", w=w)
    d.node("g6", 300, r(5), "G6 · Spool", ["removed blocks to orphaned/"], "host", w=w)
    d.node("g7", 300, r(6), "G7 · Apply new branch", ["block DAG, A+1 … new head"], w=w)
    for a, b in [("g1", "g2"), ("g2", "g3"), ("g3", "g4"), ("g4", "g5"), ("g5", "g6"), ("g6", "g7")]:
        d.arrow(a, b)
    d.arrow("g2", "stop", "r", "l", label="below F")
    d.save()


# storage.md


def r2_layout():
    d = Diagram("r2-layout", 780, 350)
    d.box("head", 20, 140, 160, 60, "st", "HEAD.json", ["mutable, If-Match"])
    d.box("man", 240, 140, 180, 60, "st", "Manifest N", ["names every object"])
    d.box("prev", 240, 260, 180, 56, "ext", "Manifest N−1", ["older generation"])
    items = [("Block bundles", "blocks.pack · offsets.bin"), ("Hash index", "tx and block hashes"),
             ("Log index", "address and topic postings"), ("State history", "accounts · storage · code"),
             ("Witnesses", "pre-state per block")]
    for i, (t, s) in enumerate(items):
        d.box(f"o{i}", 520, 20 + i * 64, 240, 52, "st", t, [s])
        d.arrow("man", f"o{i}", "r", "l", mid=470)
    d.arrow("head", "man", "r", "l")
    d.arrow("man", "prev", label="previous", dashed=True)
    d.save()


def do_layout():
    d = Diagram("do-layout", 940, 330)
    d.box("daemon", 20, 130, 180, 60, "host", "nullrpc daemon", ["the only writer"])
    d.box("chain", 330, 30, 270, 80, "cf", "ChainDO",
          ["blocks(number, part, hash, data)", "kv: head · F · P"])
    d.group(320, 140, 290, 170, "keccak256(address)[0] mod N")
    for i, t in enumerate(["StateShard 0", "StateShard 1", "StateShard N−1"]):
        d.box(f"s{i}", 340, 172 + i * 44, 250, 34, "cf", t)
    d.box("worker", 720, 130, 190, 60, "cf", "RPC Worker", ["pinned reads"])
    d.arrow("daemon", "chain", "r", "l", mid=265, label="block rows")
    d.arrow("daemon", "s1", "r", "l", mid=265, label="diff rows")
    d.arrow("worker", "chain", "l", "r", mid=665)
    d.arrow("worker", "s1", "l", "r", mid=665, label="reads")
    d.save()


def read_path():
    d = Diagram("read-path", 900, 400)
    d.box("q", 330, 20, 240, 50, "n", "State read (key, n)")
    d.box("p", 330, 110, 240, 50, "n", "n ≤ P ?")
    d.box("hist", 40, 210, 260, 56, "st", "R2 history at n", ["2 reads in the newest layer with the key"])
    d.box("shard", 600, 210, 260, 56, "cf", "StateShard.getPinned", ["row in P+1 … n → value"])
    d.box("histp", 320, 320, 260, 56, "st", "R2 history at P", ["the key is unchanged since P"])
    d.box("retry", 600, 320, 260, 56, "warn", "Refresh head, retry", ["the pin was reorged away"])
    d.arrow("q", "p")
    d.arrow("p", "hist", "l", "t", label="yes")
    d.arrow("p", "shard", "r", "t", label="no")
    d.arrow("shard", "histp", "l", "r", oa=14, mid=590, label="no row", lpos=(590, 300))
    d.arrow("shard", "retry", label="stale")
    d.save()


# infrastructure.md


def infrastructure():
    d = Diagram("infrastructure", 1000, 400)
    d.group(20, 30, 300, 160, "Hourly, during the backfill")
    d.box("bf", 45, 70, 250, 96, "host", "Backfill machine",
          ["archive snapshot on local NVMe", "dumper and tracer", "released after HEAD = B"])
    d.group(20, 220, 300, 160, "Monthly")
    d.box("live", 45, 260, 250, 96, "host", "Live machine",
          ["pruned node", "nullrpc daemon and spool", "RAID 1 NVMe"])
    d.group(420, 30, 330, 250, "Cloudflare")
    d.box("r2", 445, 70, 280, 56, "st", "R2", ["the archive"])
    d.box("do", 445, 180, 280, 56, "cf", "ChainDO + StateShards", ["the live window"])
    d.box("b2", 445, 320, 280, 56, "st", "Backblaze B2", ["backup"])
    d.arrow("bf", "r2", "r", "l", label="archive upload")
    d.arrow("live", "do", "r", "l", mid=370, label="live writes", at=0)
    d.path([(250, 260), (250, 200), (395, 200), (395, 110), (445, 110)], label="promotion", lpos=(395, 155))
    d.path([(725, 98), (745, 98), (745, 348), (725, 348)], label="copy", dashed=True, at=1)
    d.save()


if __name__ == "__main__":
    for f in [architecture, ranges, phases, spool, dag_backfill, dag_handoff, dag_block,
              dag_promotion, dag_reorg, r2_layout, do_layout, read_path, infrastructure]:
        f()
    print("wrote", len([n for n in os.listdir(OUT) if n.endswith(".svg")]), "diagrams to", OUT)
