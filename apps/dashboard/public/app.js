// nullrpc status. No framework: DOM built with textContent only
// (API strings such as method names and error messages are untrusted); charts use vendored Chart.js,
// sparklines are hand-written SVG.
"use strict";

const STATUS_POLL_MS = 2_000;
const ANALYTICS_POLL_MS = 15_000;
const HISTORY_POLL_MS = 60_000; // the live pipeline samples once a minute (GET /api/history)
const RATE_WINDOW_MS = 5 * 60_000; // average over minutes
const STALE_MS = 10_000; // live indicator turns amber without a successful poll for this long
const SVG_NS = "http://www.w3.org/2000/svg";

const state = {
  chains: [],
  analyticsEnabled: false,
  chain: "all",
  range: "1h",
  status: new Map(), // id -> {data, error, at}
  history: new Map(), // id -> {points: [{t, executed, target, lag, rate}], bucket_s, from, to} from /api/history
  analytics: null,
  analyticsError: null,
  lastOk: 0,
  lastError: null,
};

// ---------------------------------------------------------------- helpers

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
function s(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
  return el;
}
/** Static SVG icon from path data (constants only). */
function icon(d) {
  const svg = s("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" });
  svg.append(s("path", { d, fill: "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round" }));
  return svg;
}
const ICONS = {
  cpu: "M9 3v2M15 3v2M9 19v2M15 19v2M3 9h2M3 15h2M19 9h2M19 15h2M7 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Zm3 5h4v4h-4z",
  net: "M12 3a3 3 0 1 1 0 6 3 3 0 0 1 0-6ZM5 15a3 3 0 1 1 0 6 3 3 0 0 1 0-6Zm14 0a3 3 0 1 1 0 6 3 3 0 0 1 0-6ZM10.5 8.6 6.5 15.4M13.5 8.6l4 6.8M8 18h8",
  upload: "M12 16V4m0 0-4 4m4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2",
  sync: "M20 11a8 8 0 0 0-14.9-3M4 5v3h3M4 13a8 8 0 0 0 14.9 3M20 19v-3h-3",
  alert: "M12 9v4m0 4h.01M10.3 3.9 2.6 17.2A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.8L13.7 3.9a2 2 0 0 0-3.4 0Z",
  hash: "M5 9h14M5 15h14M10 4 8 20M16 4l-2 16",
};

const nf = new Intl.NumberFormat("en-US");
const fmtInt = (n) => (n == null || !Number.isFinite(n) ? "–" : nf.format(Math.round(n)));
function fmtCompact(n) {
  if (n == null || !Number.isFinite(n)) return "–";
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(a >= 1e10 ? 0 : 1)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(a >= 1e5 ? 0 : 1)}k`;
  if (a >= 100 || Number.isInteger(n)) return nf.format(Math.round(n));
  return n.toFixed(a >= 10 ? 1 : 2);
}
const fmtMs = (n) => (n == null || !Number.isFinite(n) ? "–" : n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${Math.round(n)} ms`);
const pct = (a, b) => (b > 0 ? (100 * a) / b : null);
const fmtPct = (p) => (p == null ? "–" : `${p >= 10 || p === 0 ? p.toFixed(1) : p.toFixed(2)}%`);
const short = (hash) => (typeof hash === "string" && hash.length > 14 ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : hash || "–");
function agoText(ms) {
  if (!ms) return "–";
  const d = Math.round((Date.now() - ms) / 1000);
  if (d < -5) return `in ${dur(-d)}`;
  if (d < 2) return "just now";
  return `${dur(d)} ago`;
}
function dur(sec) {
  if (sec < 90) return `${Math.round(sec)}s`;
  if (sec < 5400) return `${Math.round(sec / 60)} min`;
  if (sec < 172800) return `${(sec / 3600).toFixed(1)} h`;
  return `${(sec / 86400).toFixed(1)} d`;
}
/** A relative time that the 1 s ticker keeps current. */
function ago(ms) {
  return h("span", { class: "ago", "data-at": ms || "" }, agoText(ms));
}
const get = (o, path) => path.split(".").reduce((x, k) => (x == null ? undefined : x[k]), o);
const chainName = (id) => state.chains.find((c) => c.id === id)?.name || `Network ${id}`;
const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);

function pill(level, label) {
  return h("span", { class: `pill s-${level}` }, h("span", { class: "dot", "aria-hidden": "true" }), label);
}
function kv(rows) {
  return h("dl", { class: "kv" }, rows.filter(Boolean).flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]));
}
function widthBar(fraction, cls) {
  const d = h("div", { class: cls || "bar" });
  d.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
  return d;
}
function cardHead(title, iconPath, right) {
  return h("div", { class: "card-head" },
    h("div", { class: "card-title" }, iconPath ? h("span", { class: "card-icon" }, icon(iconPath)) : null, h("h3", {}, title)),
    right || null);
}
/**
 * Footer line with the age of a component's snapshot: amber once it is older than `okMs`
 * (the component's expected refresh interval plus slack), red after four times that.
 */
function freshness(label, at, okMs = 30_000) {
  const el = h("div", { class: "fresh" }, h("span", {}, label), h("span", { class: "age", "data-at": at || "", "data-fresh": String(okMs) }, agoText(at)));
  paintAge(el.lastChild);
  return el;
}
function paintAge(el) {
  const at = Number(el.dataset.at);
  const ok = Number(el.dataset.fresh) || 30_000;
  const age = at ? Date.now() - at : Infinity;
  el.classList.toggle("old", age > ok && age <= 4 * ok);
  el.classList.toggle("dead", age > 4 * ok);
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store" });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { ok: res.ok, status: res.status, body };
}

// ---------------------------------------------------------------- tooltip

const tooltip = () => document.getElementById("tooltip");
function showTooltip(x, y, title, rows) {
  const t = tooltip();
  t.replaceChildren(h("div", { class: "t" }, title), ...rows.map(([color, value, label]) =>
    h("div", { class: "row" }, color ? h("span", { class: `key line ${color}` }) : null, h("strong", {}, value), h("span", {}, label))));
  t.hidden = false;
  const r = t.getBoundingClientRect();
  const left = Math.min(window.innerWidth - r.width - 8, x + 14);
  const top = Math.max(8, Math.min(window.innerHeight - r.height - 8, y - r.height - 10));
  t.style.left = `${Math.max(8, left)}px`;
  t.style.top = `${top}px`;
}
function hideTooltip() { tooltip().hidden = true; }

