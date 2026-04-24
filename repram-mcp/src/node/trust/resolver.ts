/**
 * DNS-layer resolver for REPRAM 2.1 signed root discovery. Walks
 * `_bootstrap.repram.io` → `_omega.repram.io` and returns a verified list,
 * or an Error. Wire-compatible with internal/trust/resolver.go.
 */

import * as dns from "node:dns/promises";
import type { KeyObject } from "node:crypto";
import { parseSignedList, SignedList } from "./signed-list.js";

export const DEFAULT_BOOTSTRAP_NAME = "_bootstrap.repram.io";

/** Minimal TXT-resolver interface. Node's dns.promises satisfies it. */
export interface TXTResolver {
  resolveTxt(hostname: string): Promise<string[][]>;
}

export interface DnsConfig {
  /** Resolver override; defaults to node:dns/promises. */
  resolver?: TXTResolver;
  /** Indirection entry point; defaults to _bootstrap.repram.io. */
  bootstrapName?: string;
}

const defaultResolver: TXTResolver = {
  resolveTxt: (name) => dns.resolveTxt(name),
};

/**
 * fetchSigned performs the two-hop TXT lookup and returns a verified list.
 * Rejects with a single Error on any failure (DNS, parse, verify) — no
 * partial success states.
 */
export async function fetchSigned(
  cfg: DnsConfig,
  pubKey: KeyObject,
  now: Date,
): Promise<SignedList> {
  const resolver = cfg.resolver ?? defaultResolver;
  const bootstrapName = cfg.bootstrapName ?? DEFAULT_BOOTSTRAP_NAME;

  const indirection = await lookupSingleTxt(resolver, bootstrapName);
  const target = parseBootstrapIndirection(indirection);
  if (target instanceof Error) throw target;

  const raw = await lookupSingleTxt(resolver, target);
  const list = parseSignedList(raw);
  if (list instanceof Error) throw list;

  const verifyErr = list.verify(pubKey, now);
  if (verifyErr) throw verifyErr;

  return list;
}

async function lookupSingleTxt(
  resolver: TXTResolver,
  name: string,
): Promise<string> {
  const records = await resolver.resolveTxt(name);
  // Node returns string[][] — each record is an array of 255-byte
  // character-strings that the DNS wire format splits a single logical
  // record into. We must re-join the segments here before parsing.
  // (The Go parallel in internal/trust/resolver.go does not need to do
  // this: net.Resolver.LookupTXT concatenates segments internally and
  // returns []string where each element is already a complete record.)
  for (const record of records) {
    const joined = record.join("").trim();
    if (joined) return joined;
  }
  throw new Error(`trust: TXT lookup for ${name} returned no usable records`);
}

function parseBootstrapIndirection(raw: string): string | Error {
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "omega") {
      if (!value) return new Error("trust: bootstrap TXT record has empty omega= entry");
      return value;
    }
  }
  return new Error("trust: bootstrap TXT record has no omega= entry");
}
