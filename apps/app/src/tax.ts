// Billing details, taxes and the consumer right of withdrawal ("Taxes"
// and "Withdrawal"). Pure functions; no I/O.
//
// Kindynos is a Mexican taxpayer. Plan prices are net of tax; the tax is added at checkout:
//   - Mexico (any buyer): IVA 16%.
//   - EU business with a VAT ID: no VAT, reverse charge (the buyer accounts for it).
//   - EU consumer: VAT of the buyer's country (non-Union OSS registration required).
//   - Elsewhere: no Mexican IVA (export of services, LIVA art. 29); no local tax collected.
// Rates are standard rates; check them against the EU's TEDB before each release.

/** EU standard VAT rates in percent (2026). */
export const EU_VAT: Record<string, number> = {
  AT: 20, BE: 21, BG: 20, HR: 25, CY: 19, CZ: 21, DK: 25, EE: 24, FI: 25.5, FR: 20, DE: 19, GR: 24, HU: 27, IE: 23,
  IT: 22, LV: 21, LT: 21, LU: 17, MT: 18, NL: 21, PL: 23, PT: 23, RO: 21, SK: 23, SI: 22, ES: 21, SE: 25,
};
export const MX_IVA = 16;

export interface Billing {
  name: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
  tax_id: string;
  address: string;
  /** Buying for a business (B2B), not as a consumer. */
  business: boolean;
}

/** Validates billing details from the API; returns the clean value or an error message. */
export function parseBilling(input: unknown): Billing | string {
  if (!input || typeof input !== "object") return "billing details required";
  const v = input as Record<string, unknown>;
  const text = (x: unknown, max: number) => (typeof x === "string" ? x.trim().replace(/\s+/g, " ").slice(0, max) : "");
  const country = text(v.country, 2).toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) return "country required";
  const billing: Billing = { name: text(v.name, 120), country, tax_id: text(v.tax_id, 40).toUpperCase(), address: text(v.address, 240), business: v.business === true };
  if (!billing.name) return "name required";
  if (billing.business && !billing.tax_id) return "a business needs its tax ID";
  if (billing.business && EU_VAT[country] !== undefined && !/^[A-Z0-9+*.-]{4,20}$/.test(billing.tax_id.replace(/^[A-Z]{2}/, ""))) return "invalid VAT ID";
  if (country === "MX" && billing.tax_id && !/^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/.test(billing.tax_id)) return "invalid RFC";
  return billing;
}

export interface Tax {
  rule: "mx_iva" | "eu_vat" | "eu_reverse_charge" | "export";
  /** Percent. */
  rate: number;
  label: string;
  note: string;
}

export function taxFor(billing: Billing): Tax {
  if (billing.country === "MX") return { rule: "mx_iva", rate: MX_IVA, label: "IVA 16%", note: "Impuesto al Valor Agregado (Mexico)." };
  const eu = EU_VAT[billing.country];
  if (eu !== undefined && billing.business) {
    return { rule: "eu_reverse_charge", rate: 0, label: "VAT 0%", note: "Reverse charge: VAT to be accounted for by the recipient (Art. 196, Directive 2006/112/EC)." };
  }
  if (eu !== undefined) return { rule: "eu_vat", rate: eu, label: `VAT ${eu}% (${billing.country})`, note: "VAT charged under the non-Union OSS scheme." };
  return { rule: "export", rate: 0, label: "Tax 0%", note: "Export of services: not subject to Mexican IVA (LIVA art. 29). Any local taxes are the buyer's responsibility." };
}

/** Tax in cents on a net amount, rounded half up. */
export function taxCents(subtotalCents: number, tax: Tax): number {
  return Math.round((subtotalCents * tax.rate) / 100);
}

/** Days after payment during which any buyer may withdraw from a plan purchase. */
export const WITHDRAWAL_DAYS = 14;

export interface Withdrawal {
  /** Days after payment during which the buyer may withdraw. */
  days: number;
  /** Days after payment with a full refund instead of the unused share (0: none). */
  full_days: number;
  basis: string;
}

/**
 * The withdrawal right. Every buyer may withdraw
 * within 14 days and is refunded the unused time of the plan: this covers the EU/EEA/UK
 * consumer right (Directive 2011/83/EU art. 14(3): the buyer asked for an immediate start, so
 * the time used is paid). Mexican consumers get a full refund within 7 days (LFPC art. 56).
 */
export function withdrawalFor(billing: Billing): Withdrawal {
  if (!billing.business && billing.country === "MX") return { days: WITHDRAWAL_DAYS, full_days: 7, basis: "Terms §7; LFPC art. 56" };
  return { days: WITHDRAWAL_DAYS, full_days: 0, basis: "Terms §7" };
}

/**
 * The statement shown next to the Pay button: paying is the buyer's express request for the
 * plan to start now (which is what lets the time used be charged on withdrawal). Stored with
 * the invoice and printed on it.
 */
export function consentText(billing: Billing): string {
  const w = withdrawalFor(billing);
  const full = w.full_days ? ` As a consumer in Mexico, you get a full refund if you withdraw within ${w.full_days} days.` : "";
  return `By paying, you ask for your plan to start now. You can withdraw within ${w.days} days of payment and get back the unused part of the plan, in proportion to the time left.${full} After ${w.days} days, payments are non-refundable.`;
}