// ---------------------------------------------------------------- charts (Chart.js)

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
function rgba(color, a) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  return m ? `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})` : color;
}
const seriesColor = (cls) => css(`--${cls.replace("c", "series-")}`);

let chartLoad = null;
function loadChartJs() {
  if (chartLoad) return chartLoad;
  const fonts = document.fonts?.load ? document.fonts.load('500 12px "IBM Plex Sans"').catch(() => {}) : Promise.resolve();
  const script = new Promise((resolve, reject) => {
    if (window.Chart) return resolve(window.Chart);
    const el = document.createElement("script");
    el.src = "/vendor/chart.umd.min.js";
    el.onload = () => (window.Chart ? resolve(window.Chart) : reject(new Error("Chart.js")));
    el.onerror = () => { chartLoad = null; reject(new Error("Chart.js")); };
    document.head.append(el);
  });
  chartLoad = Promise.all([script, fonts]).then(([Chart]) => Chart);
  return chartLoad;
}

// Sections re-render on every poll: charts whose canvas left the page are destroyed.
const liveCharts = new Set();
function sweepCharts() {
  for (const c of liveCharts) if (!c.canvas.isConnected) { c.destroy(); liveCharts.delete(c); }
}

const crosshair = {
  id: "crosshair",
  afterDatasetsDraw(chart) {
    const active = chart.tooltip?.getActiveElements();
    if (!active?.length) return;
    const { ctx, chartArea: area } = chart;
    const x = active[0].element.x;
    ctx.save();
    ctx.strokeStyle = rgba(css("--accent"), 0.5);
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, area.top);
    ctx.lineTo(x, area.bottom);
    ctx.stroke();
    ctx.restore();
  },
};

/**
 * Line chart with one y axis. series: [{label, cls, values, area?}] sharing `xs` (unix s).
 * Drawn after insertion (`_draw`), with Chart.js: hover shows every series at that time.
 */
function lineChart(opts) {
  const canvas = h("canvas", { role: "img", "aria-label": opts.title });
  const wrap = h("div", { class: "chart" }, h("div", { class: "chart-box" + (opts.height && opts.height < 200 ? " chart-box-sm" : "") }, canvas));
  wrap._draw = () => drawLineChart(opts, canvas);
  return wrap;
}

async function drawLineChart({ xs, series, fmt, rangeS }, canvas) {
  let Chart;
  try {
    Chart = await loadChartJs();
  } catch {
    canvas.replaceWith(h("p", { class: "hint" }, "Could not load the chart."));
    return;
  }
  sweepCharts();
  if (!canvas.isConnected) return;
  const tickFmt = (t) => {
    const d = new Date(t * 1000);
    return rangeS > 2 * 86400 ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  };
  const chart = new Chart(canvas, {
    type: "line",
    data: {
      datasets: series.map((se) => {
        const color = seriesColor(se.cls);
        return {
          label: se.label,
          data: se.values.map((v, i) => ({ x: xs[i], y: Number.isFinite(v) ? v : null })),
          parsing: false,
          borderColor: color,
          borderWidth: 2,
          tension: 0.35,
          spanGaps: !se.breakGaps,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHoverBackgroundColor: color,
          pointHoverBorderColor: css("--page"),
          pointHoverBorderWidth: 2,
          fill: se.area ? "origin" : false,
          backgroundColor: (ctx) => {
            const area = ctx.chart.chartArea;
            if (!area || !se.area) return "transparent";
            const g = ctx.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
            g.addColorStop(0, rgba(color, 0.35));
            g.addColorStop(1, rgba(color, 0));
            return g;
          },
        };
      }),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false, // redrawn on every poll
      interaction: { mode: "index", intersect: false },
      layout: { padding: { top: 8 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: css("--surface"),
          borderColor: css("--border"),
          borderWidth: 1,
          titleColor: css("--muted"),
          bodyColor: css("--ink"),
          titleFont: { family: css("--font"), size: 12, weight: "normal" },
          bodyFont: { family: css("--font"), size: 13, weight: "600" },
          padding: 10,
          cornerRadius: 8,
          boxWidth: 8,
          boxHeight: 8,
          usePointStyle: true,
          callbacks: {
            title: (items) => (items.length ? new Date(items[0].parsed.x * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: rangeS <= 3600 ? "2-digit" : undefined }) : ""),
            label: (item) => `${fmt(item.parsed.y)} ${series[item.datasetIndex].label}`,
            labelColor: (item) => ({ borderColor: seriesColor(series[item.datasetIndex].cls), backgroundColor: seriesColor(series[item.datasetIndex].cls) }),
          },
        },
      },
      scales: {
        x: {
          type: "linear",
          min: xs[0],
          max: xs[xs.length - 1],
          grid: { display: false },
          border: { display: false },
          ticks: { color: css("--muted"), font: { family: css("--font"), size: 11 }, maxTicksLimit: 6, maxRotation: 0, callback: tickFmt },
        },
        y: {
          beginAtZero: true,
          grace: "10%",
          border: { display: false },
          grid: { color: rgba(css("--border"), 0.6), drawTicks: false },
          ticks: { color: css("--muted"), font: { family: css("--font"), size: 11 }, maxTicksLimit: 5, padding: 8, callback: (v) => fmt(v, true) },
        },
      },
    },
    plugins: [crosshair],
  });
  liveCharts.add(chart);
}

