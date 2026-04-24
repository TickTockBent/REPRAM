/**
 * Cross-language compatibility check: the Go signer (cmd/repram-omega) must
 * produce TXT-record lines that the TS verifier accepts. This is the
 * canonical-format guard: if either side changes field order, separators,
 * or sort rules, this test fails.
 *
 * Skipped when the repram-omega binary isn't built yet (e.g. fresh clone
 * that hasn't run `make build`). CI builds both.
 */

import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { publicKeyFromBase64, parseSignedList, SignedList } from "./signed-list.js";

const omegaBinary = path.resolve(__dirname, "..", "..", "..", "..", "bin", "repram-omega");
const hasBinary = fs.existsSync(omegaBinary);

describe.skipIf(!hasBinary)("cross-language: Go signer → TS verifier", () => {
  it("Go-signed list parses and verifies with the TS parser", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omega-xlang-"));
    try {
      const privPath = path.join(tmp, "omega-v1.key");
      const pubPath = path.join(tmp, "omega-v1.pub");

      execFileSync(omegaBinary, [
        "keygen",
        "--out-private",
        privPath,
        "--out-public",
        pubPath,
      ], { stdio: "pipe" });

      const signResult = spawnSync(omegaBinary, [
        "sign",
        "--key",
        privPath,
        "--expires-in",
        "1h",
        "--nodes",
        "root-a.example:9090,root-b.example:9090",
      ]);
      if (signResult.status !== 0) {
        throw new Error(`repram-omega sign failed: ${signResult.stderr.toString()}`);
      }
      // The signed TXT-record line is the first line of stdout.
      const txt = signResult.stdout.toString().split(/\r?\n/)[0].trim();

      const pubB64 = fs.readFileSync(pubPath, "utf8").trim();
      const pubKey = publicKeyFromBase64(pubB64);

      const parsed = parseSignedList(txt);
      expect(parsed).toBeInstanceOf(SignedList);

      const verifyErr = (parsed as SignedList).verify(pubKey, new Date());
      expect(verifyErr).toBeNull();

      // Sanity: parsed nodes match what we asked the signer to embed.
      expect((parsed as SignedList).nodes.sort()).toEqual([
        "root-a.example:9090",
        "root-b.example:9090",
      ]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
