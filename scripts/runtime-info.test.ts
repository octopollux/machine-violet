import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { get } from "node:https";
import { checkCertificate, runtimeInfo } from "./runtime-info.js";

function mockGet(code?: string, accept = false): typeof get {
  return ((_url: string, options: { rejectUnauthorized: boolean }, response: (value: { destroy(): void }) => void) => {
    assert.equal(options.rejectUnauthorized, true);
    const request = new EventEmitter() as EventEmitter & { destroy(error: Error): void };
    request.destroy = (error) => {
      request.emit("error", error);
      request.emit("close");
    };
    queueMicrotask(() => {
      if (accept) {
        response({ destroy: () => request.emit("close") });
      } else if (code) {
        request.destroy(Object.assign(new Error(code), { code }));
      }
    });
    return request;
  }) as unknown as typeof get;
}

test("only the targeted revocation is a successful negative TLS check", async () => {
  assert.deepEqual(await checkCertificate("https://example.test", mockGet("CERT_REVOKED")), {
    url: "https://example.test", rejected: true, code: "CERT_REVOKED",
  });
  for (const code of ["ENOTFOUND", "ECONNRESET", "CERT_HAS_EXPIRED", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"]) {
    assert.equal((await checkCertificate("https://example.test", mockGet(code))).rejected, false);
  }
});

test("TLS acceptance fails the check", async () => {
  const result = await checkCertificate("https://example.test", mockGet(undefined, true));
  assert.equal(result.rejected, false);
  assert.equal(result.code, "UNEXPECTED_TLS_ACCEPTANCE");
});

test("wall-clock timeout is an inconclusive failure, not revocation", async () => {
  const result = await checkCertificate("https://example.test", mockGet(), 5);
  assert.equal(result.rejected, false);
  assert.equal(result.code, "ETIMEDOUT");
});

test("runtime diagnostics invoke both probes without leaking map callback arguments", async () => {
  const result = await runtimeInfo(true, async (url, requestGet) => {
    assert.equal(requestGet, undefined);
    return { url, rejected: true, code: "CERT_REVOKED" };
  });
  assert.equal(result.certificates.length, 2);
  assert.equal(result.versions.node, process.versions.node);
});