function sparkline(values, cls = "c1") {
  const W = 200, H = 36;
  const svg = s("svg", { class: "spark", viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", "aria-hidden": "true" });
  const vals = values.filter(Number.isFinite);
  if (vals.length < 2) return svg;
  const max = Math.max(...vals), min = Math.min(...vals);
  const span = max - min || 1;
  const pts = vals.map((v, i) => [(i * W) / (vals.length - 1), H - 3 - ((v - min) / span) * (H - 6)]);
  const line = pts.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(" ");
  const area = s("path", { class: "area", d: `M0,${H} L${line.replaceAll(" ", " L")} L${W},${H} Z` });
  area.style.fill = seriesColor(cls);
  const p = s("polyline", { class: "line", points: line, "vector-effect": "non-scaling-stroke" });
  p.style.stroke = seriesColor(cls);
  svg.append(area, p);
  return svg;
}

// ---------------------------------------------------------------- live pipeline: data

/**
 * Last hour of the live pipeline (lag, head, block rate), sampled once a minute
 * by the chain's Durable Object and served by /api/history; nothing is kept in the browser.
 */
let historySeq = 0;
async function pollHistory() {
  const seq = ++historySeq;
  const ids = state.chains.filter((c) => c.live && (state.chain === "all" || state.chain === c.id)).map((c) => c.id);
  await Promise.all(ids.map(async (id) => {
    try {
      const r = await fetchJson(`/api/history?chain=${encodeURIComponent(id)}&range=1h`);
      if (seq !== historySeq || !r.ok || !Array.isArray(r.body?.points)) return;
      state.history.set(id, { points: r.body.points, bucket_s: r.body.bucket_s || 60, from: r.body.from, to: r.body.to });
    } catch { /* keep the previous history; the page still shows the live status */ }
  }));
  if (seq === historySeq) renderLive();
}

const historyPoints = (id) => state.history.get(id)?.points || [];

/** Blocks/s and net catch-up (lag decrease) per s over the last RATE_WINDOW_MS of history. */
function rates(id) {
  const pts = historyPoints(id);
  if (pts.length < 2) return null;
  const last = pts[pts.length - 1];
  const first = pts.find((p) => (last.t - p.t) * 1000 <= RATE_WINDOW_MS) || pts[0];
  const dt = last.t - first.t;
  if (dt < 30 || first === last) return null;
  const fill = Math.max(0, (last.executed - first.executed) / dt);
  // The trend uses only samples with a known lag (none before the daemon reports a network head).
  const known = pts.filter((p) => p.lag != null && (last.t - p.t) * 1000 <= RATE_WINDOW_MS);
  const a = known[0], b = known[known.length - 1];
  const catchUp = a && b && b.t - a.t >= 30 ? (a.lag - b.lag) / (b.t - a.t) : null;
  return { fill, catchUp, dt };
}

/**
 * Chart series with a break wherever samples are missing (live Worker down): a null point
 * after any gap longer than two buckets, so the line does not bridge the outage.
 */
function historySeries(id, pick) {
  const hst = state.history.get(id);
  const xs = [], values = [];
  for (const p of hst?.points || []) {
    if (xs.length && p.t - xs[xs.length - 1] > 2 * hst.bucket_s) { xs.push(xs[xs.length - 1] + hst.bucket_s); values.push(NaN); }
    xs.push(p.t);
    const v = pick(p);
    values.push(v == null ? NaN : v);
  }
  return { xs, values };
}

function health(st) {
  if (!st) return ["unknown", "No data"];
  if (st.halted) return ["critical", "Halted"];
  const lag = st.lag;
  if (st.backoff_until && st.backoff_until > Date.now()) return ["serious", "Backing off"];
  if (lag == null) return ["unknown", "Initializing"];
  if (lag <= 4) return ["good", "Following the chain"];
  return ["warning", "Catching up"];
}

function errorsOf(st) {
  const out = [];
  const add = (src, e) => {
    if (!e) return;
    if (typeof e === "string") out.push({ src, at: null, message: e });
    else if (e.message || e.error) out.push({ src, at: e.at ?? e.checked_at ?? null, message: e.message || e.error });
  };
  add("Pipeline halted", st.halted);
  add("Pipeline", st.last_error);
  return out.sort((a, b) => (b.at || 0) - (a.at || 0));
}

const headNum = (x) => (x && typeof x.number === "number" ? x.number : null);
const headLabel = (x) => (headNum(x) == null ? "–" : `#${fmtInt(x.number)}`);

// ---------------------------------------------------------------- live pipeline: views

/** Block-height track from the R2 archive tip to the optimistic head. */
function chainTrack(st) {
  const marks = [
    { key: "tip", cls: "mk-tip", label: "Archive", n: headNum(st.r2_tip) },
    { key: "exec", cls: "mk-exec", label: "Head", n: headNum(st.executed_head) },
    { key: "fin", cls: "mk-fin", label: "Finalized", n: headNum(st.finalized) },
    { key: "opt", cls: "mk-opt", label: "Optimistic", n: headNum(st.optimistic) },
    // The network head, when the pipeline is behind it: part of the scale, so the lag segment
    // ends inside the bar.
    { key: "net", cls: "mk-net", label: "Network", n: headNum(st.target) != null && headNum(st.target) > (headNum(st.executed_head) ?? -1) ? headNum(st.target) : null },
  ].filter((m) => m.n != null);
  if (marks.length < 2) return null;
  const lo = Math.min(...marks.map((m) => m.n));
  const hi = Math.max(...marks.map((m) => m.n));
  const span = Math.max(1, hi - lo);
  const pos = (n) => Math.min(1, Math.max(0, (n - lo) / span));
  const exec = headNum(st.executed_head) ?? lo;
  const target = headNum(st.target) ?? hi;

  const bar = h("div", { class: "track-bar" });
  const done = h("div", { class: "track-done" });
  done.style.width = `${pos(exec) * 100}%`;
  const lag = h("div", { class: "track-lag" });
  lag.style.left = `${pos(exec) * 100}%`;
  lag.style.width = `${Math.max(0, pos(target) - pos(exec)) * 100}%`;
  bar.append(done, lag);
  // Pins are drawn per head; labels of heads closer than CLUSTER_GAP share one stacked
  // label (e.g. executed, finalized and optimistic while following the chain), and
  // clusters alternate above and below the bar so neighbouring labels never collide.
  const CLUSTER_GAP = 0.14;
  const sorted = marks.slice().sort((a, b) => a.n - b.n || (a.key === "exec" ? -1 : 1));
  const clusters = [];
  for (const m of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && pos(m.n) - pos(last[last.length - 1].n) < CLUSTER_GAP) last.push(m);
    else clusters.push([m]);
  }
  for (const m of sorted) {
    const pin = h("div", { class: `marker ${m.cls}` }, h("span", { class: "pin" }));
    pin.style.left = `${pos(m.n) * 100}%`;
    bar.append(pin);
  }
  const lines = { up: 0, down: 0 };
  clusters.forEach((c, i) => {
    const side = i % 2 ? "down" : "up";
    const p = c.reduce((sum, m) => sum + pos(m.n), 0) / c.length;
    lines[side] = Math.max(lines[side], c.length);
    const label = h("div", { class: `marker label-only ${side}${p < 0.1 ? " edge-l" : p > 0.9 ? " edge-r" : ""}` },
      h("span", { class: "mk-label" }, c.map((m) => h("span", { class: `mk-line ${m.cls}` }, h("i", { "aria-hidden": "true" }), h("b", {}, `#${fmtInt(m.n)}`), ` ${m.label}`))));
    label.style.left = `${p * 100}%`;
    bar.append(label);
  });
  const track = h("div", { class: "track", role: "img", "aria-label": marks.map((m) => `${m.label} block ${m.n}`).join(", ") }, bar);
  track.style.paddingTop = `${12 + 18 * lines.up}px`;
  track.style.paddingBottom = `${12 + 18 * lines.down}px`;
  return track;
}

function hero(id, st) {
  const [level, label] = health(st);
  const r = rates(id);
  let sub;
  if (st.lag == null) sub = "Waiting for the first verified head";
  else if (st.lag <= 4) sub = `At the verified head · ${fmtInt(st.lag)} block${st.lag === 1 ? "" : "s"} behind`;
  else if (r && r.catchUp > 0) sub = `${fmtInt(st.lag)} blocks behind · closing at ${fmtCompact(r.catchUp)} blocks/s · ETA ${dur(st.lag / r.catchUp)}`;
  else if (r) sub = `${fmtInt(st.lag)} blocks behind · not closing (${fmtCompact(r.fill)} blocks/s)`;
  else sub = `${fmtInt(st.lag)} blocks behind · measuring rate…`;
  const track = chainTrack(st);
  return h("div", { class: `card hero s-${level}` },
    h("div", { class: "hero-top" },
      h("div", { class: "hero-state" }, h("span", { class: "state-ring", "aria-hidden": "true" }),
        h("div", {}, h("div", { class: "hero-title" }, label), h("div", { class: "hero-sub" }, sub))),
      h("div", { class: "hero-meta" },
        h("span", { class: "chip" }, `${chainName(id)} · `, h("strong", {}, id)),
        h("span", { class: "chip" }, "last progress ", h("strong", {}, ago(st.last_progress))),
        st.pending_blocks != null ? h("span", { class: "chip" }, h("strong", {}, fmtInt(st.pending_blocks)), " buffered") : null)),
    track);
}

function kpi(label, value, detail, extra, badge) {
  return h("div", { class: "card kpi" },
    h("div", { class: "label" }, h("span", {}, label), badge || null),
    h("div", { class: "value" }, value),
    detail ? h("div", { class: "detail" }, detail) : null,
    extra || null);
}

function kpis(id, st) {
  const pts = historyPoints(id);
  const r = rates(id);
  const lagNow = num(st.lag);
  const lagPrev = pts.length > 1 ? pts.find((p) => p.lag != null && (pts[pts.length - 1].t - p.t) * 1000 <= RATE_WINDOW_MS)?.lag : null;
  let badge = null;
  if (lagNow != null && lagPrev != null) {
    const d = lagNow - lagPrev;
    badge = h("span", { class: `delta ${d < 0 ? "up" : d > 0 ? "down" : "flat"}` }, d === 0 ? "±0" : `${d > 0 ? "+" : "−"}${fmtCompact(Math.abs(d))}`);
  }
  return h("div", { class: "grid kpis" },
    kpi("Head", headLabel(st.executed_head), h("span", { class: "mono" }, short(get(st, "executed_head.hash"))), sparkline(pts.map((p) => p.executed), "c1")),
    kpi("Lag", h("span", {}, lagNow == null ? "–" : fmtInt(lagNow), h("small", {}, " blocks")), `to ${headLabel(st.target)}`, sparkline(pts.map((p) => p.lag), "c2"), badge),
    kpi("Block rate", r ? h("span", {}, fmtCompact(r.fill), h("small", {}, " blocks/s")) : "–",
      r ? `${dur(r.dt)} average${r.catchUp != null ? ` · net ${r.catchUp >= 0 ? "−" : "+"}${fmtCompact(Math.abs(r.catchUp))} lag/s` : ""}` : "no history yet",
      sparkline(pts.map((p) => p.rate), "c4")));
}

/** Lag and block rate over the last hour, from the server-side history. */
function historyCharts(id) {
  if (historyPoints(id).length < 3) return null;
  const lag = historySeries(id, (p) => p.lag);
  const rate = historySeries(id, (p) => p.rate);
  const rangeS = 3600;
  const lagCard = h("div", { class: "card" },
    cardHead("Lag", ICONS.sync, h("span", { class: "hint" }, "blocks behind the verified head · last hour")),
    lineChart({ xs: lag.xs, rangeS, title: "Lag over the last hour", height: 180, fmt: (v, axis) => (axis ? fmtCompact(v) : `${fmtInt(v)} blocks`),
      series: [{ label: "lag", cls: "c2", area: true, breakGaps: true, values: lag.values }] }));
  const rateCard = h("div", { class: "card" },
    cardHead("Block rate", ICONS.cpu, h("span", { class: "hint" }, "blocks/s per minute · last hour")),
    lineChart({ xs: rate.xs, rangeS, title: "Block rate over the last hour", height: 180, fmt: (v, axis) => (axis ? fmtCompact(v) : `${fmtCompact(v)} blocks/s`),
      series: [{ label: "blocks", cls: "c4", area: true, breakGaps: true, values: rate.values }] }));
  return h("div", { class: "grid charts" }, lagCard, rateCard);
}

function promotionCard(st) {
  const prom = st.promotion || {};
  const tip = st.r2_tip;
  const next = prom.next;
  const due = Boolean(next?.due);
  const level = !next ? "unknown" : due ? "warning" : "good";
  const label = !next ? "No schedule" : due ? "Promotion due" : "Waiting";
  const rows = [
    ["Archive tip", tip ? `${headLabel(tip)} · gen ${fmtInt(tip.generation)}` : "–"],
    ["Last promotion", prom.last ? h("span", {}, `#${fmtInt(get(prom, "last.archived_through.number"))} · `, ago(prom.last.at)) : "never"],
  ];
  if (next) {
    rows.push(["Finalized, not archived", `${fmtInt(next.finalized_above)} blocks`]);
    rows.push(["Full batch", `${fmtInt(next.batch)} blocks · once #${fmtInt(next.due_block)} is finalized`]);
    rows.push(["Age limit", next.deadline ? h("span", {}, `${dur(next.max_age_s)} · `, ago(next.deadline)) : `${dur(next.max_age_s)} · no block waiting`]);
  }
  const card = h("div", { class: "card" }, cardHead("Archive publishing", ICONS.upload, pill(level, label)), kv(rows));
  if (next && next.finalized_above != null) {
    const bar = h("div", { class: "gauge-bar" }, widthBar(next.finalized_above / next.batch, ""));
    card.append(h("div", { class: "gauge" },
      h("div", { class: "gauge-top" }, h("span", {}, "Toward the next promotion"),
        h("span", {}, due ? "due now" : `${fmtInt(next.finalized_above)} / ${fmtInt(next.batch)} blocks${next.deadline ? " · or " + agoText(next.deadline) : ""}`)),
      bar));
  } else if (!next) {
    card.append(h("p", { class: "all-clear" }, "The daemon has not reported its promotion rule yet."));
  }
  card.append(freshness("Archive tip checked", tip?.checked_at, 6 * 60_000)); // refreshed every 5 min
  return card;
}

function activity(st) {
  const errs = errorsOf(st);
  const errCard = h("div", { class: "card" },
    cardHead("Recent errors", ICONS.alert, errs.length ? pill("critical", `${errs.length}`) : pill("good", "None")),
    errs.length === 0 ? h("p", { class: "all-clear" }, "No recorded errors.") :
      h("ul", { class: "errors" }, errs.slice(0, 6).map((e) => h("li", {},
        h("span", { class: "when" }, e.src, e.at ? [" · ", ago(e.at)] : null),
        h("span", { class: "err" }, String(e.message).slice(0, 400))))));
  const counters = Object.entries(st.counters || {}).sort((a, b) => a[0].localeCompare(b[0]));
  // Collapsed by default (the list is long); open, it scrolls inside the card.
  const counterCard = h("details", { class: "card counters-card", open: state.countersOpen ? "" : null,
    ontoggle: (e) => { state.countersOpen = e.currentTarget.open; } },
    h("summary", {}, cardHead("Counters since deploy", ICONS.hash,
      h("span", { class: "counters-toggle" }, pill("neutral", `${counters.length}`), h("span", { class: "chevron" }, icon("M6 9l6 6 6-6"))))),
    counters.length ? h("div", { class: "counters" }, counters.map(([k, v]) =>
      h("div", { class: "counter" }, h("div", { class: "n" }, fmtCompact(v)), h("div", { class: "k" }, k.replaceAll("_", " ")))))
      : h("p", { class: "empty" }, "–"));
  return h("div", { class: "grid activity" }, h("div", { class: "stack" }, counterCard), errCard);
}

function liveChainDetail(id) {
  const entry = state.status.get(id);
  if (!entry) return [h("div", { class: "skeleton" })];
  if (entry.error && !entry.data) return [h("p", { class: "notice bad" }, h("strong", {}, "Live status unavailable. "), entry.error)];
  const st = entry.data.status || {};
  const chart = historyCharts(id);
  return [
    hero(id, st),
    kpis(id, st),
    chart,
    h("div", { class: "grid components" }, promotionCard(st)),
    activity(st),
  ];
}

function overviewCard(c) {
  const entry = state.status.get(c.id);
  const st = entry?.data?.status;
  const [level, label] = entry?.error && !st ? ["critical", "Unavailable"] : health(st);
  const r = rates(c.id);
  return h("button", { type: "button", class: "card", onclick: () => setChain(c.id), "aria-label": `Show ${c.name} details` },
    cardHead(`${c.name}`, null, pill(level, label)),
    st ? [chainTrack(st), kv([
      ["Lag", st.lag == null ? "–" : `${fmtInt(st.lag)} blocks`],
      ["Block rate", r ? `${fmtCompact(r.fill)} blocks/s` : "–"],
    ])] : h("p", { class: "empty" }, entry?.error || "Loading…"));
}

function renderLive() {
  const body = document.getElementById("live-body");
  const live = state.chains.filter((c) => c.live);
  if (state.chain === "all") {
    if (live.length === 0) return body.replaceChildren(h("p", { class: "notice" }, "No network has live synchronization configured on this deployment."));
    body.replaceChildren(h("div", { class: "grid overview" }, live.map(overviewCard)));
  } else {
    const c = state.chains.find((x) => x.id === state.chain);
    if (!c?.live) {
      body.replaceChildren(h("p", { class: "notice" }, h("strong", {}, `${chainName(state.chain)} has no live synchronization configured. `), "RPC analytics are shown below."));
    } else {
      body.replaceChildren(h("div", { class: "stack" }, liveChainDetail(c.id)));
    }
  }
  for (const c of body.querySelectorAll(".chart")) c._draw();
}

let statusInFlight = false;
// Live indicator phases: "load" spins the ring during a poll, "wait" fills it until the next one.
function livePhase(p) {
  const el = document.getElementById("live-indicator");
  if (p === "wait") {
    el.dataset.phase = "";
    void el.offsetWidth; // restart the fill animation
  }
  el.dataset.phase = p;
}

async function pollStatus() {
  if (statusInFlight) return;
  statusInFlight = true;
  livePhase("load");
  const ids = state.chains.filter((c) => c.live && (state.chain === "all" || state.chain === c.id)).map((c) => c.id);
  let anyOk = false, err = null;
  try {
    await Promise.all(ids.map(async (id) => {
      try {
        const r = await fetchJson(`/api/status?chain=${encodeURIComponent(id)}`);
        if (!r.ok || !r.body) throw new Error(r.body?.error || `HTTP ${r.status}`);
        state.status.set(id, { data: r.body, at: Date.now() });
        anyOk = true;
      } catch (e) {
        err = e.message || String(e);
        const prev = state.status.get(id);
        state.status.set(id, { data: prev?.data, error: err, at: Date.now() });
      }
    }));
  } finally {
    statusInFlight = false;
    livePhase("wait");
  }
  if (anyOk) state.lastOk = Date.now();
  state.lastError = anyOk || ids.length === 0 ? null : err;
  renderLive();
  renderChainTabs();
  tick();
}

// ---------------------------------------------------------------- analytics

function table(head, rows, opts = {}) {
  return h("div", { class: "table-wrap" }, h("table", {},
    h("thead", {}, h("tr", {}, head.map(([label, isNum]) => h("th", { class: isNum ? "num" : null }, label)))),
    h("tbody", {}, rows.length ? rows : h("tr", {}, h("td", { colspan: head.length, class: "empty" }, opts.empty || "No data in this range.")))));
}

function tile(label, value, detail, extra) {
  return h("div", { class: "card tile" }, h("div", { class: "label" }, label), h("div", { class: "value" }, value), detail ? h("div", { class: "detail" }, detail) : null, extra || null);
}

function renderAnalytics() {
  const body = document.getElementById("rpc-body");
  if (!state.analytics && !state.analyticsError) return;
  if (state.analyticsError) {
    const e = state.analyticsError;
    body.replaceChildren(h("p", { class: "notice" },
      e.notConfigured
        ? [h("strong", {}, "RPC analytics are not configured on this deployment. "), "The live pipeline above is unaffected."]
        : [h("strong", {}, "Analytics are temporarily unavailable. "), e.message]));
    return;
  }
  const a = state.analytics;
  const t = a.totals;
  const minutes = (a.to - a.from) / 60;
  const perMin = a.bucket_s / 60;
  const errRate = pct(t.errors, t.requests);
  // Cloudflare Workers analytics (GraphQL): one request = one HTTP request (a JSON-RPC batch
  // counts once); errors are Worker invocation errors; latency is wall time.
  const peak = a.series.reduce((best, p) => (p.requests > best.requests ? p : best), { requests: 0, t: a.from });
  const when = (ts) => new Date(ts * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const tiles = h("div", { class: "grid tiles" },
    tile("Requests", fmtCompact(t.requests), `${fmtCompact(t.requests / Math.max(1, minutes))}/min · HTTP requests`),
    tile("Average rate", h("span", {}, fmtCompact(t.requests / Math.max(1, minutes * 60)), h("small", {}, " req/s")), `over the last ${state.range}`),
    tile("Peak minute", h("span", {}, fmtCompact(peak.requests / perMin), h("small", {}, " req/min")), peak.requests ? when(peak.t) : "No requests yet"),
    tile("Error rate", h("span", { class: errRate > 1 ? "err" : null }, fmtPct(errRate)), `${fmtInt(t.errors)} Worker errors`),
    tile("Median latency", h("span", {}, fmtMs(t.p50_ms), h("small", {}, " p50")), "wall time per request"),
    tile("Tail latency", h("span", {}, fmtMs(t.p95_ms), h("small", {}, " p95")), `p99 ${fmtMs(t.p99_ms)}`),
    tile("CPU time", h("span", {}, fmtMs(t.cpu_p50_ms), h("small", {}, " p50")), `p99 ${fmtMs(t.cpu_p99_ms)}`),
    tile("Subrequests", fmtCompact(t.subrequests), `${t.requests ? (t.subrequests / t.requests).toFixed(1) : "–"} per request (R2, cache, live)`),
  );

  const xs = a.series.map((p) => p.t);
  const rangeS = a.to - a.from;
  const reqChart = h("div", { class: "card" },
    cardHead("Requests per minute", null, h("div", { class: "legend" },
      h("span", {}, h("span", { class: "key line c1" }), "requests"), h("span", {}, h("span", { class: "key line c2" }), "errors"))),
    lineChart({
      xs, rangeS, title: "Requests and errors per minute",
      fmt: (v, axis) => (axis ? fmtCompact(v) : `${fmtCompact(v)}/min`),
      series: [
        { label: "requests", cls: "c1", area: true, values: a.series.map((p) => p.requests / perMin) },
        { label: "errors", cls: "c2", values: a.series.map((p) => p.errors / perMin) },
      ],
    }));
  const latChart = h("div", { class: "card" },
    cardHead("Latency p95 (wall time)", null),
    lineChart({ xs, rangeS, title: "p95 wall time", fmt: (v) => fmtMs(v), series: [{ label: "p95", cls: "c3", area: true, values: a.series.map((p) => p.p95_ms) }] }));

  const parts = [tiles, h("div", { class: "grid charts" }, reqChart, latChart)];
  if (a.per_chain) {
    parts.push(h("div", { class: "card" }, cardHead("Network breakdown", null),
      table([["Chain"], ["Requests", true], ["Error rate", true], ["Subrequests / req", true], ["p50", true], ["p95", true]],
        a.per_chain.map((c) => h("tr", {},
          h("td", {}, `${chainName(c.chain)} · ${c.chain}`),
          h("td", { class: "num" }, fmtCompact(c.requests)),
          h("td", { class: "num" }, fmtPct(pct(c.errors, c.requests))),
          h("td", { class: "num" }, c.requests ? (c.subrequests / c.requests).toFixed(1) : "–"),
          h("td", { class: "num" }, fmtMs(c.p50_ms)),
          h("td", { class: "num" }, fmtMs(c.p95_ms)))))));
  }
  body.replaceChildren(h("div", { class: "stack" }, parts));
  for (const c of body.querySelectorAll(".chart")) c._draw();
}

/** Placeholder in the shape of the analytics view (8 tiles, 2 charts) while a new range or network loads. */
function analyticsSkeleton() {
  const bar = (cls) => h("span", { class: `sk ${cls}` });
  return h("div", { class: "stack", "aria-busy": "true", "aria-label": "Loading analytics" },
    h("div", { class: "grid tiles" }, Array.from({ length: 8 }, () =>
      h("div", { class: "card tile" }, bar("sk-label"), bar("sk-value"), bar("sk-detail")))),
    h("div", { class: "grid charts" }, [0, 1].map(() =>
      h("div", { class: "card" }, bar("sk-title"), bar("sk-chart")))));
}

let analyticsSeq = 0;
/** `fresh`: the range or network changed, so the shown numbers are stale; show the skeleton. */
async function pollAnalytics(fresh = false) {
  const seq = ++analyticsSeq;
  const body = document.getElementById("rpc-body");
  if (fresh || !body.firstChild) {
    state.analytics = null;
    state.analyticsError = null;
    body.replaceChildren(analyticsSkeleton());
  }
  body.classList.add("loading");
  try {
    const r = await fetchJson(`/api/analytics?range=${encodeURIComponent(state.range)}&chain=${encodeURIComponent(state.chain)}`);
    if (seq !== analyticsSeq) return;
    if (r.status === 503 && r.body && r.body.configured === false) {
      state.analytics = null;
      state.analyticsError = { notConfigured: true };
    } else if (!r.ok || !r.body) {
      state.analyticsError = { message: r.body?.error || `HTTP ${r.status}` };
    } else {
      state.analytics = r.body;
      state.analyticsError = null;
    }
  } catch (e) {
    if (seq !== analyticsSeq) return;
    state.analyticsError = { message: e.message || String(e) };
  }
  body.classList.remove("loading");
  renderAnalytics();
}

// ---------------------------------------------------------------- header: chains, live indicator, theme

function chainLevel(id) {
  const entry = state.status.get(id);
  if (!entry) return "unknown";
  if (entry.error && !entry.data) return "critical";
  return health(entry.data?.status)[0];
}

const DIAMOND = "<g fill='currentColor'><path fill-opacity='.8' d='M127.96 0l-2.8 9.5v275.67l2.8 2.79 127.96-75.64z'/><path fill-opacity='.45' d='M127.96 0L0 212.32l127.96 75.64V154.16z'/><path fill-opacity='.8' d='M127.96 312.19l-1.58 1.92v98.2l1.58 4.6L256 236.59z'/><path fill-opacity='.45' d='M127.96 416.9V312.19L0 236.59z'/><path d='M127.96 287.96l127.96-75.64-127.96-58.16z'/><path fill-opacity='.8' d='M0 212.32l127.96 75.64v-133.8z'/></g>";
const MARKS = {
  mainnet: `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 417'>${DIAMOND}</svg>`,
  testnet: `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><circle cx='16' cy='16' r='14.75' fill='none' stroke='currentColor' stroke-width='1.5' stroke-dasharray='3.1 2.7' stroke-opacity='.8'/><g transform='translate(10.5 6.8) scale(.043)'>${DIAMOND}</g></svg>`,
};
// Static markup, parsed (never built from API data).
function chainMark(id) {
  const kind = id === "1" ? "mainnet" : ["560048", "11155111", "17000"].includes(id) ? "testnet" : null;
  if (!kind) return null;
  const svg = new DOMParser().parseFromString(MARKS[kind], "image/svg+xml").documentElement;
  svg.setAttribute("class", "chain-mark");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  return document.importNode(svg, true);
}

// Network picker: the landing page's dropdown (a button and a grouped listbox, WAI-ARIA
// select-only combobox). Groups: "All networks", mainnets, testnets.
const TESTNETS = new Set(["560048", "11155111", "17000"]);
let pickerActive = 0;
function pickerOptions() {
  const opts = [];
  if (state.chains.length > 1) opts.push({ id: "all", name: "All networks", group: "" });
  for (const c of state.chains) opts.push({ ...c, group: (c.testnet ?? TESTNETS.has(c.id)) ? "Testnets" : "Networks" });
  return opts;
}

function renderChainTabs() {
  const opts = pickerOptions();
  const current = opts.find((o) => o.id === state.chain) || opts[0];
  if (current) {
    document.getElementById("net-name").textContent = current.name;
    document.getElementById("net-mark").replaceChildren(...[current.id !== "all" ? chainMark(current.id) : null].filter(Boolean));
    const level = current.id !== "all" && current.live ? chainLevel(current.id) : null;
    const dot = document.getElementById("net-dot");
    dot.className = `tab-dot${level ? ` s-${level}` : ""}`;
    dot.hidden = !level;
  }
  const list = document.getElementById("net-list");
  const groups = [];
  for (const o of opts) {
    let g = groups.find((x) => x.name === o.group);
    if (!g) groups.push((g = { name: o.group, items: [] }));
    g.items.push(o);
  }
  list.replaceChildren(...groups.map((g) => h("li", { role: "group", "aria-label": g.name || "All" },
    g.name ? h("span", { class: "net-group", "aria-hidden": "true" }, g.name) : null,
    h("ul", { role: "presentation" }, g.items.map((o) => {
      const level = o.id !== "all" && o.live ? chainLevel(o.id) : null;
      return h("li", {
        role: "option", id: `net-opt-${o.id}`, "data-id": o.id, "aria-selected": String(o.id === state.chain),
        onclick: () => { closePicker(true); setChain(o.id); },
      },
      o.id !== "all" ? chainMark(o.id) : h("span", { class: "net-all", "aria-hidden": "true" }, "∗"),
      h("span", { class: "net-opt-name" }, o.name),
      o.id !== "all" ? h("span", { class: "net-sub" }, o.live ? `ID ${o.id}` : `ID ${o.id} · analytics`) : null,
      level ? h("span", { class: `tab-dot s-${level}`, "aria-hidden": "true" }) : null);
    })))));
}

function pickerItems() { return [...document.querySelectorAll('#net-list [role="option"]')]; }
function setPickerActive(i) {
  const items = pickerItems();
  if (!items.length) return;
  pickerActive = (i + items.length) % items.length;
  items.forEach((li, j) => li.classList.toggle("is-active", j === pickerActive));
  document.getElementById("net-list").setAttribute("aria-activedescendant", items[pickerActive].id);
}
function openPicker() {
  const list = document.getElementById("net-list");
  list.hidden = false;
  document.getElementById("net-button").setAttribute("aria-expanded", "true");
  setPickerActive(Math.max(0, pickerItems().findIndex((li) => li.dataset.id === state.chain)));
  list.focus();
}
function closePicker(focusButton) {
  document.getElementById("net-list").hidden = true;
  document.getElementById("net-button").setAttribute("aria-expanded", "false");
  if (focusButton) document.getElementById("net-button").focus();
}
function initPicker() {
  const button = document.getElementById("net-button");
  const list = document.getElementById("net-list");
  button.addEventListener("click", () => (list.hidden ? openPicker() : closePicker(true)));
  button.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); openPicker(); }
  });
  list.addEventListener("keydown", (e) => {
    const items = pickerItems();
    if (e.key === "ArrowDown") { e.preventDefault(); setPickerActive(pickerActive + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setPickerActive(pickerActive - 1); }
    else if (e.key === "Home") { e.preventDefault(); setPickerActive(0); }
    else if (e.key === "End") { e.preventDefault(); setPickerActive(items.length - 1); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); const id = items[pickerActive]?.dataset.id; closePicker(true); if (id) setChain(id); }
    else if (e.key === "Escape" || e.key === "Tab") closePicker(e.key === "Escape");
  });
  list.addEventListener("mousemove", (e) => {
    const li = e.target.closest('[role="option"]');
    if (li) setPickerActive(pickerItems().indexOf(li));
  });
  document.addEventListener("click", (e) => {
    if (!list.hidden && !list.contains(e.target) && !button.contains(e.target)) closePicker(false);
  });
}

