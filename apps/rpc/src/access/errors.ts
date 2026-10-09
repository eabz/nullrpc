// HTTP status, JSON-RPC code and message for each access outcome (same wording as before, so
// clients and docs stay valid).

import type { Status } from "./ledger";

export const APP_URL = "https://app.nullrpc.dev";

export interface Refusal {
  http: number;
  code: number;
  message: string;
  retryAfter?: number;
}

export function refusal(status: Status, keyed: boolean): Refusal {
  switch (status) {
    case "exhausted":
      return keyed
        ? { http: 429, code: -32005, message: `Monthly quota used up: upgrade at ${APP_URL}` }
        : { http: 429, code: -32005, message: `Monthly limit for requests without a key reached: get an API key at ${APP_URL}` };
    case "network":
      return { http: 429, code: -32005, message: `Free plan limit for this network reached (10M credits per month per IP, shared with requests without a key): upgrade to Builder at ${APP_URL}` };
    case "capacity":
      return { http: 429, code: -32005, message: `daily public capacity reached: get a free key at ${APP_URL}` };
    case "busy":
      return { http: 429, code: -32005, message: "Quota nearly used up or usage service unavailable: retry in a minute", retryAfter: 60 };
    case "suspended":
      return { http: 403, code: -32001, message: "Account suspended: contact support" };
    default:
      return { http: 401, code: -32001, message: `API key revoked or unknown; check it at ${APP_URL}` };
  }
}

export const INVALID_KEY: Refusal = { http: 401, code: -32001, message: `Invalid API key; check it at ${APP_URL}` };
export const KEY_REQUIRED: Refusal = { http: 401, code: -32001, message: `API key required: create one at ${APP_URL}` };
export const RATE_LIMITED: Refusal = { http: 429, code: -32005, message: "Rate limit exceeded", retryAfter: 10 };
export const PUBLIC_RATE_LIMITED: Refusal = { http: 429, code: -32005, message: `Rate limit exceeded: get a free API key at ${APP_URL}`, retryAfter: 1 };
export const TOO_LARGE: Refusal = { http: 413, code: -32005, message: "Request exceeds 256 KiB" };
