// nullrpc admin page (/admin): Users (search, suspend) and Refunds (send from
// the treasury wallet, record the transaction). A client of /api/admin/* with the ADMIN_TOKEN as a
// bearer token, kept in sessionStorage for this tab only. Every value is written with textContent.
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
  const usd = (n) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const date = (ms) => new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
  const compact = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));
  const usdc = (units) => {
    const raw = BigInt(units);
    const frac = (raw % 1000000n).toString().padStart(6, "0").replace(/0+$/, "");
    return (raw / 1000000n).toString() + (frac ? "." + frac : "") + " USDC";
  };
  const KEY = "nullrpc-admin-token";
  const store = {
    get: () => { try { return sessionStorage.getItem(KEY) || ""; } catch { return ""; } },
    set: (v) => { try { v ? sessionStorage.setItem(KEY, v) : sessionStorage.removeItem(KEY); } catch {} },
  };
  let token = store.get();

  function banner(text) {
    $("banner").hidden = !text;
    $("banner").textContent = text || "";
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: { authorization: "Bearer " + token, ...(options.body ? { "content-type": "application/json" } : {}) },
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401 || (res.status === 404 && path === "/api/admin/accounts")) {
      lock(res.status === 401 ? "That token was refused." : "The admin API is disabled (ADMIN_TOKEN is not set).");
      throw new Error("locked");
    }
    if (!res.ok) {
      const error = new Error(body.error || "HTTP " + res.status);
      error.status = res.status;
      throw error;
    }
    return body;
  }
  const post = (path, value) => api(path, { method: "POST", body: JSON.stringify(value) });

  function lock(reason) {
    token = "";
    store.set("");
    $("admin").hidden = true;
    $("lock").hidden = true;
    $("unlock-panel").hidden = false;
    banner(reason || "");
  }

  async function unlock() {
    banner("");
    $("unlock-panel").hidden = true;
    $("admin").hidden = false;
    $("lock").hidden = false;
    await Promise.all([loadUsers(), loadRefunds()]).catch((e) => e.message !== "locked" && banner(e.message));
  }

  $("unlock").addEventListener("submit", (e) => {
    e.preventDefault();
    token = $("token").value.trim();
    $("token").value = "";
    store.set(token);
    unlock();
  });
  $("lock").addEventListener("click", () => lock());

  // ---- a small dialog asking for one value (a note, a transaction hash); `run` may throw to keep it open.
  function ask({ title, text, label, placeholder = "", action, required = false, run }) {
    const d = $("ask");
    $("ask-h").textContent = title;
    $("ask-text").textContent = text;
    $("ask-label").textContent = label;
    $("ask-input").value = "";
    $("ask-input").placeholder = placeholder;
    $("ask-status").textContent = "";
    $("ask-ok").querySelector(".btn-text").textContent = action;
    return new Promise((resolve) => {
      const done = (v) => {
        $("ask-ok").onclick = $("ask-cancel").onclick = d.onclose = null;
        if (d.open) d.close();
        resolve(v);
      };
      d.onclose = () => done(null);
      $("ask-cancel").onclick = () => done(null);
      $("ask-ok").onclick = async () => {
        const value = $("ask-input").value.trim();
        if (required && !value) { $("ask-status").textContent = label + " is required."; return; }
        $("ask-ok").setAttribute("data-state", "busy");
        $("ask-ok").disabled = true;
        try {
          done(await run(value));
        } catch (error) {
          $("ask-status").textContent = error.message;
        } finally {
          $("ask-ok").removeAttribute("data-state");
          $("ask-ok").disabled = false;
        }
      };
      d.showModal();
      $("ask-input").focus();
    });
  }

  // ---- Users
  let usersStatus = "all";
  let usersSeq = 0;
  async function loadUsers() {
    const seq = ++usersSeq;
    const q = $("users-q").value.trim();
    const data = await api("/api/admin/accounts?status=" + usersStatus + (q ? "&q=" + encodeURIComponent(q) : ""));
    if (seq !== usersSeq) return;
    $("users-totals").textContent = data.totals.accounts.toLocaleString() + " accounts · " + data.totals.suspended.toLocaleString() + " suspended" + (data.accounts.length >= 100 ? " · showing the newest 100 matches" : "");
    $("users").replaceChildren(...(data.accounts.length ? data.accounts.map(userRow) : [h("tr", {}, h("td", { colspan: "7", class: "table-empty" }, "No accounts match."))]));
  }

  function userRow(a) {
    const c = a.customer;
    const status = a.suspended
      ? h("td", {}, h("span", { class: "pill pill-bad" }, "suspended"), h("span", { class: "cell-sub" }, (a.suspended_reason || "") + (a.suspended_at ? " · " + date(a.suspended_at) : "")))
      : h("td", {}, h("span", { class: "pill pill-ok" }, "active"));
    const actions = h("td", { class: "cell-actions" });
    if (!a.suspended) {
      actions.append(h("button", { type: "button", class: "link-danger", onclick: () => suspend(a, true) }, "Suspend"));
    } else if (a.suspended_reason !== "sanctions") {
      actions.append(h("button", { type: "button", class: "btn ghost small", onclick: () => suspend(a, false) }, "Unsuspend"));
    } else {
      actions.append(h("span", { class: "cell-sub", title: "Sanctions suspensions are lifted only after legal review" }, "sanctions hold"));
    }
    const copy = h("button", { type: "button", class: "icon-btn admin-copy", title: "Copy address", "aria-label": "Copy address " + a.address, onclick: () => navigator.clipboard && navigator.clipboard.writeText(a.address) }, "⧉");
    return h("tr", {},
      h("td", {}, h("code", { class: "cell-main", title: a.address }, short(a.address)), copy, a.admin_note ? h("span", { class: "cell-sub", title: a.admin_note }, "Note: " + a.admin_note) : ""),
      h("td", {}, c ? h("span", { class: "cell-main" }, c.name || "—") : "—", c ? h("span", { class: "cell-sub" }, [c.country, c.tax_id, c.business ? "business" : "consumer"].filter(Boolean).join(" · ")) : ""),
      h("td", {}, h("span", { class: "cell-main" }, a.plan), h("span", { class: "cell-sub" }, a.paid_until ? "until " + date(a.paid_until) : a.paid_usd ? usd(a.paid_usd) + " paid" : "")),
      h("td", { class: "num" }, compact(a.period_credits) + " cr", h("span", { class: "cell-sub" }, a.keys + (a.keys === 1 ? " key" : " keys"))),
      h("td", { class: "num" }, date(a.created_at)),
      status,
      actions);
  }

  async function suspend(a, on) {
    await ask({
      title: (on ? "Suspend " : "Unsuspend ") + short(a.address) + "?",
      text: on
        ? "Sign-in, the app and every API key of this account stop working within a minute. The reason is kept in the admin log."
        : "The account and its keys work again within a minute.",
      label: "Reason (admin log)",
      placeholder: on ? "for example: abuse, chargeback, legal request" : "for example: reviewed, OK",
      action: on ? "Suspend" : "Unsuspend",
      required: on,
      run: (note) => post("/api/admin/account/" + a.address, { suspended: on, ...(note ? { note } : {}) }),
    });
    loadUsers().catch((e) => banner(e.message));
  }

  let searchTimer = 0;
  $("users-q").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => loadUsers().catch((e) => banner(e.message)), 300); });
  $("users-filter").addEventListener("submit", (e) => { e.preventDefault(); loadUsers().catch((er) => banner(er.message)); });
  for (const b of document.querySelectorAll("#users-status button")) {
    b.addEventListener("click", () => {
      usersStatus = b.dataset.status;
      for (const o of document.querySelectorAll("#users-status button")) o.setAttribute("aria-checked", String(o === b));
      loadUsers().catch((e) => banner(e.message));
    });
  }

  // ---- Refunds
  let refundsStatus = "pending";
  async function loadRefunds() {
    const data = await api("/api/admin/refunds?status=" + refundsStatus);
    const p = data.pending;
    $("refund-count").hidden = !p.count;
    $("refund-count").textContent = String(p.count);
    if (refundsStatus === "pending") {
      $("refunds-summary").textContent = p.count
        ? p.count + (p.count === 1 ? " refund" : " refunds") + " to send, " + usd(p.usd) + " in total" + (p.overdue ? " · " + p.overdue + " overdue" : "") + "."
        : "No refunds to send.";
    } else {
      $("refunds-summary").textContent = "";
    }
    $("refunds").replaceChildren(...(data.refunds.length ? data.refunds.map(refundRow) : [h("tr", {}, h("td", { colspan: "6", class: "table-empty" }, refundsStatus === "pending" ? "Nothing to refund." : "No refunds."))]));
  }

  function refundRow(r) {
    const c = r.customer;
    const actions = h("td", { class: "cell-actions" });
    if (r.status === "pending") {
      if (r.tx && (window.ethereum || wallets.size)) {
        const send = h("button", { type: "button", class: "btn small" }, h("span", { class: "spinner", "aria-hidden": "true" }), h("span", { class: "btn-text" }, "Send with wallet"));
        send.addEventListener("click", () => sendRefund(r, send));
        actions.append(send);
      }
      actions.append(h("button", { type: "button", class: "btn ghost small", onclick: () => recordRefund(r) }, "Record tx"));
    }
    if (r.tx_url) actions.append(h("a", { class: "tx-link", href: r.tx_url, target: "_blank", rel: "noopener noreferrer" }, "View tx ↗"));
    const pill = r.status === "sent"
      ? h("span", { class: "pill pill-ok" }, "sent")
      : r.overdue ? h("span", { class: "pill pill-bad" }, "overdue") : h("span", { class: "pill pill-wait" }, "to send");
    return h("tr", {},
      h("td", { class: "num" }, h("span", { class: "cell-main" }, date(r.due_at)), h("span", { class: "cell-sub" }, "withdrawn " + date(r.withdrawn_at))),
      h("td", {}, h("a", { href: "/invoice?id=" + r.invoice, target: "_blank", rel: "noopener" }, r.number || r.invoice.slice(0, 8)), h("span", { class: "cell-sub" }, (r.plan || "") + (r.months ? " × " + r.months : "") + " · paid " + usd(r.paid_usd))),
      h("td", {}, h("span", { class: "cell-main" }, (c && c.name) || "—"), h("code", { class: "cell-sub", title: r.address }, short(r.address)),
        h("button", { type: "button", class: "icon-btn admin-copy", title: "Copy wallet", "aria-label": "Copy wallet " + r.address, onclick: () => navigator.clipboard && navigator.clipboard.writeText(r.address) }, "⧉")),
      h("td", { class: "num" }, h("span", { class: "cell-main" }, usd(r.refund_usd)), h("span", { class: "cell-sub" }, usdc(r.refund_usdc_units)),
        h("button", { type: "button", class: "icon-btn admin-copy", title: "Copy amount", "aria-label": "Copy amount", onclick: () => navigator.clipboard && navigator.clipboard.writeText(usdc(r.refund_usdc_units).replace(" USDC", "")) }, "⧉")),
      h("td", {}, pill, r.refunded_at ? h("span", { class: "cell-sub" }, date(r.refunded_at)) : ""),
      actions);
  }

  function recordRefund(r) {
    return ask({
      title: "Record the refund of " + usd(r.refund_usd),
      text: "Paste the hash of the USDC transfer of at least " + usdc(r.refund_usdc_units) + " to " + r.address + " on " + r.network + ". It is checked on-chain.",
      label: "Transaction hash",
      placeholder: "0x…",
      action: "Record",
      required: true,
      run: (hash) => post("/api/admin/refunds/" + r.invoice, { tx_hash: hash }),
    }).then(() => loadRefunds().catch((e) => banner(e.message)));
  }

  // Wallets (EIP-6963, then window.ethereum): a Trezor connected to Rabby, MetaMask or Frame signs here.
  const wallets = new Map();
  window.addEventListener("eip6963:announceProvider", (e) => {
    const { info, provider } = e.detail || {};
    if (info && provider) wallets.set(info.uuid, provider);
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));

  async function sendRefund(r, button) {
    if (button.getAttribute("data-state") === "busy") return;
    button.setAttribute("data-state", "busy");
    button.disabled = true;
    try {
      const p = [...wallets.values()][0] || window.ethereum;
      const [from] = await p.request({ method: "eth_requestAccounts" });
      if (Number(await p.request({ method: "eth_chainId" })) !== Number(r.tx.chainId)) {
        await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: r.tx.chainId }] });
      }
      const { chainId: _, ...tx } = r.tx;
      const hash = await p.request({ method: "eth_sendTransaction", params: [{ ...tx, from }] });
      $("refunds-summary").textContent = "Sent " + hash.slice(0, 10) + "… Recording it once it is mined…";
      // Record when mined: retried every 15 s for up to 10 minutes.
      for (let i = 0; i < 40; i++) {
        try {
          await post("/api/admin/refunds/" + r.invoice, { tx_hash: hash });
          break;
        } catch (error) {
          if (error.status !== 409 || /already/.test(error.message)) throw error;
          await new Promise((res) => setTimeout(res, 15000));
        }
      }
      await loadRefunds();
    } catch (error) {
      if (error && error.code !== 4001) banner("Refund not recorded: " + (error.message || error) + ". If it was sent, use Record tx with its hash.");
    } finally {
      button.removeAttribute("data-state");
      button.disabled = false;
    }
  }

  for (const b of document.querySelectorAll("#refunds-status button")) {
    b.addEventListener("click", () => {
      refundsStatus = b.dataset.status;
      for (const o of document.querySelectorAll("#refunds-status button")) o.setAttribute("aria-checked", String(o === b));
      loadRefunds().catch((e) => banner(e.message));
    });
  }

  // ---- tabs
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  function select(tab) {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      $(t.getAttribute("aria-controls")).hidden = !on;
    }
    history.replaceState(null, "", "#" + tab.id.slice(4));
  }
  for (const t of tabs) t.addEventListener("click", () => select(t));
  const fromHash = tabs.find((t) => "#" + t.id.slice(4) === location.hash);
  if (fromHash) select(fromHash);

  if (token) unlock();
})();
