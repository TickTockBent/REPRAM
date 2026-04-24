/**
 * On-disk cache for verified signed root lists. Mirrors Go's internal/trust/cache.go
 * schema so both implementations could in principle share a cache directory.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SignedList } from "./signed-list.js";

export const CACHE_FILE_NAME = "root-list.json";

interface CachedList {
  version: string;
  expires: number;
  nodes: string[];
  signature: string; // base64
}

/**
 * Resolve the cache directory with the priority defined in the 2.1 spec:
 *   REPRAM_CACHE_DIR  >  $HOME/.repram/cache  >  /var/cache/repram
 */
export function defaultCacheDir(): string {
  const explicit = process.env.REPRAM_CACHE_DIR;
  if (explicit) return explicit;
  const home = os.homedir();
  if (home) return path.join(home, ".repram", "cache");
  return "/var/cache/repram";
}

/**
 * loadCache reads the persisted list at `${dir}/root-list.json`. Returns
 * `null` when the file is absent (normal first-run condition). Throws on
 * other I/O or parse failures. Callers must still verify the returned list
 * — an attacker with filesystem write access could swap in another signed
 * list from the same omega version.
 */
export async function loadCache(dir: string): Promise<SignedList | null> {
  const filePath = path.join(dir, CACHE_FILE_NAME);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const parsed = JSON.parse(raw) as CachedList;
  return new SignedList({
    version: parsed.version,
    expires: parsed.expires,
    nodes: parsed.nodes,
    signature: Buffer.from(parsed.signature, "base64"),
  });
}

/**
 * saveCache writes atomically via tempfile+rename so a partial write can
 * never produce a malformed cache file.
 */
export async function saveCache(dir: string, list: SignedList): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  if (!list.signature) {
    throw new Error("saveCache: list has no signature — refusing to persist unsigned data");
  }

  const payload: CachedList = {
    version: list.version,
    expires: list.expires,
    nodes: list.nodes,
    signature: list.signature.toString("base64"),
  };

  const finalPath = path.join(dir, CACHE_FILE_NAME);
  const tmpPath = path.join(
    dir,
    `${CACHE_FILE_NAME}.${process.pid}.${Date.now()}.tmp`,
  );

  await fs.writeFile(tmpPath, JSON.stringify(payload), { mode: 0o600 });
  try {
    await fs.rename(tmpPath, finalPath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true });
    throw err;
  }
}
