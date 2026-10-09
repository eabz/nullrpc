// nullrpc account page. Plain JavaScript; the wallet is used through
// EIP-1193 (`personal_sign`, `eth_sendTransaction`), discovered with EIP-6963.
// Every value is written with textContent; no HTML is built from data.
"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const h = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of children) node.append(c);
    return node;
  };
  const fmt = (n) => Math.round(n).toLocaleString("en-US");
  const compact = (n) => (n >= 1e9 ? (n / 1e9).toFixed(n % 1e9 ? 1 : 0) + "B" : n >= 1e6 ? (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));
  const date = (ms) => new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  const usd = (n) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
  // Prices below a cent keep three decimals ($0.045).
  const price = (n) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: n < 0.1 ? 3 : 2, maximumFractionDigits: 3 });

  let config = null;
  let me = null;
  let provider = null;
  let range = "24h";

  // ---- Cloudflare Turnstile on sign-in: loaded only when the
  // platform has a site key. The widget is invisible unless Cloudflare asks for interaction.
  const turnstile = { id: null, token: null, waiters: [] };
  function loadTurnstile() {
    if (!config || !config.turnstile_site_key || turnstile.id !== null || document.getElementById("turnstile-js")) return;
    window.nullrpcTurnstileReady = () => {
      $("turnstile").hidden = false;
      turnstile.id = window.turnstile.render("#turnstile", {
        sitekey: config.turnstile_site_key,
        action: "signin",
        appearance: "interaction-only",
        callback: (token) => { turnstile.token = token; turnstile.waiters.splice(0).forEach((w) => w(token)); },
        "expired-callback": () => { turnstile.token = null; },
        "error-callback": () => { turnstile.token = null; },
      });
    };
    const script = document.createElement("script");
    script.id = "turnstile-js";
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=nullrpcTurnstileReady";
    script.async = true;
    document.head.append(script);
  }
  // The current token (single use), waiting up to 30 s for the widget; null when Turnstile is off.
  function turnstileToken() {
    if (!config || !config.turnstile_site_key) return Promise.resolve(null);
    if (turnstile.token) return Promise.resolve(turnstile.token);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error("The browser check did not finish. Reload the page and try again."), { status: 0 })), 30000);
      turnstile.waiters.push((token) => { clearTimeout(timer); resolve(token); });
    });
  }
  function resetTurnstile() {
    turnstile.token = null;
    if (turnstile.id !== null && window.turnstile) window.turnstile.reset(turnstile.id);
  }

  function banner(text) {
    $("banner").hidden = !text;
    $("banner").textContent = text || "";
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      credentials: "same-origin",
      headers: options.body ? { "content-type": "application/json" } : {},
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(body.error || "HTTP " + res.status);
      error.status = res.status;
      throw error;
    }
    return body;
  }
  const post = (path, value) => api(path, { method: "POST", body: JSON.stringify(value || {}) });

  // ---- wallets (EIP-6963, then window.ethereum)

  const wallets = new Map();
  window.addEventListener("eip6963:announceProvider", (e) => {
    const { info, provider: p } = e.detail || {};
    if (info && p && !wallets.has(info.uuid)) {
      wallets.set(info.uuid, { name: info.name, provider: p });
      renderWallets();
    }
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));

  function renderWallets() {
    const list = [...wallets.values()];
    if (!list.length && window.ethereum) list.push({ name: "Browser wallet", provider: window.ethereum });
    const box = $("wallets");
    box.replaceChildren(
      ...(list.length
        ? // One wallet: just "Connect"; several: name each one.
          list.map((w) => {
            const button = h("button", { type: "button", class: "btn signin-btn" },
              h("span", { class: "spinner", "aria-hidden": "true" }),
              h("span", { class: "btn-text" }, list.length === 1 ? "Connect" : "Connect " + w.name));
            button.addEventListener("click", () => signIn(w.provider, button));
            return button;
          })
        : [h("p", { class: "note" }, "No Ethereum wallet found. Install a browser wallet such as MetaMask, Rabby or Coinbase Wallet, then reload.")]),
    );
  }

  // The button shows a spinner until the wallet is connected and the message signed. No text
  // is shown under it: a cancelled or failed sign-in just resets the button.
  async function signIn(p, button) {
    const buttons = [...$("wallets").querySelectorAll("button")];
    if (button.getAttribute("data-state") === "busy") return;
    button.setAttribute("data-state", "busy");
    button.setAttribute("aria-busy", "true");
    buttons.forEach((b) => (b.disabled = true));
    try {
      const [address] = await p.request({ method: "eth_requestAccounts" });
      const { message, token } = await api("/api/auth/nonce?address=" + encodeURIComponent(address));
      const signature = await p.request({ method: "personal_sign", params: [toHex(message), address] });
      const human = await turnstileToken();
      await post("/api/auth/verify", { message, signature, token, ...(human ? { turnstile: human } : {}) });
      provider = p;
      banner("");
      await load();
    } catch (error) {
      if (error.code !== 4001) console.error("sign-in failed", error);
      // Refusals from the platform (sign-up limits, the browser check) are shown; a cancelled
      // or failed wallet request just resets the button.
      if (error.status !== undefined) banner(error.message);
    } finally {
      if (config && config.turnstile_site_key) resetTurnstile();
      button.removeAttribute("data-state");
      button.removeAttribute("aria-busy");
      buttons.forEach((b) => (b.disabled = false));
    }
  }

  function toHex(text) {
    return "0x" + [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // ---- account

  async function load() {
    try {
      me = await api("/api/me");
    } catch (error) {
      if (error.status === 401) {
        me = null;
        $("app").hidden = true;
        $("signout").hidden = true;
        $("signin").hidden = false;
        renderWallets();
        return;
      }
      banner("Could not load your account: " + error.message);
      return;
    }
    $("signin").hidden = true;
    $("app").hidden = false;
    $("signout").hidden = false;
    $("who-address").textContent = short(me.account.address);
    $("who-address").title = me.account.address;
    $("signout").setAttribute("aria-label", "Sign out " + me.account.address);
    renderAccount();
    renderKeys();
    renderPlans();
    loadUsage();
    loadInvoices();
    if (me.terms && !me.terms.accepted) openTerms();
  }

  // ---- Terms of Service: accepted once per version before keys and payments.
  // The full text is shown in the dialog (public/legal/terms.html, a copy of the landing page kept
  // equal by a test; it holds an English and a Spanish article). The checkbox and Accept unlock
  // only once the text has been scrolled to its end.
  let termsLang = (navigator.languages || [navigator.language || ""]).some((l) => /^es\b/i.test(l)) ? "es" : "en";
  let termsRead = false;
  async function showTermsText() {
    const box = $("terms-body");
    box.replaceChildren(h("p", { class: "panel-muted" }, "Loading…"));
    box.scrollTop = 0;
    try {
      const res = await fetch("/legal/terms.html", { credentials: "same-origin" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      // Our own static page, parsed inertly; only its <article> is moved into the dialog.
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      const article = doc.querySelector('article.legal[lang="' + termsLang + '"]');
      if (!article) throw new Error("no article");
      article.querySelector(".legal-toc")?.remove();
      for (const a of article.querySelectorAll("a[href]")) {
        const href = a.getAttribute("href");
        if (href.startsWith("/")) a.setAttribute("href", "https://nullrpc.dev" + href);
        if (!href.startsWith("#")) { a.setAttribute("target", "_blank"); a.setAttribute("rel", "noopener"); }
      }
      box.replaceChildren(document.importNode(article, true));
    } catch {
      box.replaceChildren(h("p", {}, "The Terms could not be loaded here. Read them at ", h("a", { href: "https://nullrpc.dev/terms#" + termsLang, target: "_blank", rel: "noopener" }, "nullrpc.dev/terms"), ", then reload this page."));
    }
    checkTermsRead();
  }
  function checkTermsRead() {
    const box = $("terms-body");
    if (!termsRead && box.querySelector("article") && box.scrollTop + box.clientHeight >= box.scrollHeight - 16) termsRead = true;
    $("terms-check").disabled = !termsRead;
    $("terms-hint").textContent = termsRead ? "You have reached the end of the Terms." : "Scroll to the end of the Terms to accept them.";
    $("terms-accept").disabled = !termsRead || !$("terms-check").checked;
  }
  $("terms-body").addEventListener("scroll", checkTermsRead, { passive: true });
  for (const b of document.querySelectorAll("#terms-lang button")) {
    b.addEventListener("click", () => {
      termsLang = b.dataset.lang;
      for (const o of document.querySelectorAll("#terms-lang button")) o.setAttribute("aria-checked", String(o === b));
      showTermsText();
    });
  }
  function openTerms() {
    for (const o of document.querySelectorAll("#terms-lang button")) o.setAttribute("aria-checked", String(o.dataset.lang === termsLang));
    $("terms-version").textContent = me.terms.version;
    $("terms-check").checked = false;
    termsRead = false;
    if (!$("terms").open) $("terms").showModal();
    showTermsText();
  }
  // The dialog cannot be dismissed: accept, or sign out.
  $("terms").addEventListener("cancel", (e) => e.preventDefault());
  $("terms-check").addEventListener("change", checkTermsRead);
  $("terms-accept").addEventListener("click", () => busy($("terms-accept"), async () => {
    try {
      Object.assign(me, await post("/api/terms", { version: me.terms.version, accept: true }));
      $("terms").close();
    } catch (error) {
      banner("Could not save your acceptance: " + error.message);
    }
  }));
  $("terms-signout").addEventListener("click", async () => {
    $("terms").close();
    await post("/api/auth/logout").catch(() => {});
    provider = null;
    await load();
  });

  function renderAccount() {
    const a = me.account;
    const unverified = a.plan.id === "unverified";
    const paid = a.plan.id !== "free" && !unverified;
    const offer = config.plans.find((p) => p.id === a.plan.id);
    $("plan-name").textContent = a.plan.name;
    const status = $("plan-status");
    status.textContent = paid ? "Active until " + date(a.paid_until || a.period.end) : "Free";
    status.dataset.tone = a.exhausted ? "warn" : paid ? "ok" : "neutral";
    if (a.exhausted) status.textContent = "Quota used up";
    if (unverified) status.textContent = "No free credits";
    renderGate(a);
    $("plan-tags").replaceChildren(
      h("span", { class: "tag tag-accent" }, offer && offer.price_usd ? usd(offer.price_usd).replace(".00", "") + " / month" : "$0 / month"),
      h("span", { class: "tag" }, compact(a.plan.included_credits) + " credits / month"),
      h("span", { class: "tag" }, fmt(a.plan.rps) + " req/s"),
    );
    const pct = a.plan.included_credits ? Math.min(100, (100 * a.period.credits) / a.plan.included_credits) : 100;
    $("plan-bar").style.width = pct.toFixed(1) + "%";
    $("plan-bar").parentElement.dataset.level = pct >= 100 ? "full" : pct >= 80 ? "high" : "ok";
    $("plan-usage").textContent = fmt(a.period.credits) + " of " + compact(a.plan.included_credits) + " credits used";
    $("plan-pct").textContent = (pct > 0 && pct < 1 ? "<1" : Math.round(pct)) + "%";
    $("plan-period").textContent = "Credits reset on " + date(a.period.end) + (paid && a.paid_until ? " · paid until " + date(a.paid_until) : "");
    $("plan-exhausted").hidden = !a.exhausted || unverified;
    // Rate limit, with this hour's average throughput against it.
    $("plan-rps").textContent = fmt(a.plan.rps);
    const rps = a.throughput ? a.throughput.rps : 0;
    $("rps-bar").style.width = Math.min(100, (100 * rps) / a.plan.rps).toFixed(1) + "%";
    $("plan-throughput").textContent = "Now " + (rps === 0 ? "0" : rps >= 10 ? fmt(rps) : rps.toFixed(rps >= 1 ? 1 : 2)) + " req/s · average this hour";
    // Free: one call to action. Paid: change plan, or renew the current one.
    $("plan-change").textContent = paid ? "Change plan" : "Upgrade";
    $("plan-renew").hidden = !paid || !(offer && offer.price_usd);
    if (paid) $("plan-renew").textContent = "Renew " + a.plan.name;
  }

  $("plan-change").addEventListener("click", () => openCheckout(["free", "unverified"].includes(me.account.plan.id) ? config.recommended : me.account.plan.id));

  // ---- Free-plan gate: an `unverified` wallet gets no free credits.
  function renderGate(a) {
    const box = $("plan-unverified");
    box.hidden = a.plan.id !== "unverified";
    if (box.hidden) return;
    const w = a.wallet || {};
    const rule = "A wallet qualifies with at least " + (w.min_nonce || 5) + " transactions or " + (w.min_balance_eth || 0.005) + " ETH on Ethereum mainnet.";
    $("plan-unverified-text").textContent =
      w.check === "pending" ? "We could not check your wallet just now. Check again shortly. " + rule
      : w.check === "capped" ? "Your wallet qualifies, but today's free sign-ups are full. Check again tomorrow. " + rule
      : "This wallet has no on-chain history yet. " + rule + " Any paid plan works right away and keeps Free available after it ends.";
  }
  $("gate-builder").addEventListener("click", () => openCheckout("builder"));
  $("gate-recheck").addEventListener("click", () => busy($("gate-recheck"), async () => {
    try {
      const result = await post("/api/wallet/check");
      me.account = result.account;
      renderAccount();
      banner("");
    } catch (error) {
      banner(error.message);
    }
  }));
  $("plan-renew").addEventListener("click", () => openCheckout(me.account.plan.id));

  // One copy button for the whole page: copy icon, then a check for 2 s. `text` may be a function.
  function copyButton(text, label = "Copy") {
    const b = h("button", { type: "button", class: "copy-btn" },
      icon("ic-main", [["rect", { x: "8", y: "8", width: "12", height: "12", rx: "2" }], ["path", { d: "M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" }]]),
      icon("ic-check", [["path", { d: "M5 12.5l4.5 4.5L19 7.5" }]]),
      h("span", { class: "btn-text" }, label));
    b.addEventListener("click", () => {
      navigator.clipboard.writeText(typeof text === "function" ? text() : text).then(() => {
        b.setAttribute("data-state", "done");
        b.querySelector(".btn-text").textContent = "Copied";
        clearTimeout(b._t);
        b._t = setTimeout(() => { b.removeAttribute("data-state"); b.querySelector(".btn-text").textContent = label; }, 2000);
      }, () => {});
    });
    return b;
  }


  function renderKeys() {
    const list = $("keys");
    const active = me.keys.filter((k) => k.key);
    const max = config.max_keys || 5;
    $("keys-count").textContent = active.length + " of " + max + " keys";
    // At the limit: the form stays visible but disabled, with the reason as its placeholder.
    const full = active.length >= max;
    $("key-name").disabled = full;
    $("key-form").querySelector("button").disabled = full;
    $("key-name").placeholder = full ? "Key limit reached: revoke a key to create another" : "Name your key, for example production";
    if (!active.length) {
      list.replaceChildren(h("li", { class: "keys-empty" },
        icon("ic-key", [["circle", { cx: "8", cy: "15", r: "4" }], ["path", { d: "M10.8 12.2L20 3M16 7l3 3M14 9l2 2" }]]),
        h("p", { class: "keys-empty-title" }, "No API keys yet"),
        h("p", { class: "panel-muted" }, "Create one above to send requests with your plan's quota and rate.")));
      return;
    }
    const eye = () => icon("ic-eye", [["path", { d: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" }], ["circle", { cx: "12", cy: "12", r: "3" }]]);
    list.replaceChildren(
      ...active.map((k) => {
        const masked = k.key.slice(0, 7) + "•".repeat(12) + k.key.slice(-4);
        const keyCode = h("code", { class: "key-value" }, masked);
        const reveal = h("button", { type: "button", class: "icon-btn", "aria-label": "Show key", title: "Show key" }, eye());
        reveal.addEventListener("click", () => {
          const shown = keyCode.textContent === k.key;
          keyCode.textContent = shown ? masked : k.key;
          reveal.setAttribute("aria-label", shown ? "Show key" : "Hide key");
          reveal.title = shown ? "Show key" : "Hide key";
          reveal.classList.toggle("is-on", !shown);
        });
        const revoke = h("button", { type: "button", class: "link-danger" }, "Revoke");
        revoke.addEventListener("click", async () => {
          if (!(await confirmDialog({ title: "Revoke \u201c" + k.name + "\u201d?", text: "Requests using this key stop working within a minute. This can't be undone.", action: "Revoke key" }))) return;
          try {
            me.keys = (await api("/api/keys/" + k.id, { method: "DELETE" })).keys;
            renderKeys();
          } catch (error) {
            banner("Could not revoke the key: " + error.message);
          }
        });
        // The key's ready-to-use URL on the public Ethereum endpoint (same as the Docs examples).
        const urls = [h("div", { class: "key-endpoint" },
          h("span", { class: "tag" }, "Ethereum"),
          h("code", {}, DOCS_URL + "/" + k.key.slice(0, 7) + "…"),
          copyButton(DOCS_URL + "/" + k.key, "Copy URL"))];
        return h("li", { class: "key-card" },
          h("div", { class: "key-card-head" },
            h("div", {}, h("p", { class: "key-name" }, k.name), h("p", { class: "panel-muted" }, "Created " + date(k.created_at))),
            revoke),
          h("div", { class: "key-field" }, keyCode, reveal, copyButton(k.key, "Copy key")),
          ...urls);
      }),
    );
  }


  $("key-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      me.keys = (await post("/api/keys", { name: $("key-name").value })).keys;
      $("key-name").value = "";
      renderKeys();
    } catch (error) {
      banner("Could not create the key: " + error.message);
    }
  });

  // ---- usage chart (hourly bars)

  // ---- usage (Chart.js, vendored in /vendor and loaded the first time the Usage tab shows)
  let usageData = null;
  let usageMetric = "credits";
  let usageChart = null;
  let chartLoad = null;

  // `fresh`: the range changed, so the shown numbers are stale; show the skeleton until the data arrives.
  let usageSeq = 0;
  async function loadUsage(fresh = false) {
    const seq = ++usageSeq;
    const loading = fresh || !usageData;
    if (loading) { $("app").classList.add("usage-loading"); $("app").setAttribute("aria-busy", "true"); }
    let data;
    try {
      data = await api("/api/usage?range=" + range);
    } catch {
      data = null;
    }
    if (seq !== usageSeq) return;
    $("app").classList.remove("usage-loading");
    $("app").removeAttribute("aria-busy");
    if (!data) return;
    usageData = data;
    renderUsageStats();
    if (!$("panel-overview").hidden) drawUsage();
  }

  // Hourly buckets for the range, oldest first, with gaps filled.
  function usageSeries() {
    const hours = { "24h": 24, "7d": 168, "30d": 720 }[usageData.range] || 24;
    const out = [];
    const byHour = new Map(usageData.series.map((r) => [r.hour, r]));
    for (let i = 0; i < hours; i++) {
      const hour = usageData.since_hour + i;
      const r = byHour.get(hour);
      out.push({ t: hour * 3600 * 1000, credits: r ? r.units : 0, requests: r ? r.requests : 0 });
    }
    return out;
  }

  function renderUsageStats() {
    const series = usageSeries();
    const requests = series.reduce((a, b) => a + b.requests, 0);
    const credits = series.reduce((a, b) => a + b.credits, 0);
    const peak = series.reduce((a, b) => (b.credits > a.credits ? b : a), series[0]);
    const label = { "24h": "24 hours", "7d": "7 days", "30d": "30 days" }[usageData.range];
    $("usage-requests").textContent = compact(requests);
    $("usage-requests-rate").textContent = (requests / (series.length * 3600)).toFixed(requests ? 2 : 0) + " req/s average · last " + label;
    $("usage-credits").textContent = compact(credits);
    $("usage-credits-share").textContent = me && me.account ? ((100 * credits) / me.account.plan.included_credits).toFixed(credits ? 2 : 0) + "% of your monthly credits" : "";
    $("usage-peak-when").textContent = peak && peak.credits
      ? "Peak " + compact(peak.credits) + " credits/h, " + new Date(peak.t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
      : "A typical call is about 20";
    $("usage-avg").textContent = requests ? (credits / requests).toFixed(1) : "–";
    $("usage-empty").hidden = requests > 0;

    // Per key, named from the account's keys (revoked keys keep their name).
    const names = new Map((me.keys || []).map((k) => [k.id, k.name + (k.key ? "" : " (revoked)")]));
    const rows = [...usageData.by_key].sort((a, b) => b.units - a.units);
    $("usage-keys").replaceChildren(...(rows.length
      ? rows.map((r) => {
          const share = credits ? (100 * r.units) / credits : 0;
          return h("tr", {},
            h("td", { class: "cell-item" }, names.get(r.key_id) || "Unknown key"),
            h("td", { class: "num" }, fmt(r.requests)),
            h("td", { class: "num" }, fmt(r.units)),
            h("td", {}, h("div", { class: "share" }, h("div", { class: "meter meter-sm" }, h("span")), h("span", { class: "num share-pct" }, share.toFixed(share < 10 ? 1 : 0) + "%"))));
        })
      : [h("tr", {}, h("td", { colspan: "4", class: "table-empty" }, "No requests with your keys in this range."))]));
    // Bar widths are set through the CSSOM (no inline style attributes; CSP style-src 'self').
    [...$("usage-keys").querySelectorAll(".share .meter span")].forEach((span, i) => {
      span.style.width = (credits ? (100 * rows[i].units) / credits : 0).toFixed(1) + "%";
    });
  }

  function loadChartJs() {
    if (chartLoad) return chartLoad;
    const fonts = document.fonts && document.fonts.load
      ? Promise.all([document.fonts.load('400 11px "IBM Plex Mono"'), document.fonts.load('500 13px "IBM Plex Sans"')]).catch(() => {})
      : Promise.resolve();
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

  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  function rgba(hex, a) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    return m ? "rgba(" + parseInt(m[1], 16) + "," + parseInt(m[2], 16) + "," + parseInt(m[3], 16) + "," + a + ")" : hex;
  }

  async function drawUsage() {
    if (!usageData) return;
    let Chart;
    try {
      Chart = await loadChartJs();
    } catch {
      $("usage-empty").hidden = false;
      $("usage-empty").textContent = "Could not load the chart.";
      return;
    }
    const series = usageSeries();
    const metric = usageMetric;
    $("usage-chart-title").textContent = (metric === "credits" ? "Credits" : "Requests") + " per hour";
    const points = series.map((p) => ({ x: p.t, y: p[metric] }));
    const long = usageData.range !== "24h";
    const fmtTick = (v) => new Intl.DateTimeFormat(undefined, long ? { month: "short", day: "numeric" } : { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(v));
    if (usageChart) usageChart.destroy();
    const accent = cssVar("--nr-accent");
    usageChart = new Chart($("usage-canvas"), {
      type: "bar",
      data: { datasets: [{
        data: points,
        parsing: false,
        borderRadius: 3,
        barPercentage: 0.9,
        categoryPercentage: 1,
        backgroundColor: (ctx) => {
          const area = ctx.chart.chartArea;
          if (!area) return accent;
          const g = ctx.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
          g.addColorStop(0, accent);
          g.addColorStop(1, rgba(accent, 0.35));
          return g;
        },
        hoverBackgroundColor: accent,
      }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: matchMedia("(prefers-reduced-motion: reduce)").matches ? false : { duration: 500 },
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: cssVar("--nr-surface"),
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
              title: (items) => (items.length ? new Date(items[0].parsed.x).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""),
              label: (item) => fmt(item.parsed.y) + " " + metric,
            },
          },
        },
        scales: {
          x: {
            type: "linear",
            offset: true,
            min: series[0].t - 1800e3,
            max: series[series.length - 1].t + 1800e3,
            grid: { display: false },
            border: { display: false },
            ticks: { color: cssVar("--nr-text-secondary"), font: { family: cssVar("--nr-font-sans"), size: 11 }, maxRotation: 0, autoSkip: false, callback: fmtTick },
            // Ticks on clock boundaries (local time): every 4 h for 24h, midnights for 7d, every 5th midnight for 30d.
            afterBuildTicks: (axis) => {
              const out = [];
              const t = new Date(axis.min);
              t.setMinutes(0, 0, 0);
              if (long) t.setHours(24, 0, 0, 0);
              else t.setHours(Math.ceil((t.getHours() + (t.getTime() < axis.min ? 1 : 0)) / 4) * 4);
              for (let n = 0; t.getTime() <= axis.max; n++) {
                if (usageData.range !== "30d" || n % 5 === 0) out.push({ value: t.getTime() });
                if (long) t.setDate(t.getDate() + 1);
                else t.setHours(t.getHours() + 4);
              }
              axis.ticks = out;
            },
          },
          y: {
            beginAtZero: true,
            grace: "10%",
            border: { display: false },
            grid: { color: rgba(cssVar("--nr-border"), 0.7), drawTicks: false },
            ticks: { color: cssVar("--nr-text-secondary"), font: { family: cssVar("--nr-font-sans"), size: 11 }, maxTicksLimit: 5, padding: 8, precision: 0, callback: (v) => compact(v) },
          },
        },
      },
    });
    $("usage-canvas").setAttribute("aria-label", (metric === "credits" ? "Credits" : "Requests") + " per hour over the last " + usageData.range);
  }

  for (const b of document.querySelectorAll("#usage-metric button")) {
    b.addEventListener("click", () => {
      usageMetric = b.dataset.metric;
      for (const o of document.querySelectorAll("#usage-metric button")) o.setAttribute("aria-checked", String(o === b));
      drawUsage();
    });
  }
  // Redraw in the other theme's colors when the OS setting flips.
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (usageChart && !$("panel-overview").hidden) drawUsage(); });


  for (const b of document.querySelectorAll("#range button")) {
    b.addEventListener("click", () => {
      range = b.dataset.range;
      for (const o of document.querySelectorAll("#range button")) o.setAttribute("aria-checked", String(o === b));
      loadUsage(true);
    });
  }

  // ---- plans and payments

  const rank = (id) => config.plans.findIndex((p) => p.id === id);

  // ---- checkout dialog: plan, billing period (1, 6, 12 months, discounted) and asset, then pay.
  const PLAN_ICONS = {
    free: "M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.8 2.8M14.9 14.9l2.8 2.8M6.3 17.7l2.8-2.8M14.9 9.1l2.8-2.8",
    builder: "M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5",
    growth: "M3 17l6-6 4 4 8-8M15 7h6v6",
    scale: "M12 2.5l9 4.5-9 4.5L3 7zM3 12l9 4.5 9-4.5M3 16.5l9 4.5 9-4.5",
  };
  const checkout = { plan: "builder", months: 1 };

  // Payments are USDC only, on the network the server offers (Ethereum), sent to the treasury.
  const payNetwork = () => config.networks.find((n) => n.assets.includes("USDC"));

  function renderPlans() {
    const n = payNetwork();
    if (!n) {
      $("pay-with").replaceChildren(h("p", { class: "pay-none" }, "Payments are unavailable right now. Please try again later."));
      $("checkout-pay").disabled = true;
      return;
    }
    const treasury = h("code", { class: "pay-treasury", title: config.treasury }, short(config.treasury));
    $("pay-with").replaceChildren(
      h("div", { class: "pay-asset" },
        h("span", { class: "usdc-mark", "aria-hidden": "true" }, "$"),
        h("span", { class: "pay-asset-text" }, h("strong", {}, "USDC"), h("span", {}, "on " + n.name))),
      h("p", { class: "pay-dest" }, "Sent to the nullrpc treasury ",
        n.explorer ? h("a", { href: n.explorer + "/address/" + config.treasury, target: "_blank", rel: "noopener" }, treasury) : treasury),
    );
  }

  // ---- billing details and tax (server-computed: POST /api/checkout)
  // ISO 3166-1 alpha-2, without the countries nullrpc cannot serve (src/sanctioned.json).
  const COUNTRIES = ("AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IS IT JE JM JO JP KE KG KH KI KM KN KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW").split(" ");
  const EU = new Set("AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE".split(" "));
  let quote = null;
  let quoteSeq = 0;

  function renderCountries() {
    const names = typeof Intl.DisplayNames === "function" ? new Intl.DisplayNames(["en"], { type: "region" }) : null;
    const list = COUNTRIES.map((c) => [c, (names && names.of(c)) || c]).sort((a, b) => a[1].localeCompare(b[1]));
    $("bill-country").replaceChildren(h("option", { value: "" }, "Choose…"), ...list.map(([c, n]) => h("option", { value: c }, n)));
  }

  function billing() {
    return {
      name: $("bill-name").value.trim(),
      country: $("bill-country").value,
      tax_id: $("bill-tax").value.trim(),
      address: $("bill-address").value.trim(),
      business: $("bill-business").checked,
    };
  }
  const billingReady = (b) => b.name && b.country && (!b.business || b.tax_id);

  function fillBilling() {
    const b = me.billing || {};
    $("bill-name").value = b.name || "";
    $("bill-country").value = b.country || "";
    $("bill-tax").value = b.tax_id || "";
    $("bill-address").value = b.address || "";
    $("bill-business").checked = !!b.business;
  }

  // Re-quotes the tax and the acknowledgement text for the current plan, term and billing details.
  async function requote() {
    const b = billing();
    const country = b.country;
    $("bill-tax-label").textContent = country === "MX" ? "RFC" + (b.business ? "" : " (optional)") : EU.has(country) ? "VAT ID" + (b.business ? "" : " (optional)") : "Tax ID" + (b.business ? "" : " (optional)");
    const seq = ++quoteSeq;
    if (!billingReady(b)) {
      quote = null;
    } else {
      try {
        quote = await post("/api/checkout", { plan: checkout.plan, months: checkout.months, billing: b });
        $("pay-status").textContent = "";
      } catch (error) {
        quote = null;
        $("pay-status").textContent = error.message;
      }
    }
    if (seq !== quoteSeq) return;
    if (quote) $("checkout-statement").textContent = quote.statement;
    renderSummary();
  }
  let requoteTimer = 0;
  for (const id of ["bill-name", "bill-tax", "bill-address"]) $(id).addEventListener("input", () => { clearTimeout(requoteTimer); requoteTimer = setTimeout(requote, 400); });
  for (const id of ["bill-country", "bill-business"]) $(id).addEventListener("change", requote);

  function openCheckout(planId) {
    const paidActive = me.account.paid_until && me.account.paid_until > Date.now();
    const allowed = (p) => p.price_usd && !(paidActive && rank(p.id) < rank(me.account.plan.id));
    const pick = config.plans.find((p) => p.id === planId && allowed(p)) || config.plans.find(allowed);
    if (pick) checkout.plan = pick.id;
    $("pay-status").textContent = "";
    fillBilling();
    renderCheckout();
    $("checkout").showModal();
    requote();
  }

  function radio(selected, onPick, ...children) {
    const b = h("button", { type: "button", role: "radio", "aria-checked": String(selected) }, ...children);
    b.addEventListener("click", onPick);
    return b;
  }

  function renderCheckout() {
    const current = me.account.plan.id;
    const paidActive = me.account.paid_until && me.account.paid_until > Date.now();
    const offer = config.plans.find((p) => p.id === checkout.plan);
    $("checkout-plans").replaceChildren(...config.plans.filter((p) => p.price_usd).map((p) => {
      const lower = paidActive && rank(p.id) < rank(current);
      const tag = p.id === current ? h("span", { class: "plan-tag plan-tag-quiet" }, "Current") : p.id === config.recommended ? h("span", { class: "plan-tag" }, "Most popular") : "";
      const b = radio(p.id === checkout.plan, () => { checkout.plan = p.id; renderCheckout(); requote(); },
        h("span", { class: "plan-icon" }, icon("", [["path", { d: PLAN_ICONS[p.id] || PLAN_ICONS.free }]])),
        h("span", { class: "plan-option-main" },
          h("span", { class: "plan-option-name" }, p.name, tag),
          h("span", { class: "plan-option-meta" }, compact(p.included_credits) + " credits · " + fmt(p.rps) + " req/s")),
        h("span", { class: "plan-option-price" }, usd(p.price_usd).replace(".00", ""), h("span", { class: "per" }, "/mo")));
      b.className = "plan-option";
      if (lower) { b.disabled = true; b.title = "Available when your current plan ends"; }
      return b;
    }));
    const durations = offer ? offer.durations : [];
    $("checkout-months").replaceChildren(...durations.map((d) => {
      const b = radio(d.months === checkout.months, () => { checkout.months = d.months; renderCheckout(); requote(); },
        h("span", { class: "term-name" }, d.months === 1 ? "1 month" : d.months + " months"),
        h("span", { class: "term-price num" }, usd(d.total_usd)),
        h("span", { class: "term-sub" }, usd(d.total_usd / d.months) + " / month"),
        d.discount ? h("span", { class: "term-save" }, "Save " + Math.round(d.discount * 100) + "%") : "");
      b.className = "term-option";
      return b;
    }));

    renderSummary();
  }

  // Summary: list price, discount, tax for the billing country, total, and what the purchase does.
  function renderSummary() {
    const current = me.account.plan.id;
    const paidActive = me.account.paid_until && me.account.paid_until > Date.now();
    const offer = config.plans.find((p) => p.id === checkout.plan);
    const durations = offer ? offer.durations : [];
    const d = durations.find((x) => x.months === checkout.months) || durations[0];
    if (!offer || !d) return;
    const q = quote && quote.subtotal_usd === d.total_usd ? quote : null;
    const list = offer.price_usd * d.months;
    const extending = checkout.plan === current && paidActive;
    const base = extending ? me.account.paid_until : Date.now();
    const until = base + d.months * 30 * 24 * 3600 * 1000;
    $("checkout-summary").replaceChildren(
      h("div", { class: "sum-row" }, h("span", {}, offer.name + " × " + (d.months === 1 ? "1 month" : d.months + " months")), h("span", { class: "num" }, usd(list))),
      d.discount ? h("div", { class: "sum-row sum-save" }, h("span", {}, "Upfront discount (" + Math.round(d.discount * 100) + "%)"), h("span", { class: "num" }, "−" + usd(list - d.total_usd))) : "",
      q ? h("div", { class: "sum-row sum-tax" }, h("span", {}, q.tax.label), h("span", { class: "num" }, usd(q.tax_usd))) : h("div", { class: "sum-row" }, h("span", {}, "Tax"), h("span", {}, "Enter billing details")),
      h("div", { class: "sum-row sum-total" }, h("span", {}, "Total"), h("span", { class: "num" }, usd(q ? q.total_usd : d.total_usd))),
      q && q.tax.note ? h("p", { class: "sum-note" }, q.tax.note) : "",
      h("p", { class: "sum-note" }, extending
        ? "Extends " + offer.name + " to " + date(until) + "."
        : "Starts now and runs until " + date(until) + (paidActive ? ". Your current plan's remaining time is replaced." : ".")),
    );
    $("checkout-pay").querySelector(".btn-text").textContent = "Pay " + usd(q ? q.total_usd : d.total_usd) + " and start now";
    $("checkout-pay").disabled = !q || !payNetwork();
  }

  $("checkout-pay").addEventListener("click", () =>
    busy($("checkout-pay"), () => pay({ kind: "plan", plan: checkout.plan, months: checkout.months, billing: billing() })));
  // Close on a click on the backdrop (outside the dialog box).
  $("checkout").addEventListener("click", (e) => { if (e.target === $("checkout")) $("checkout").close(); });


  // ---- Docs tab: how to call each method (method data in docs.js, credits from /api/config).
  // The selected method is kept in the hash (#docs/eth_call).
  const DOCS = window.NULLRPC_DOCS || { groups: [], methods: [] };
  let docsMethod = "eth_getBalance";
  let docsLang = "curl";
  // Every example calls the public Ethereum mainnet endpoint (no key needed to try it).
  const DOCS_URL = "https://eth.nullrpc.dev";

  function creditsOf(name) {
    const range = (config.credits.ranges || {})[name];
    if (range) return range.base + "+";
    const c = config.credits.methods[name];
    return String(c === undefined ? config.credits.default : c);
  }
  function renderDocs() {
    const groups = DOCS.groups.map((g, i) => {
      const items = DOCS.methods.filter((m) => m.group === i).map((m) =>
        h("li", {}, h("a", { href: "#docs/" + m.name, class: "docs-item", "data-method": m.name, title: m.name },
          // Long names may wrap, but only between words (before a capital letter).
          h("span", { class: "docs-item-name" }, ...m.name.split(/(?=[A-Z])/).flatMap((part, n) => (n ? [h("wbr"), part] : [part]))),
          h("span", { class: "docs-item-credits num" }, creditsOf(m.name)))));
      return h("div", { class: "docs-group" }, h("p", { class: "docs-group-title" }, g), h("ul", {}, ...items));
    });
    $("docs-list").replaceChildren(...groups);
    showMethod(docsMethod);
  }

  // Static icons, built as SVG elements (no HTML strings).
  function icon(cls, shapes) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    for (const [k, v] of Object.entries({ class: "ic " + cls, viewBox: "0 0 24 24", width: "16", height: "16", "aria-hidden": "true", focusable: "false" })) svg.setAttribute(k, v);
    for (const [tag, attrs] of shapes) {
      const el = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      svg.append(el);
    }
    return svg;
  }

  // The example in the chosen language; lines of [text, className] tokens for highlighting.
  function example(m, url) {
    const keyed = url;
    const params = JSON.stringify(m.example);
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: m.name, params: m.example });
    if (docsLang === "fetch") {
      return [
        "const res = await fetch(\"" + keyed + "\", {",
        "  method: \"POST\",",
        "  headers: { \"content-type\": \"application/json\" },",
        "  body: JSON.stringify(" + body + "),",
        "});",
        "const { result } = await res.json();",
      ].join("\n");
    }
    if (docsLang === "viem") {
      return [
        "import { createPublicClient, http } from \"viem\";",
        "",
        "const client = createPublicClient({ transport: http(\"" + keyed + "\") });",
        "const result = await client.request({",
        "  method: \"" + m.name + "\",",
        "  params: " + params + ",",
        "});",
      ].join("\n");
    }
    return "curl " + keyed + " \\\n  -H 'content-type: application/json' \\\n  -d '" + body + "'";
  }

  // Minimal highlighting: strings and keywords get a class; everything is text nodes.
  function highlight(code) {
    const out = [];
    const re = /("(?:[^"\\]|\\.)*"|'[^']*'|\b(?:const|await|import|from|curl)\b|-[Hd]\b)/g;
    let last = 0;
    for (const m of code.matchAll(re)) {
      if (m.index > last) out.push(code.slice(last, m.index));
      const t = m[0];
      const cls = /^["']/.test(t) ? "tok-str" : /^-/.test(t) ? "tok-flag" : "tok-kw";
      out.push(h("span", { class: cls }, t));
      last = m.index + t.length;
    }
    out.push(code.slice(last));
    return out;
  }

  function showMethod(name) {
    const list = DOCS.methods;
    const i = Math.max(0, list.findIndex((x) => x.name === name));
    const m = list[i];
    if (!m) return;
    docsMethod = m.name;
    for (const a of $("docs-list").querySelectorAll(".docs-item")) a.setAttribute("aria-current", String(a.dataset.method === m.name));
    const code = example(m, DOCS_URL);

    const params = m.params.length
      ? h("ul", { class: "params" }, ...m.params.map((p, n) =>
          h("li", {},
            h("div", { class: "param-head" }, h("code", { class: "param-name" }, p.name), h("span", { class: "tag" }, p.type), h("span", { class: "param-pos" }, "#" + (n + 1))),
            h("p", {}, p.desc))))
      : h("p", { class: "docs-muted" }, "This method takes no parameters.");

    const langs = h("div", { class: "code-tabs", role: "group", "aria-label": "Language" },
      ...[["curl", "cURL"], ["fetch", "fetch"], ["viem", "viem"]].map(([id, label]) => {
        const b = h("button", { type: "button", "aria-pressed": String(docsLang === id) }, label);
        b.addEventListener("click", () => { docsLang = id; showMethod(docsMethod); });
        return b;
      }));

    const nav = h("div", { class: "docs-pager" },
      i > 0 ? h("a", { href: "#docs/" + list[i - 1].name, class: "pager-prev" }, h("span", { class: "pager-label" }, "Previous"), h("span", { class: "pager-name" }, list[i - 1].name)) : h("span"),
      i < list.length - 1 ? h("a", { href: "#docs/" + list[i + 1].name, class: "pager-next" }, h("span", { class: "pager-label" }, "Next"), h("span", { class: "pager-name" }, list[i + 1].name)) : h("span"));

    $("docs-detail").replaceChildren(
      h("p", { class: "docs-crumb" }, DOCS.groups[m.group]),
      h("h3", { class: "docs-name" }, m.name),
      h("div", { class: "docs-tags" },
        h("span", { class: "tag tag-accent num" }, creditsOf(m.name) + " credits"),
        h("span", { class: "tag" }, "JSON-RPC 2.0 · POST")),
      h("p", { class: "docs-summary" }, m.summary),
      m.notes ? h("div", { class: "docs-callout" },
        icon("ic-info", [["circle", { cx: "12", cy: "12", r: "9" }], ["path", { d: "M12 11v5M12 8h.01" }]]),
        h("p", {}, m.notes)) : "",
      h("h4", {}, "Parameters"), params,
      h("h4", {}, "Returns"), h("p", { class: "docs-returns" }, m.returns),
      h("h4", {}, "Example"),
      h("div", { class: "code-panel" },
        h("div", { class: "code-bar" }, langs, h("div", { class: "code-bar-end" }, h("span", { class: "code-endpoint-name" }, "eth.nullrpc.dev"), navigator.clipboard ? copyButton(() => code) : "")),
        h("pre", { class: "code" }, h("code", {}, ...highlight(code)))),
      h("p", { class: "docs-muted docs-key-note" }, "Examples use the public endpoint, so you can try them as they are. For your plan's quota and rate, add your API key to the path (" + DOCS_URL + "/YOUR_API_KEY) or send it as the x-api-key header. A batch of up to 32 calls costs the sum of its calls."),
      nav,
    );
  }

  function filterDocs() {
    const q = $("docs-filter").value.trim().toLowerCase();
    let any = false;
    for (const group of $("docs-list").querySelectorAll(".docs-group")) {
      let shown = 0;
      for (const li of group.querySelectorAll("li")) {
        const hit = !q || li.querySelector(".docs-item").dataset.method.toLowerCase().includes(q);
        li.hidden = !hit;
        shown += hit ? 1 : 0;
      }
      group.hidden = shown === 0;
      any = any || shown > 0;
    }
    $("docs-none").hidden = any;
  }
  $("docs-filter").addEventListener("input", filterDocs);


  function formatAmount(inv) {
    const decimals = inv.asset === "USDC" ? 6 : 18;
    const raw = BigInt(inv.amount);
    const whole = raw / 10n ** BigInt(decimals);
    const frac = (raw % 10n ** BigInt(decimals)).toString().padStart(decimals, "0").replace(/0+$/, "");
    return whole.toString() + (frac ? "." + frac : "") + " " + inv.asset;
  }

  // The same amount rounded to at most 6 decimals, for tables (the exact one goes in a tooltip).
  function shortAmount(inv) {
    const decimals = inv.asset === "USDC" ? 6 : 18;
    const shown = Math.min(6, decimals);
    const unit = 10n ** BigInt(decimals - shown);
    const raw = (BigInt(inv.amount) + unit / 2n) / unit; // round half up
    const scale = 10n ** BigInt(shown);
    const frac = (raw % scale).toString().padStart(shown, "0").replace(/0+$/, "");
    return (raw / scale).toString() + (frac ? "." + frac : "") + " " + inv.asset;
  }

  async function walletProvider() {
    if (provider) return provider;
    const list = [...wallets.values()];
    provider = list.length ? list[0].provider : window.ethereum;
    if (!provider) throw new Error("no wallet found");
    return provider;
  }

  // A button shows a spinner (and ignores clicks) while `work` runs; no progress text.
  async function busy(button, work) {
    if (button.getAttribute("data-state") === "busy") return;
    button.setAttribute("data-state", "busy");
    button.setAttribute("aria-busy", "true");
    button.disabled = true;
    try {
      return await work();
    } finally {
      button.removeAttribute("data-state");
      button.removeAttribute("aria-busy");
      button.disabled = false;
    }
  }
  // Only a real failure is written out; closing the wallet prompt (4001) just resets the button.
  const failure = (error) => (error && error.code === 4001 ? "" : "Payment failed: " + ((error && error.message) || error));

  async function pay(request) {
    const status = $("pay-status");
    status.textContent = "";
    try {
      const { invoice } = await post("/api/invoices", { ...request, chain_id: payNetwork().chain_id, asset: "USDC" });
      await send(invoice, status);
    } catch (error) {
      status.textContent = failure(error);
    }
    if ($("checkout").open) renderSummary();
    loadInvoices();
  }
  async function send(invoice, status = $("pay-status")) {
    const p = await walletProvider();
    const [from] = await p.request({ method: "eth_requestAccounts" });
    if (from.toLowerCase() !== me.account.address.toLowerCase()) {
      throw new Error("switch your wallet to the signed-in account " + short(me.account.address));
    }
    const current = await p.request({ method: "eth_chainId" });
    if (Number(current) !== invoice.chain_id) {
      await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: invoice.tx.chainId }] });
    }
    const { chainId: _, ...tx } = invoice.tx;
    const hash = await p.request({ method: "eth_sendTransaction", params: [tx] });
    const result = await post("/api/invoices/" + invoice.id + "/submit", { tx_hash: hash });
    await follow(result, status);
  }
  async function follow(result, status = $("pay-status")) {
    while (result.invoice.status === "pending") {
      await new Promise((r) => setTimeout(r, 10000));
      result = await post("/api/invoices/" + result.invoice.id + "/check");
    }
    if (result.invoice.status === "paid") {
      status.textContent = "";
      if ($("checkout").open) $("checkout").close();
      await load();
    } else {
      status.textContent = "Payment " + result.invoice.status + (result.reason ? ": " + result.reason : "") + ".";
    }
  }


  async function loadInvoices() {
    let data;
    try {
      data = await api("/api/invoices");
    } catch {
      return;
    }
    const body = $("invoices");
    $("invoices-none").hidden = data.invoices.length > 0;
    body.closest(".table-wrap").hidden = data.invoices.length === 0;
    body.replaceChildren(
      ...data.invoices.map((inv) => {
        const item = inv.kind === "plan" ? (config.plans.find((p) => p.id === inv.plan)?.name || inv.plan) + " × " + inv.months + (inv.months === 1 ? " month" : " months") : "Balance top-up";
        const tone = { paid: "ok", pending: "wait", open: "open" }[inv.status] || "off";
        const w = inv.withdrawal;
        const withdrawn = w && w.withdrawn_at
          ? h("span", { class: "withdrawn" }, "Withdrawn " + date(w.withdrawn_at) + " · refund " + usd(w.refund_usd) + (w.refund_tx ? " sent" : " pending"))
          : "";
        const status = h("td", {}, h("span", { class: "pill pill-" + tone }, inv.status), inv.note ? h("span", { class: "cell-sub" }, inv.note) : "", withdrawn);
        const actions = h("td", { class: "cell-actions" });
        if (inv.status === "open" && inv.tx) {
          const payBtn = h("button", { type: "button", class: "btn small" }, h("span", { class: "spinner", "aria-hidden": "true" }), h("span", { class: "btn-text" }, "Pay"));
          payBtn.addEventListener("click", () => busy(payBtn, () => send(inv, $("payments-status")).catch((e) => ($("payments-status").textContent = failure(e)))));
          actions.append(payBtn);
        }
        if (inv.status === "pending") {
          const checkBtn = h("button", { type: "button", class: "btn ghost small" }, h("span", { class: "spinner", "aria-hidden": "true" }), h("span", { class: "btn-text" }, "Check"));
          checkBtn.addEventListener("click", () => busy(checkBtn, () => follow({ invoice: inv }, $("payments-status")).then(loadInvoices)));
          actions.append(checkBtn);
        }
        // Unpaid and never submitted: it can be deleted (the server refuses anything else).
        if ((inv.status === "open" || inv.status === "expired") && !inv.tx_hash) {
          actions.append(h("button", { type: "button", class: "link-danger", onclick: () => deleteInvoice(inv) }, "Delete"));
        }
        if (inv.withdrawal && inv.withdrawal.available) {
          actions.append(h("button", { type: "button", class: "link-danger", onclick: () => withdraw(inv) }, "Withdraw"));
        }
        actions.append(h("a", { class: "tx-link", href: "/invoice?id=" + inv.id, target: "_blank", rel: "noopener" }, inv.status === "paid" ? "Invoice" : "Details"));
        if (inv.explorer) actions.append(h("a", { class: "tx-link", href: inv.explorer, target: "_blank", rel: "noopener noreferrer" }, "View tx ↗"));
        return h("tr", {},
          h("td", { class: "num cell-date" }, date(inv.created_at)),
          h("td", { class: "cell-item" }, item),
          h("td", {}, h("span", { class: "cell-main num" }, usd(inv.usd)), h("span", { class: "cell-sub num", title: formatAmount(inv) }, shortAmount(inv))),
          h("td", {}, inv.network),
          status,
          actions);
      }),
    );
  }

  // In-app confirmation (a <dialog>): resolves true on the action button, false on Cancel, Esc
  // or a click outside. Focus starts on Cancel, the safe choice.
  function confirmDialog({ title, text, action }) {
    const d = $("confirm");
    $("confirm-h").textContent = title;
    $("confirm-text").textContent = text;
    $("confirm-ok").textContent = action;
    return new Promise((resolve) => {
      const done = (ok) => {
        d.removeEventListener("close", onClose);
        $("confirm-ok").onclick = $("confirm-cancel").onclick = d.onclick = null;
        if (d.open) d.close();
        resolve(ok);
      };
      // A close event queued by the previous use can arrive after a quick reopen: ignore it
      // while the dialog is open; Esc closes it (open is false), which counts as Cancel.
      const onClose = () => { if (!d.open) done(false); };
      d.addEventListener("close", onClose);
      $("confirm-ok").onclick = () => done(true);
      $("confirm-cancel").onclick = () => done(false);
      d.onclick = (e) => { if (e.target === d) done(false); };
      d.showModal();
      $("confirm-cancel").focus();
    });
  }

  // Withdrawal (any buyer, 14 days): the unused time is refunded; Mexican consumers get it all back within 7 days.
  async function withdraw(inv) {
    const w = inv.withdrawal;
    const text = (w.prorata
      ? "Your plan ends now. You will be refunded the unused part of this payment"
      : "Your plan ends now. You will be refunded this payment in full") + ", in USDC to the wallet that paid, within 14 days.";
    if (!(await confirmDialog({ title: "Withdraw from this plan?", text, action: "Withdraw" }))) return;
    try {
      const { invoice } = await post("/api/invoices/" + inv.id + "/withdraw");
      $("payments-status").textContent = "Withdrawal received on " + new Date(invoice.withdrawal.withdrawn_at).toLocaleString() + ". Refund due: " + usd(invoice.withdrawal.refund_usd) + ". The invoice page shows this confirmation.";
    } catch (error) {
      $("payments-status").textContent = "Could not withdraw: " + error.message;
    }
    await load();
  }

  async function deleteInvoice(inv) {
    if (!(await confirmDialog({ title: "Delete this payment?", text: "It was never paid, so nothing was charged. You can start a new payment any time.", action: "Delete payment" }))) return;
    try {
      await api("/api/invoices/" + inv.id, { method: "DELETE" });
      $("payments-status").textContent = "";
    } catch (error) {
      $("payments-status").textContent = "Could not delete the payment: " + error.message;
    }
    loadInvoices();
  }

  // ---- tabs (WAI-ARIA tabs pattern): Overview, API keys, Payments, Docs; the choice is kept in
  // the URL hash (#overview, #keys, #payments, #docs/<method>) so a reload or link opens it.
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  function selectTab(tab, focus) {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      $(t.getAttribute("aria-controls")).hidden = !on;
    }
    if (focus) tab.focus();
    if (tab.id === "tab-overview") drawUsage();
    const hash = "#" + tab.id.slice(4);
    if (location.hash.split("/")[0] !== hash) history.replaceState(null, "", hash);
  }
  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => selectTab(tab, false));
    tab.addEventListener("keydown", (e) => {
      const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
      if (next === undefined) return;
      e.preventDefault();
      selectTab(tabs[(next + tabs.length) % tabs.length], true);
    });
  });
  const fromHash = () => {
    let [base, method] = location.hash.split("/");
    if (base === "#plan" || base === "#usage") base = "#overview"; // older links
    const tab = tabs.find((t) => "#" + t.id.slice(4) === base);
    if (tab) selectTab(tab, false);
    if (base === "#docs" && method) {
      docsMethod = decodeURIComponent(method);
      if (config) showMethod(docsMethod);
    }
  };
  fromHash();
  window.addEventListener("hashchange", fromHash); // back/forward and in-page links

  $("signout").addEventListener("click", async () => {
    await post("/api/auth/logout").catch(() => {});
    provider = null;
    await load();
  });

  (async () => {
    try {
      config = await api("/api/config");
    } catch {
      banner("The service is unavailable. Please try again shortly.");
      return;
    }
    renderWallets();
    loadTurnstile();
    renderDocs();
    renderCountries();
    // Late EIP-6963 announcements re-render; give wallets a moment to inject.
    setTimeout(renderWallets, 500);
    await load();
  })();
})();
