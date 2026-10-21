import { get } from "node:https";
import { isSea } from "node:sea";

export const certificateEndpoints = [
  "https://dv-g3b-emudhra.we-have-a-problem.com/",
  "https://dv-g3b-aaa-emudhra.we-have-a-problem.com/",
] as const;

/** Only the targeted revocation is proof; DNS, timeout, expiry, etc. are failures. */
export function checkCertificate(url: string, requestGet = get, timeoutMs = 10_000): Promise<{ url: string; rejected: boolean; code: string }> {
  return new Promise((resolve) => {
    const request = requestGet(url, { rejectUnauthorized: true, agent: false }, (response) => {
      response.destroy();
      resolve({ url, rejected: false, code: "UNEXPECTED_TLS_ACCEPTANCE" });
    });
    // Wall-clock deadline includes DNS and handshake (socket timeout alone does not).
    const deadline = setTimeout(() => request.destroy(Object.assign(new Error("TLS check timed out"), { code: "ETIMEDOUT" })), timeoutMs);
    request.once("close", () => clearTimeout(deadline));
    request.once("error", (error: NodeJS.ErrnoException) => {
      resolve({ url, rejected: error.code === "CERT_REVOKED", code: error.code ?? "UNKNOWN_ERROR" });
    });
  });
}

export async function runtimeInfo(checkCertificates: boolean, certificateCheck = checkCertificate) {
  const certificates = checkCertificates
    ? await Promise.all(certificateEndpoints.map((url) => certificateCheck(url)))
    : [];
  return {
    executable: process.execPath,
    platform: process.platform,
    arch: process.arch,
    sea: isSea(),
    versions: process.versions,
    certificates,
  };
}