function tick() {
  const el = document.getElementById("live-indicator");
  const label = document.getElementById("live-label");
  const since = state.lastOk ? Date.now() - state.lastOk : Infinity;
  const mode = state.lastOk === 0 && !state.lastError ? "" : since <= STALE_MS ? "is-live" : state.lastError && since > STALE_MS ? "is-down" : "is-stale";
  el.classList.remove("is-live", "is-down", "is-stale");
  if (mode) el.classList.add(mode);
  label.textContent = mode === "is-live" ? "Live" : mode === "is-down" ? "Offline" : mode === "is-stale" ? "Stale" : "Connecting";
  el.title = state.lastError ? `Last error: ${state.lastError}` : state.lastOk ? `Last update ${new Date(state.lastOk).toLocaleTimeString()}` : "";
  for (const a of document.querySelectorAll("[data-at]")) {
    const at = Number(a.dataset.at);
    a.textContent = agoText(at);
    if (a.dataset.fresh) paintAge(a);
  }
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
}
// The theme follows the OS setting, like the landing page, the platform and the endpoint pages.
function initTheme() {
  const light = window.matchMedia("(prefers-color-scheme: light)");
  applyTheme(light.matches ? "light" : "dark");
  light.addEventListener("change", () => {
    applyTheme(light.matches ? "light" : "dark");
    renderLive();
    renderAnalytics();
  });
}

