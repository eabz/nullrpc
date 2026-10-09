// nullrpc landing page: copy buttons, the hero animation's reduced-motion
// pause, the network picker and the traffic charts (/api/usage, drawn with
// the vendored Chart.js, loaded only when the section comes near the viewport). Same-origin
// requests only; no storage, no tracking. Values from the network are written as text.
"use strict";
(function () {
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  // ---- copy buttons: the icon turns into a check for 2 s; only a failure is written out
  var copyStatus = document.getElementById("try-status");
  function flash(button, text, ms) {
    var label = button.querySelector(".btn-text");
    var original = label.getAttribute("data-label") || label.textContent;
    label.setAttribute("data-label", original);
    button.setAttribute("data-state", "done");
    label.textContent = text;
    clearTimeout(button._flash);
    button._flash = setTimeout(function () {
      button.removeAttribute("data-state");
      label.textContent = original;
    }, ms);
  }
  if (navigator.clipboard && window.isSecureContext) {
    document.querySelectorAll("button[data-copy]").forEach(function (button) {
      var target = document.getElementById(button.getAttribute("data-copy"));
      if (!target) return;
      button.hidden = false;
      button.setAttribute("aria-describedby", target.id);
      button.addEventListener("click", function () {
        navigator.clipboard.writeText(target.textContent).then(
          function () {
            if (copyStatus) copyStatus.textContent = "";
            flash(button, "Copied", 2000);
          },
          function () {
            if (copyStatus) copyStatus.textContent = "Could not copy. Select the URL and copy it manually.";
          }
        );
      });
    });
  }

  // ---- hero animation: SMIL ignores prefers-reduced-motion, so pause it here
  var art = document.getElementById("hero-art");
  function syncMotion() {
    if (!art || !art.pauseAnimations) return;
    if (reduceMotion.matches) art.pauseAnimations();
    else art.unpauseAnimations();
  }
  syncMotion();
  if (reduceMotion.addEventListener) reduceMotion.addEventListener("change", syncMotion);

  // ---- helpers
  var nf = new Intl.NumberFormat("en-US");
  function compact(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 1 : 2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 1 : 2) + "M";
    if (n >= 1e4) return (n / 1e3).toFixed(1) + "K";
    if (n > 0 && n < 10 && n % 1) return n.toFixed(n < 1 ? 2 : 1);
    return nf.format(Math.round(n));
  }
  function bytes(n) {
    var units = ["B", "KB", "MB", "GB", "TB", "PB"];
    var i = 0;
    while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
    return (i === 0 ? Math.round(n) : n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)) + " " + units[i];
  }
  function getJSON(url) {
    return fetch(url, { headers: { accept: "application/json" } }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }
  function visible() { return document.visibilityState !== "hidden"; }

  var tryStatus = document.getElementById("try-status");

  // ---- network picker: a button and a listbox (WAI-ARIA select-only combobox pattern)
  var button = document.getElementById("net-button");
  var list = document.getElementById("net-list");
  var options = list ? Array.prototype.slice.call(list.querySelectorAll('[role="option"]')) : [];
  var selected = { chain: 560048, url: "", name: "", label: "" };
  var onNetworkChange = function () { kickCharts(); };
  var kickCharts = function () {};
  var active = 0;

  function optionData(li) {
    return {
      chain: Number(li.getAttribute("data-chain")),
      url: li.getAttribute("data-url"),
      name: li.getAttribute("data-name"),
      label: li.getAttribute("data-label")
    };
  }
  function setActive(i) {
    active = (i + options.length) % options.length;
    options.forEach(function (li, j) { li.classList.toggle("is-active", j === active); });
    list.setAttribute("aria-activedescendant", options[active].id);
  }
  function openList() {
    list.hidden = false;
    button.setAttribute("aria-expanded", "true");
    setActive(Math.max(0, options.findIndex(function (li) { return li.getAttribute("aria-selected") === "true"; })));
    list.focus();
  }
  function closeList(focusButton) {
    list.hidden = true;
    button.setAttribute("aria-expanded", "false");
    if (focusButton) button.focus();
  }
  function choose(i) {
    var li = options[i];
    options.forEach(function (o) { o.setAttribute("aria-selected", String(o === li)); });
    selected = optionData(li);
    document.getElementById("net-url").textContent = selected.url;
    document.getElementById("net-name").textContent = selected.name;
    var mark = li.querySelector("svg").cloneNode(true);
    button.replaceChild(mark, button.querySelector(".net-mark"));
    var usageNet = document.getElementById("usage-net");
    if (usageNet) usageNet.textContent = selected.label;
    if (tryStatus) tryStatus.textContent = "";
    onNetworkChange();
  }
  function selectedOption() {
    return options.find(function (li) { return li.getAttribute("aria-selected") === "true"; }) || options[0];
  }
  if (button && list && options.length) {
    selected = optionData(selectedOption());
    button.addEventListener("click", function () { list.hidden ? openList() : closeList(true); });
    button.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); openList(); }
    });
    list.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); setActive(active + 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setActive(active - 1); }
      else if (e.key === "Home") { e.preventDefault(); setActive(0); }
      else if (e.key === "End") { e.preventDefault(); setActive(options.length - 1); }
      else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(active); closeList(true); }
      else if (e.key === "Escape" || e.key === "Tab") { closeList(e.key === "Escape"); }
    });
    // Delegated, so the list can be rebuilt from /api/networks.
    list.addEventListener("click", function (e) {
      var i = options.indexOf(e.target.closest('[role="option"]'));
      if (i >= 0) { choose(i); closeList(true); }
    });
    list.addEventListener("mousemove", function (e) {
      var i = options.indexOf(e.target.closest('[role="option"]'));
      if (i >= 0 && active !== i) setActive(i);
    });
    document.addEventListener("click", function (e) {
      if (!list.hidden && !list.contains(e.target) && !button.contains(e.target)) closeList(false);
    });
  }

  // ---- networks from /api/networks (apps/networks.ts, loaded at runtime): the picker is rebuilt
  // from the live list, so adding or stopping a network needs no deploy. The static options in
  // the HTML are the fallback without JavaScript or when the list cannot be read.
  var ETH_MARK = '<svg class="network-mark net-mark" viewBox="0 0 256 417" width="24" height="24" aria-hidden="true" focusable="false"><g fill="currentColor"><path fill-opacity=".8" d="M127.96 0l-2.8 9.5v275.67l2.8 2.79 127.96-75.64z"/><path fill-opacity=".45" d="M127.96 0L0 212.32l127.96 75.64V154.16z"/><path fill-opacity=".8" d="M127.96 312.19l-1.58 1.92v98.2l1.58 4.6L256 236.59z"/><path fill-opacity=".45" d="M127.96 416.9V312.19L0 236.59z"/><path d="M127.96 287.96l127.96-75.64-127.96-58.16z"/><path fill-opacity=".8" d="M0 212.32l127.96 75.64v-133.8z"/></g></svg>';
  var TESTNET_MARK = '<svg class="network-mark net-mark" viewBox="0 0 32 32" width="24" height="24" aria-hidden="true" focusable="false"><circle cx="16" cy="16" r="14.75" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="3.1 2.7" stroke-opacity=".8"/><g fill="currentColor" transform="translate(10.5 6.8) scale(.043)"><path fill-opacity=".8" d="M127.96 0l-2.8 9.5v275.67l2.8 2.79 127.96-75.64z"/><path fill-opacity=".45" d="M127.96 0L0 212.32l127.96 75.64V154.16z"/><path fill-opacity=".8" d="M127.96 312.19l-1.58 1.92v98.2l1.58 4.6L256 236.59z"/><path fill-opacity=".45" d="M127.96 416.9V312.19L0 236.59z"/><path d="M127.96 287.96l127.96-75.64-127.96-58.16z"/><path fill-opacity=".8" d="M0 212.32l127.96 75.64v-133.8z"/></g></svg>';
  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function rebuildNetworks(list_) {
    if (!list || !button || !list_.length) return;
    var groups = [["main", "Networks", list_.filter(function (n) { return !n.testnet; })], ["test", "Testnets", list_.filter(function (n) { return n.testnet; })]];
    var keep = list_.some(function (n) { return n.chain_id === selected.chain; }) ? selected.chain : list_[0].chain_id;
    list.replaceChildren();
    groups.forEach(function (g) {
      if (!g[2].length) return;
      var group = el("li", { role: "group", "aria-labelledby": "net-group-" + g[0] });
      group.appendChild(el("span", { class: "net-group", id: "net-group-" + g[0] }, g[1]));
      var ul = el("ul", { role: "presentation" });
      g[2].forEach(function (n) {
        var li = el("li", { role: "option", id: "net-opt-" + n.chain_id, "data-chain": String(n.chain_id), "data-url": n.url, "data-name": n.short_name, "data-label": n.name, "aria-selected": String(n.chain_id === keep) });
        li.insertAdjacentHTML("beforeend", n.chain_id === 1 ? ETH_MARK : n.testnet ? TESTNET_MARK : ETH_MARK);
        li.appendChild(el("span", { class: "net-opt-name" }, n.short_name));
        li.appendChild(el("span", { class: "net-sub" }, "ID " + n.chain_id));
        ul.appendChild(li);
        if (n.currency) WALLET_CHAINS[n.chain_id] = { chainName: n.short_name + " (nullrpc)", nativeCurrency: n.currency, explorer: n.explorer };
      });
      group.appendChild(ul);
      list.appendChild(group);
    });
    options = Array.prototype.slice.call(list.querySelectorAll('[role="option"]'));
    var i = options.indexOf(selectedOption());
    if (optionData(options[i]).chain !== selected.chain) choose(i);
  }
  getJSON("/api/networks").then(function (d) { if (d && Array.isArray(d.networks)) rebuildNetworks(d.networks); }, function () {});

  // ---- add to wallet (EIP-3085 wallet_addEthereumChain, injected EIP-1193 provider)
  var WALLET_CHAINS = {
    1: { chainName: "Ethereum (nullrpc)", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, explorer: "https://etherscan.io" },
    560048: { chainName: "Hoodi (nullrpc)", nativeCurrency: { name: "Hoodi Ether", symbol: "ETH", decimals: 18 }, explorer: "https://hoodi.etherscan.io" }
  };
  var walletButton = document.getElementById("add-wallet");
  var provider = window.ethereum;
  if (walletButton && provider && typeof provider.request === "function") {
    walletButton.hidden = false;
    walletButton.addEventListener("click", function () {
      var c = WALLET_CHAINS[selected.chain];
      if (!c || walletButton.getAttribute("data-state") === "busy") return;
      // A spinner while the wallet's prompt is open.
      clearTimeout(walletButton._flash);
      walletButton.setAttribute("data-state", "busy");
      walletButton.setAttribute("aria-busy", "true");
      tryStatus.textContent = "";
      var done = function () { walletButton.removeAttribute("data-state"); walletButton.removeAttribute("aria-busy"); };
      provider.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: "0x" + selected.chain.toString(16),
          chainName: c.chainName,
          nativeCurrency: c.nativeCurrency,
          rpcUrls: [selected.url],
          blockExplorerUrls: [c.explorer]
        }]
      }).then(function () {
        walletButton.removeAttribute("aria-busy");
        flash(walletButton, "Added", 2500);
      }, function (err) {
        done();
        if (err && err.code === 4001) return; // the user closed the wallet prompt
        if (selected.chain === 1) tryStatus.textContent = "Your wallet already has Ethereum mainnet. Add " + selected.url + " as a custom RPC in its network settings.";
        else tryStatus.textContent = "Your wallet could not add the network. Add " + selected.url + " in its network settings.";
      });
    });
  }

  // ---- traffic charts
  var usage = document.getElementById("usage");
  if (!usage) return;
  var range = "24h";
  var charts = {};
  var lastData = null;
  var usageStatus = document.getElementById("usage-status");
  var chartLoad = null;

  function loadChartJs() {
    if (chartLoad) return chartLoad;
    chartLoad = new Promise(function (resolve, reject) {
      if (window.Chart) return resolve(window.Chart);
      var s = document.createElement("script");
      s.src = "/vendor/chart.umd.min.js";
      s.async = true;
      s.onload = function () { window.Chart ? resolve(window.Chart) : reject(new Error("Chart.js")); };
      s.onerror = function () { chartLoad = null; reject(new Error("Chart.js")); };
      document.head.appendChild(s);
    });
    return chartLoad;
  }

  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function rgba(hex, a) {
    var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (!m) return hex;
    return "rgba(" + parseInt(m[1], 16) + "," + parseInt(m[2], 16) + "," + parseInt(m[3], 16) + "," + a + ")";
  }
  function timeLabel(t, withDay) {
    var d = new Date(t * 1000);
    var opts = withDay ? { weekday: "short", day: "numeric" } : { hour: "2-digit", minute: "2-digit", hour12: false };
    return new Intl.DateTimeFormat(undefined, opts).format(d);
  }
  function tooltipTime(t) {
    return new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(t * 1000));
  }

  // A vertical guide line at the hovered point.
  var crosshair = {
    id: "crosshair",
    afterDatasetsDraw: function (chart) {
      var active = chart.tooltip && chart.tooltip.getActiveElements();
      if (!active || !active.length) return;
      var x = active[0].element.x, area = chart.chartArea, ctx = chart.ctx;
      ctx.save();
      ctx.strokeStyle = rgba(cssVar("--nr-accent"), 0.5);
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, area.top);
      ctx.lineTo(x, area.bottom);
      ctx.stroke();
      ctx.restore();
    }
  };

  function makeChart(Chart, canvas, fmtY, fmtTip) {
    var accent = cssVar("--nr-accent");
    return new Chart(canvas, {
      type: "line",
      data: { datasets: [{
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
        backgroundColor: function (ctx) {
          var area = ctx.chart.chartArea;
          if (!area) return "transparent";
          var g = ctx.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
          var c = cssVar("--nr-accent");
          g.addColorStop(0, rgba(c, 0.14));
          g.addColorStop(1, rgba(c, 0));
          return g;
        }
      }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: reduceMotion.matches ? false : { duration: 700, easing: "easeOutQuart" },
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
            titleFont: { family: cssVar("--nr-font-mono"), size: 11, weight: "normal" },
            bodyFont: { family: cssVar("--nr-font-sans"), size: 14, weight: "600" },
            padding: 10,
            cornerRadius: 6,
            displayColors: false,
            callbacks: {
              title: function (items) { return items.length ? tooltipTime(items[0].parsed.x) : ""; },
              label: function (item) { return fmtTip(item.raw); }
            }
          }
        },
        scales: {
          x: {
            type: "linear",
            display: false, // shown once there is data (render)
            grid: { display: false },
            border: { display: false },
            ticks: {
              color: cssVar("--nr-text-secondary"),
              font: { family: cssVar("--nr-font-mono"), size: 11 },
              maxTicksLimit: 6,
              maxRotation: 0,
              callback: function (v) { return timeLabel(v, range === "7d"); }
            }
          },
          y: {
            display: false,
            beginAtZero: true,
            grace: "10%",
            border: { display: false },
            grid: { color: rgba(cssVar("--nr-border"), 0.6), drawTicks: false },
            ticks: {
              color: cssVar("--nr-text-secondary"),
              font: { family: cssVar("--nr-font-mono"), size: 11 },
              maxTicksLimit: 5,
              padding: 8,
              callback: function (v) { return fmtY(v); }
            }
          }
        }
      },
      plugins: [crosshair]
    });
  }

  function perSecond(v, bucket) { return bucket > 0 ? v / bucket : 0; }

  function setAxes(show) {
    [charts.requests, charts.egress].forEach(function (chart) {
      chart.options.scales.x.display = show;
      chart.options.scales.y.display = show;
    });
  }

  function render(data) {
    lastData = data;
    if (!data || !data.available) {
      // Nothing to plot: clear the previous network's numbers and hide the empty axes.
      ["total-requests", "total-egress"].forEach(function (id) { document.getElementById(id).textContent = "–"; });
      ["rate-requests", "rate-egress"].forEach(function (id) { document.getElementById(id).textContent = "\u00a0"; });
      setAxes(false);
      [charts.requests, charts.egress].forEach(function (chart) { chart.data.datasets[0].data = []; chart.update("none"); });
      usageStatus.textContent = "No traffic data for the " + selected.label + " endpoint yet.";
      return;
    }
    var empty = !data.totals.requests;
    usageStatus.textContent = empty ? "No requests to the " + selected.label + " endpoint in the last " + data.range + "." : "";
    setAxes(!empty);
    var b = data.bucket_s || 60;
    var span = (data.to - data.from) || 1;
    document.getElementById("total-requests").textContent = compact(data.totals.requests);
    document.getElementById("rate-requests").textContent = "avg " + compact(data.totals.requests / span) + " req/s · last " + data.range;
    document.getElementById("total-egress").textContent = bytes(data.totals.response_bytes);
    document.getElementById("rate-egress").textContent = "avg " + bytes(data.totals.response_bytes / span) + "/s · last " + data.range;
    var req = [], eg = [];
    data.series.forEach(function (p) {
      req.push({ x: p[0], y: perSecond(p[1], b), n: p[1] });
      eg.push({ x: p[0], y: perSecond(p[2], b), n: p[2] });
    });
    // The newest bucket is still filling; plot it, but it is not a drop in traffic.
    [[charts.requests, req], [charts.egress, eg]].forEach(function (pair) {
      var chart = pair[0];
      chart.data.datasets[0].data = empty ? [] : pair[1];
      chart.options.scales.x.min = data.from;
      chart.options.scales.x.max = data.series.length ? data.series[data.series.length - 1][0] : data.to;
      chart.update();
    });
    charts.requests.canvas.setAttribute("aria-label",
      "Requests over the last " + data.range + ": " + nf.format(data.totals.requests) + " in total.");
    charts.egress.canvas.setAttribute("aria-label",
      "Data egress over the last " + data.range + ": " + bytes(data.totals.response_bytes) + " in total.");
  }

  // Skeleton while a network or range loads: the totals and charts shimmer until the data arrives.
  function setLoading(on) {
    usage.classList.toggle("is-loading", on);
    if (on) usage.setAttribute("aria-busy", "true");
    else usage.removeAttribute("aria-busy");
  }

  var inflight = 0;
  // `quiet`: the periodic refresh, which updates in place without the skeleton.
  function loadUsage(quiet) {
    var mine = ++inflight;
    if (quiet !== true) setLoading(true);
    var done = function (data) { if (mine === inflight) { setLoading(false); render(data); } };
    return getJSON("/api/usage?chain=" + selected.chain + "&range=" + range).then(done, function () { done(null); });
  }

  function start() {
    setLoading(true);
    // Measure axis labels with the page's fonts, not the fallback (labels would be clipped).
    var fontsReady = document.fonts && document.fonts.load
      ? Promise.all([document.fonts.load('400 11px "IBM Plex Mono"'), document.fonts.load('600 14px "IBM Plex Sans"')]).catch(function () {})
      : Promise.resolve();
    Promise.all([loadChartJs(), fontsReady]).then(function (loaded) {
      var Chart = loaded[0];
      Chart.defaults.font.family = cssVar("--nr-font-sans");
      function build() {
        charts.requests = makeChart(Chart, document.getElementById("chart-requests"),
          function (v) { return compact(v) + "/s"; },
          function (p) { return compact(p.y) + " req/s · " + nf.format(Math.round(p.n)) + " requests"; });
        charts.egress = makeChart(Chart, document.getElementById("chart-egress"),
          function (v) { return bytes(v) + "/s"; },
          function (p) { return bytes(p.y) + "/s · " + bytes(p.n); });
      }
      build();
      loadUsage();
      onNetworkChange = loadUsage;
      setInterval(function () { if (visible()) loadUsage(true); }, 60000);
      // Rebuild with the other theme's colors when the OS setting flips.
      var dark = window.matchMedia("(prefers-color-scheme: dark)");
      if (dark.addEventListener) dark.addEventListener("change", function () {
        charts.requests.destroy();
        charts.egress.destroy();
        build();
        if (lastData) render(lastData);
      });
    }, function () {
      setLoading(false);
      usageStatus.textContent = "Could not load the charts. Live status is at status.nullrpc.dev.";
    });
  }

  usage.querySelectorAll("button[data-range]").forEach(function (button) {
    button.addEventListener("click", function () {
      range = button.getAttribute("data-range");
      usage.querySelectorAll("button[data-range]").forEach(function (b) {
        b.setAttribute("aria-pressed", String(b === button));
      });
      if (charts.requests) loadUsage();
      else kick();
    });
  });

  var started = false;
  function kick() { if (!started) { started = true; start(); } }
  // Also start on intent, not only on scroll: picking a network or following a #try link.
  kickCharts = kick;
  if (location.hash === "#try") kick();
  window.addEventListener("hashchange", function () { if (location.hash === "#try") kick(); });
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      if (entries.some(function (e) { return e.isIntersecting; })) { io.disconnect(); kick(); }
    }, { rootMargin: "600px 0px" });
    io.observe(usage);
  } else {
    kick();
  }
})();
