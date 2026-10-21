#!/usr/bin/env node
// Inspect the shipped process, never the host's Node as a proxy for its runtime.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import process from "node:process";
import console from "node:console";
import { URL } from "node:url";

const binary = process.argv[2];
assert.ok(binary, "usage: node scripts/ci/verify-runtime.js <packaged-binary> [--check-certificates]");
const expected = readFileSync(new URL("../../.node-version", import.meta.url), "utf8").trim();
const checkCertificates = process.argv.includes("--check-certificates");
const args = ["--runtime-info", ...(checkCertificates ? ["--check-certificates"] : [])];
const result = JSON.parse(execFileSync(binary, args, { encoding: "utf8", timeout: 30_000 }));
console.log(JSON.stringify(result, null, 2));
assert.equal(result.sea, true, "packaged gate must run a SEA executable");
assert.equal(result.versions.node, expected, "packaged Node must match the pinned patched builder");
assert.ok(result.versions.openssl, "packaged runtime must report OpenSSL");
if (checkCertificates) {
  assert.equal(result.certificates.length, 2);
  for (const certificate of result.certificates) {
    assert.equal(certificate.code, "CERT_REVOKED", `${certificate.url}: certificate revocation was not verified`);
    assert.equal(certificate.rejected, true);
  }
}