// ---------------------------------------------------------------- controls and loop

function syncUrl() {
  const q = new URLSearchParams();
  if (state.chain !== "all") q.set("chain", state.chain);
  if (state.range !== "1h") q.set("range", state.range);
  history.replaceState(null, "", q.toString() ? `?${q}` : location.pathname);
}

function setChain(id) {
  if (state.chain === id) return;
  state.chain = id;
  syncUrl();
  renderChainTabs();
  renderLive();
  pollStatus();
  pollHistory();
  pollAnalytics(true);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function setRange(r) {
  state.range = r;
  for (const b of document.querySelectorAll("#range button")) {
    const on = b.dataset.range === r;
    b.setAttribute("aria-checked", String(on));
    b.tabIndex = on ? 0 : -1;
  }
  syncUrl();
  pollAnalytics(true);
}

function arrowNav(container, selector, onPick) {
  container.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const all = [...container.querySelectorAll(selector)];
    const i = all.indexOf(document.activeElement);
    if (i < 0) return;
    const next = all[(i + (e.key === "ArrowRight" ? 1 : all.length - 1)) % all.length];
    next.focus();
    onPick(next);
    e.preventDefault();
  });
}

async function init() {
  initTheme();
  const params = new URLSearchParams(location.search);
  try {
    const r = await fetchJson("/api/chains");
    state.chains = r.body?.chains || [];
    state.analyticsEnabled = !!r.body?.analytics;
  } catch { state.chains = []; }
  const want = params.get("chain");
  state.chain = state.chains.some((c) => c.id === want) ? want : state.chains.length === 1 ? state.chains[0].id : "all";
  renderChainTabs();
  initPicker();

  const wantRange = params.get("range");
  for (const b of document.querySelectorAll("#range button")) b.addEventListener("click", () => setRange(b.dataset.range));
  arrowNav(document.getElementById("range"), "button", (b) => setRange(b.dataset.range));
  setRange(["1h", "24h", "7d"].includes(wantRange) ? wantRange : "1h");

  pollStatus();
  pollHistory();
  setInterval(() => { if (!document.hidden) pollStatus(); }, STATUS_POLL_MS);
  setInterval(() => { if (!document.hidden) pollHistory(); }, HISTORY_POLL_MS);
  setInterval(() => { if (!document.hidden) pollAnalytics(); }, ANALYTICS_POLL_MS);
  setInterval(tick, 1000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { pollStatus(); pollHistory(); pollAnalytics(); } });
  let rt = 0;
  window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { renderLive(); renderAnalytics(); }, 150); });
}

init();
