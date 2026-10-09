// nullrpc endpoint page (apps/rpc/src/page).
// Status: this Worker's own `/status.json` (the archive tip and the live window's pointers). Usage: Cloudflare Workers analytics through the status API, read
// via this origin (`/_status/usage`), drawn with the vendored Chart.js (loaded on demand).
// Ages are measured on the server's clock (`generated_at`), never the device's.
// Every value is written with textContent; no HTML is built from data.
"use strict";
(() => {
  const STATUS_MS = 5000;
  const USAGE_MS = 30000;
  const STALE_MS = 30000; // /status.json is cached 5 s per data center
  const $ = (id) => document.getElementById(id);
  const page = $("page");
  const statusUrl = page.dataset.status || "";
  const usageUrl = page.dataset.usage || "";
  const exampleUrl = page.dataset.example || "";
  const assets = page.dataset.assets || "";
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let range = "1h";
  let pointAt = 0; // when the newest status was computed (ms, server clock)
  let skew = 0; // device clock minus server clock (ms)
  const serverNow = () => Date.now() - skew;
  let failed = false;
  let latestTs = null;
  let finalizedTs = null;

  const set = (id, text) => {
    const el = $(id);
    if (el.textContent !== text) el.textContent = text;
  };
  const h = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const isNum = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  const int = (n) => Math.round(n).toLocaleString("en-US");
  const compact = (n) => {
    if (!isNum(n)) return "–";
    if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e4) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + "k";
    if (n > 0 && n < 10 && !Number.isInteger(n)) return n.toFixed(n < 1 ? 2 : 1);
    return int(n);
  };
  const ago = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 90) return s + " s ago";
    if (s < 5400) return Math.round(s / 60) + " min ago";
    return Math.round(s / 3600) + " h ago";
  };

  const STATES = {
    following: ["good", "✓", "Following the chain", "Up to date with the network."],
    serving: ["good", "✓", "Serving", "Serving the newest blocks this endpoint has."],
    archive: ["good", "✓", "Serving the archive", "Historical data up to the archived block."],
    catching_up: ["warning", "!", "Catching up", ""],
    delayed: ["warning", "!", "Delayed", "New blocks are delayed. Archived data remains available."],
    unknown: ["unknown", "·", "Checking status", ""],
    unavailable: ["error", "×", "Status unavailable", "Status data is not available right now. RPC requests are not affected."],
  };

  const num = (b) => (b && isNum(b.number) ? b.number : null);
  const ts = (b) => (b && isNum(b.timestamp) ? b.timestamp * 1000 : null);

  // `s` is /status.json (crate::page::public_status).
  function renderStatus(s) {
    const key = Object.hasOwn(STATES, s.state) ? s.state : "unknown";
    const [level, icon, word, text] = STATES[key];
    $("state").dataset.level = level;
    $("live").dataset.level = level;
    set("state-icon", icon);
    set("state-word", word);
    set("state-detail", key === "catching_up" && isNum(s.behind) ? int(s.behind) + (s.behind === 1 ? " block" : " blocks") + " behind the network." : text);
    const latest = num(s.latest);
    const finalized = num(s.finalized);
    set("latest", latest !== null ? "#" + int(latest) : "–");
    set("finalized", finalized !== null ? "#" + int(finalized) : "–");
    set("archived", isNum(s.archived_through) ? "#" + int(s.archived_through) : "–");
    set("peers", isNum(s.window) ? int(s.window) + (s.window === 1 ? " block" : " blocks") : "–");
    latestTs = ts(s.latest);
    finalizedTs = ts(s.finalized);
    pointAt = isNum(s.generated_at) ? s.generated_at : 0;
  }

  function renderUnavailable() {
    const [level, icon, word, text] = STATES.unavailable;
    $("state").dataset.level = level;
    set("state-icon", icon);
    set("state-word", word);
    set("state-detail", text);
  }

  // Live indicator: "wait" fills the ring over the refresh interval, "load" spins it while the
  // request runs. The word says whether the data is current; ages stay in the status cards.
  const live = $("live");
  live.style.setProperty("--refresh", STATUS_MS / 1000 + "s");
  function phase(p) {
    if (p === "wait") {
      live.dataset.phase = "";
      void live.offsetWidth; // restart the fill animation
    }
    live.dataset.phase = p;
  }

  function tick() {
    set("latest-age", latestTs === null ? "" : ago(serverNow() - latestTs));
    set("finalized-age", finalizedTs === null ? "" : ago(serverNow() - finalizedTs));
    if (!pointAt) {
      set("live-text", failed ? "Offline" : "Connecting");
      if (failed) live.dataset.level = "error";
      return;
    }
    if (failed || serverNow() - pointAt > STALE_MS) {
      live.dataset.level = "warning";
      set("live-text", "Stale");
    } else {
      set("live-text", "Live");
    }
  }

  async function getJson(url) {
    const res = await fetch(url, { headers: { accept: "application/json" }, credentials: "omit", referrerPolicy: "no-referrer" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }

  async function pollStatus() {
    if (!statusUrl) return renderUnavailable();
    phase("load");
    try {
      const body = await getJson(statusUrl);
      if (!body || typeof body.state !== "string") throw new Error("no status");
      if (isNum(body.generated_at)) skew = Date.now() - body.generated_at;
      renderStatus(body);
      failed = false;
    } catch {
      failed = true;
      if (!pointAt) renderUnavailable();
    }
    tick();
    phase("wait");
  }

  // ---- copy buttons: icon, then a check for 2 s

  function copyButton(button, getText) {
    if (!navigator.clipboard || !window.isSecureContext) return;
    button.hidden = false;
    const label = button.querySelector(".btn-text");
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(getText());
        button.dataset.state = "done";
        label.textContent = "Copied";
        clearTimeout(button._t);
        button._t = setTimeout(() => {
          delete button.dataset.state;
          label.textContent = "Copy";
        }, 2000);
      } catch {
        set("copy-status", "Copy is unavailable. Select the text to copy it.");
      }
    });
  }

  // ---- example: cURL, fetch and viem, with light highlighting (text nodes only)

  const BODY = '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}';
  const EXAMPLES = {
    curl: () => "curl " + exampleUrl + " \\\n  -H 'content-type: application/json' \\\n  -d '" + BODY + "'",
    fetch: () => [
      'const res = await fetch("' + exampleUrl + '", {',
      '  method: "POST",',
      '  headers: { "content-type": "application/json" },',
      "  body: JSON.stringify(" + BODY + "),",
      "});",
      "const { result } = await res.json();",
    ].join("\n"),
    viem: () => [
      'import { createPublicClient, http } from "viem";',
      "",
      'const client = createPublicClient({ transport: http("' + exampleUrl + '") });',
      "const block = await client.getBlockNumber();",
    ].join("\n"),
  };
  let lang = "curl";
  function highlight(code) {
    const out = [];
    const re = /("(?:[^"\\]|\\.)*"|'[^']*'|\b(?:const|await|import|from|curl)\b|-[Hd]\b)/g;
    let last = 0;
    for (const m of code.matchAll(re)) {
      if (m.index > last) out.push(document.createTextNode(code.slice(last, m.index)));
      const t = m[0];
      out.push(h("span", /^["']/.test(t) ? "tok-str" : /^-/.test(t) ? "tok-flag" : "tok-kw", t));
      last = m.index + t.length;
    }
    out.push(document.createTextNode(code.slice(last)));
    return out;
  }
  function showExample() {
    $("code").replaceChildren(...highlight(EXAMPLES[lang]()));
    for (const b of document.querySelectorAll("#code-tabs button")) b.setAttribute("aria-pressed", String(b.dataset.lang === lang));
  }
  if (exampleUrl) {
    $("code-tabs").hidden = false;
    for (const b of document.querySelectorAll("#code-tabs button")) {
      b.addEventListener("click", () => {
        lang = b.dataset.lang;
        showExample();
      });
    }
    showExample();
  }
  copyButton($("copy"), () => $("endpoint").textContent.trim());
  copyButton($("code-copy"), () => $("code").textContent);

  // ---- usage charts (Chart.js, same look as the landing page)

  let chartLoad = null;
  const charts = {};
  let lastUsage = null;

  function loadChartJs() {
    if (chartLoad) return chartLoad;
    const fonts = document.fonts && document.fonts.load
      ? Promise.all([document.fonts.load('500 12px "IBM Plex Sans"')]).catch(() => {})
      : Promise.resolve();
    const script = new Promise((resolve, reject) => {
      if (window.Chart) return resolve(window.Chart);
      const s = document.createElement("script");
      s.src = assets + "chart.umd.min.js";
      s.onload = () => (window.Chart ? resolve(window.Chart) : reject(new Error("Chart.js")));
      s.onerror = () => {
        chartLoad = null;
        reject(new Error("Chart.js"));
      };
      document.head.append(s);
    });
    chartLoad = Promise.all([script, fonts]).then(([Chart]) => Chart);
    return chartLoad;
  }

  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  function rgba(hex, a) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    return m ? "rgba(" + parseInt(m[1], 16) + "," + parseInt(m[2], 16) + "," + parseInt(m[3], 16) + "," + a + ")" : hex;
  }
  const fmtTick = (t) => {
    const d = new Date(t * 1000);
    return range === "7d" ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  };
  // A vertical guide at the hovered point.
  const crosshair = {
    id: "crosshair",
    afterDatasetsDraw(chart) {
      const active = chart.tooltip && chart.tooltip.getActiveElements();
      if (!active || !active.length) return;
      const x = active[0].element.x;
      const area = chart.chartArea;
      const ctx = chart.ctx;
      ctx.save();
      ctx.strokeStyle = rgba(cssVar("--nr-accent"), 0.5);
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, area.top);
      ctx.lineTo(x, area.bottom);
      ctx.stroke();
      ctx.restore();
    },
  };

  function makeChart(Chart, canvas, fmtY, fmtTip) {
    const accent = cssVar("--nr-accent");
    return new Chart(canvas, {
      type: "line",
      data: {
        datasets: [{
          data: [],
          parsing: false,
          borderColor: accent,
          borderWidth: 2,
          tension: 0.35,
          fill: "origin",
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHoverBackgroundColor: accent,
          pointHoverBorderColor: cssVar("--nr-bg"),
          pointHoverBorderWidth: 2,
          backgroundColor: (ctx) => {
            const area = ctx.chart.chartArea;
            if (!area) return "transparent";
            const g = ctx.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
            g.addColorStop(0, rgba(cssVar("--nr-accent"), 0.14));
            g.addColorStop(1, rgba(cssVar("--nr-accent"), 0));
            return g;
          },
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: reduceMotion.matches ? false : { duration: 600, easing: "easeOutQuart" },
        interaction: { mode: "index", intersect: false },
        layout: { padding: { top: 8 } },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: cssVar("--nr-surface-raised"),
            borderColor: cssVar("--nr-border"),
            borderWidth: 1,
            titleColor: cssVar("--nr-text-secondary"),
            bodyColor: cssVar("--nr-text"),
            titleFont: { family: cssVar("--nr-font-sans"), size: 12, weight: "normal" },
            bodyFont: { family: cssVar("--nr-font-sans"), size: 14, weight: "600" },
            padding: 10,
            cornerRadius: 8,
            displayColors: false,
            callbacks: {
              title: (items) => (items.length ? new Date(items[0].parsed.x * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""),
              label: (item) => fmtTip(item.parsed.y),
            },
          },
        },
        scales: {
          x: {
            type: "linear",
            grid: { display: false },
            border: { display: false },
            ticks: { color: cssVar("--nr-text-secondary"), font: { family: cssVar("--nr-font-sans"), size: 11 }, maxTicksLimit: 6, maxRotation: 0, callback: fmtTick },
          },
          y: {
            beginAtZero: true,
            grace: "10%",
            border: { display: false },
            grid: { color: rgba(cssVar("--nr-border"), 0.6), drawTicks: false },
            ticks: { color: cssVar("--nr-text-secondary"), font: { family: cssVar("--nr-font-sans"), size: 11 }, maxTicksLimit: 5, padding: 8, callback: fmtY },
          },
        },
      },
      plugins: [crosshair],
    });
  }

  async function drawCharts(a) {
    let Chart;
    try {
      Chart = await loadChartJs();
    } catch {
      set("chart-caption", "Could not load the charts.");
      return;
    }
    if (!charts.requests) {
      charts.requests = makeChart(Chart, $("chart-requests"), (v) => compact(v), (v) => compact(v) + " req/min");
      charts.latency = makeChart(Chart, $("chart-latency"), (v) => int(v) + " ms", (v) => (v < 1 ? "<1" : int(v)) + " ms p95");
    }
    const per = isNum(a.bucket_s) && a.bucket_s > 0 ? a.bucket_s / 60 : 1;
    const series = (Array.isArray(a.series) ? a.series : []).filter((p) => isNum(p.t));
    const points = (f) => series.map((p) => ({ x: p.t, y: f(p) }));
    const sets = [
      [charts.requests, points((p) => (isNum(p.requests) ? p.requests / per : 0))],
      [charts.latency, points((p) => (isNum(p.p95_ms) ? p.p95_ms : 0))],
    ];
    for (const [chart, data] of sets) {
      chart.data.datasets[0].data = data;
      if (series.length) {
        chart.options.scales.x.min = series[0].t;
        chart.options.scales.x.max = series[series.length - 1].t;
      }
      chart.update();
    }
    set("chart-caption", series.length < 2 ? "No requests in this time range." : "");
  }

  function renderUsage(a) {
    const t = a && a.totals;
    if (!a || a.configured !== true || !t || !isNum(t.requests)) return false;
    // Cloudflare Workers analytics: HTTP requests (a batch counts once), wall-time latency.
    const ms = (v) => (t.requests > 0 && isNum(v) ? (v < 1 ? "<1 ms" : int(v) + " ms") : "–");
    const span = isNum(a.from) && isNum(a.to) && a.to > a.from ? a.to - a.from : { "1h": 3600, "24h": 86400, "7d": 604800 }[range];
    set("total", compact(t.requests));
    set("total-rate", "Average " + compact(t.requests / span) + " req/s");
    set("p50", ms(t.p50_ms));
    set("p95", ms(t.p95_ms));
    lastUsage = a;
    drawCharts(a);
    return true;
  }

  // `fresh`: the range changed, so the shown numbers are stale; they shimmer until the data arrives.
  function setLoading(on) {
    $("usage").classList.toggle("is-loading", on);
    if (on) $("usage").setAttribute("aria-busy", "true");
    else $("usage").removeAttribute("aria-busy");
  }
  let usageSeq = 0;
  async function pollUsage(fresh) {
    if (!usageUrl) return;
    const seq = ++usageSeq;
    if (fresh === true) setLoading(true);
    try {
      const a = await getJson(usageUrl + "?range=" + encodeURIComponent(range));
      if (seq !== usageSeq) return;
      setLoading(false);
      $("usage").hidden = !renderUsage(a);
    } catch {
      if (seq !== usageSeq) return;
      setLoading(false);
      if (!lastUsage) $("usage").hidden = true;
    }
  }

  // Rebuild the charts in the other theme's colors when the OS setting flips.
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    for (const k of Object.keys(charts)) {
      charts[k].destroy();
      delete charts[k];
    }
    if (lastUsage) drawCharts(lastUsage);
  });

  const buttons = [...document.querySelectorAll("#range button")];
  function setRange(r) {
    range = r;
    for (const b of buttons) {
      const on = b.dataset.range === r;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    }
    pollUsage(true);
  }
  for (const b of buttons) {
    b.addEventListener("click", () => setRange(b.dataset.range));
    b.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const i = (buttons.indexOf(b) + (e.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length;
      buttons[i].focus();
      setRange(buttons[i].dataset.range);
      e.preventDefault();
    });
  }

  let timers = [];
  function start() {
    stop();
    pollStatus();
    pollUsage();
    timers = [setInterval(pollStatus, STATUS_MS), setInterval(pollUsage, USAGE_MS), setInterval(tick, 1000)];
  }
  function stop() {
    timers.forEach(clearInterval);
    timers = [];
  }
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  setRange("1h");
  start();
})();
