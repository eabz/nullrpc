// Invoice page: GET /api/invoices/{id} for the signed-in account,
// rendered with textContent only. Print it or save it as PDF from the browser.
"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const h = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    for (const c of children) node.append(c);
    return node;
  };
  const usd = (n) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const day = (ms) => new Date(ms).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }) + " (UTC)";
  const country = (code) => {
    try {
      return new Intl.DisplayNames(["en"], { type: "region" }).of(code) || code;
    } catch {
      return code;
    }
  };
  const lines = (...rows) => rows.filter(Boolean).map((r) => h("p", { class: "invoice-line" }, r));
  const PLANS = { builder: "Builder", growth: "Growth", scale: "Scale" };

  function fail(text) {
    $("banner").hidden = false;
    $("banner").textContent = text;
  }

  function usdc(amount) {
    const raw = BigInt(amount);
    const frac = (raw % 1000000n).toString().padStart(6, "0").replace(/0+$/, "");
    return (raw / 1000000n).toString() + (frac ? "." + frac : "") + " USDC";
  }

  function render({ invoice: inv, seller }) {
    const paid = inv.status === "paid";
    document.title = (paid ? "Invoice " + inv.number : "Payment request") + " · nullrpc";
    $("inv-kind").textContent = paid ? "Invoice" : "Payment request (not paid, not an invoice)";
    $("inv-title").textContent = paid ? inv.number : "Status: " + inv.status;
    $("inv-dates").replaceChildren(
      h("dt", {}, paid ? "Issued" : "Created"), h("dd", {}, day(paid ? inv.paid_at : inv.created_at)),
      h("dt", {}, "Reference"), h("dd", { class: "mono" }, inv.id),
    );
    $("inv-seller").replaceChildren(...(seller
      ? lines(seller.name, seller.address, "Tax ID (RFC): " + seller.tax_id, seller.oss_number && inv.tax && inv.tax.rule === "eu_vat" ? "EU VAT (OSS): " + seller.oss_number : "", seller.email)
      : lines("Kindynos")));
    const b = inv.buyer || {};
    $("inv-buyer").replaceChildren(...lines(
      b.name || "—",
      b.address,
      b.country ? country(b.country) : "",
      b.tax_id ? (b.country === "MX" ? "RFC: " : "Tax ID: ") + b.tax_id : "",
      b.business ? "" : "Consumer",
      "Wallet: " + inv.address,
    ));
    const plan = PLANS[inv.plan] || inv.plan;
    const term = inv.months === 1 ? "1 period of 30 days" : inv.months + " periods of 30 days";
    const row = (label, value, cls = "") => h("tr", { class: cls }, h("td", {}, label), h("td", { class: "num-col num" }, value));
    $("inv-lines").replaceChildren(
      row("nullrpc " + plan + " plan, " + term + ", prepaid", usd(inv.subtotal_usd)),
      row(inv.tax ? inv.tax.label : "Tax", usd(inv.tax_usd)),
      row("Total", usd(inv.usd), "invoice-total"),
    );
    $("inv-payment").replaceChildren(...lines(
      usdc(inv.amount) + " on " + inv.network + (paid ? ", paid " + day(inv.paid_at) : ""),
      inv.tx_hash ? "Transaction: " + inv.tx_hash : "No transaction submitted.",
    ));
    const notes = [];
    if (inv.tax && inv.tax.note) notes.push(inv.tax.note);
    notes.push("Prices are in US dollars. Paid in USDC (1 USDC = 1 USD).");
    if (inv.consent) notes.push("Accepted at checkout: “" + inv.consent + "”");
    const w = inv.withdrawal;
    if (w && w.withdrawn_at) {
      notes.push("Withdrawal received on " + new Date(w.withdrawn_at).toUTCString() + ". Refund due: " + usd(w.refund_usd) + (w.refund_tx ? ", sent in transaction " + w.refund_tx : ", to be sent in USDC to the paying wallet within 14 days") + ".");
    } else if (w && w.available) {
      notes.push("You may withdraw until " + new Date(w.deadline).toUTCString() + " from the Payments tab of the app.");
    }
    if (b.country === "MX") notes.push("Este documento no es un CFDI. Solicite su CFDI a " + ((seller && seller.email) || "legal@nullrpc.dev") + " indicando su RFC, régimen fiscal, código postal y uso del CFDI.");
    notes.push("nullrpc is a service of " + ((seller && seller.name) || "Kindynos") + ". Terms: https://nullrpc.dev/terms");
    $("inv-notes").replaceChildren(...notes.map((n) => h("li", {}, n)));
    $("invoice").hidden = false;
    $("print").hidden = false;
  }

  $("print").addEventListener("click", () => window.print());

  const id = new URLSearchParams(location.search).get("id") || "";
  if (!/^[0-9a-f-]{36}$/.test(id)) {
    fail("No invoice selected. Open invoices from the Payments tab.");
    return;
  }
  fetch("/api/invoices/" + id, { credentials: "same-origin" })
    .then(async (res) => {
      if (res.status === 401) throw new Error("Sign in to the app to see this invoice.");
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "HTTP " + res.status);
      render(body);
    })
    .catch((error) => fail(error.message));
})();
