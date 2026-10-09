// The company behind nullrpc and its legal documents.
// The Terms and the Privacy Notice are pages of the landing site (apps/landing/public);
// a test checks that the landing Terms carry TERMS_VERSION.

/** Bump when the Terms change materially: every account is asked to accept again. */
export const TERMS_VERSION = "2026-10-07";
export const TERMS_URL = "https://nullrpc.dev/terms";
export const PRIVACY_URL = "https://nullrpc.dev/privacy";

/** The seller on invoices. */
export interface Seller {
  name: string;
  tax_id: string;
  address: string;
  country: string;
  email: string;
  /** EU non-Union OSS identification number, once registered. */
  oss_number?: string;
}

export const SELLER: Seller = {
  name: "Grupo Kindynos, S.A.P.I. de C.V.",
  tax_id: "GKI180321CW7",
  address: "Sierra Ventana 419, Lomas 3a Sección, C.P. 78210, San Luis Potosí, S.L.P., México",
  country: "MX",
  email: "legal@nullrpc.dev",
};
