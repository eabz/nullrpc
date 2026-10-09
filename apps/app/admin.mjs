#!/usr/bin/env bun
// nullrpc admin CLI. Calls the nullrpc-app admin
// API with the bearer token from the ADMIN_TOKEN environment variable (never printed or logged).
//
//   ADMIN_TOKEN=… bun apps/app/admin.mjs <command> [args] [--url https://app.nullrpc.dev]
//
//   report [--live | --day YYYYMMDD]      the daily anomaly report (latest stored by default)
//   account <address>                     account, keys, payments, 30-day usage, admin log
//   suspend <address> [--note TEXT]       suspend the account (sign-in, API and every key)
//   unsuspend <address> [--note TEXT]     lift an abuse suspension (not a sanctions one)
//   plan <address> <plan> [--months N] [--note TEXT]
//                                         set free | unverified | internal | builder | growth | scale
//   note <address> TEXT                   record a note on the account
//   key-suspend <key id> [--note TEXT]    suspend one API key (32 hex id)
//   key-unsuspend <key id> [--note TEXT]
//
// The base URL defaults to $ADMIN_URL or https://app.nullrpc.dev. Output is the JSON response.

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--live") flags.live = true;
  else if (a.startsWith("--")) flags[a.slice(2)] = args[++i];
  else positional.push(a);
}
const [command, target, extra] = positional;

function usage(code = 2) {
  // The header above is the help text.
  const text = readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 18).map((l) => l.replace(/^\/\/ ?/, "")).join("\n");
  (code ? console.error : console.log)(text);
  process.exit(code);
}

if (!command || command === "help" || flags.help !== undefined) usage(command ? 0 : 2);
const token = process.env.ADMIN_TOKEN;
if (!token) {
  console.error("admin: set ADMIN_TOKEN in the environment (the value of the nullrpc-app ADMIN_TOKEN secret)");
  process.exit(2);
}
const base = (flags.url ?? process.env.ADMIN_URL ?? "https://app.nullrpc.dev").replace(/\/$/, "");
if (!/^https:\/\/[^\s/]+$/.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) {
  console.error("admin: --url must be https://host (or http://localhost:port)");
  process.exit(2);
}

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      message = JSON.parse(text).error ?? text;
    } catch {}
    console.error(`admin: ${method} ${path}: HTTP ${res.status}: ${message}`);
    process.exit(1);
  }
  console.log(text);
}

const need = (value, what) => {
  if (!value) {
    console.error(`admin: ${command} needs ${what}`);
    process.exit(2);
  }
  return value;
};
const address = () => {
  const a = need(target, "an address");
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) {
    console.error("admin: invalid address");
    process.exit(2);
  }
  return a;
};
const keyId = () => {
  const id = need(target, "a key id");
  if (!/^[0-9a-f]{32}$/.test(id)) {
    console.error("admin: a key id is 32 lowercase hex characters");
    process.exit(2);
  }
  return id;
};
const note = flags.note === undefined ? {} : { note: flags.note };

switch (command) {
  case "report": {
    const query = flags.live ? "?live=1" : flags.day ? `?day=${encodeURIComponent(flags.day)}` : "";
    await call("GET", `/api/admin/report${query}`);
    break;
  }
  case "account":
    await call("GET", `/api/admin/account/${address()}`);
    break;
  case "suspend":
  case "unsuspend":
    await call("POST", `/api/admin/account/${address()}`, { suspended: command === "suspend", ...note });
    break;
  case "plan": {
    const a = address();
    const body = { plan: need(extra, "a plan"), ...note };
    if (flags.months !== undefined) body.months = Number(flags.months);
    await call("POST", `/api/admin/account/${a}`, body);
    break;
  }
  case "note":
    await call("POST", `/api/admin/account/${address()}`, { note: need(extra, "the note text") });
    break;
  case "key-suspend":
  case "key-unsuspend":
    await call("POST", `/api/admin/key/${keyId()}`, { suspended: command === "key-suspend", ...note });
    break;
  default:
    console.error(`admin: unknown command ${command}`);
    usage();
}
