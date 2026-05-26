import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnectionTokenStore, _resetRefreshLocksForTest } from "./token-store.js";
import type { OAuthTokens } from "./oauth.js";

let tempDir: string;

function writeConnectionWithTokens(refreshToken: string, accessToken: string, expiresAtMs: number): void {
  writeFileSync(join(tempDir, "connections.json"), JSON.stringify({
    connections: [{
      id: "conn-1",
      provider: "openai-chatgpt",
      label: "ChatGPT",
      apiKey: "",
      chatgptAccount: {
        id: "acct-A",
        email: "u@example.com",
        accessToken,
        refreshToken,
        expiresAtMs,
      },
      models: [],
      source: "oauth",
      addedAt: "",
    }],
    tierAssignments: { large: null, medium: null, small: null },
  }));
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mv-token-store-"));
  _resetRefreshLocksForTest();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  _resetRefreshLocksForTest();
});

describe("ChatGptTokenStore.refresh", () => {
  it("returns null when no tokens are stored", async () => {
    const store = createConnectionTokenStore(tempDir, "conn-1", vi.fn());
    await expect(store.refresh()).resolves.toBeNull();
  });

  it("exchanges the stored refresh_token for a fresh bundle and persists it", async () => {
    writeConnectionWithTokens("rt-old", "at-old", 1);
    const refreshFn = vi.fn<(rt: string) => Promise<OAuthTokens>>().mockResolvedValue({
      accessToken: "at-new",
      refreshToken: "rt-new",
      idToken: "id-new",
      expiresAtMs: 9_999_999,
      chatgptAccountId: "acct-A",
      chatgptPlanType: "plus",
    });
    const store = createConnectionTokenStore(tempDir, "conn-1", refreshFn);

    const result = await store.refresh();

    expect(refreshFn).toHaveBeenCalledWith("rt-old");
    expect(result?.accessToken).toBe("at-new");
    expect(result?.refreshToken).toBe("rt-new");
    // Persisted on disk
    const reloaded = store.load();
    expect(reloaded?.accessToken).toBe("at-new");
    expect(reloaded?.refreshToken).toBe("rt-new");
  });

  it("coalesces concurrent refresh calls onto a single OAuth exchange", async () => {
    // Regression guard for "refresh_token already used": without
    // coalescing, both calls would POST grant_type=refresh_token with
    // the same RT, OpenAI rotates the RT on the first call, and the
    // second errors with "already used".
    writeConnectionWithTokens("rt-shared", "at-old", 1);
    let resolveExchange!: (v: OAuthTokens) => void;
    const exchange = new Promise<OAuthTokens>((res) => { resolveExchange = res; });
    const refreshFn = vi.fn<(rt: string) => Promise<OAuthTokens>>().mockReturnValue(exchange);

    const store = createConnectionTokenStore(tempDir, "conn-1", refreshFn);
    const [p1, p2, p3] = [store.refresh(), store.refresh(), store.refresh()];

    // All three are now in flight; only the leader's exchange fires.
    expect(refreshFn).toHaveBeenCalledTimes(1);

    resolveExchange({
      accessToken: "at-new",
      refreshToken: "rt-new",
      idToken: undefined,
      expiresAtMs: 9_999_999,
      chatgptAccountId: "acct-A",
      chatgptPlanType: "plus",
    });

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1?.accessToken).toBe("at-new");
    expect(r2?.accessToken).toBe("at-new");
    expect(r3?.accessToken).toBe("at-new");
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });

  it("releases the lock when the leader's exchange fails so the next call can retry", async () => {
    writeConnectionWithTokens("rt-shared", "at-old", 1);
    const refreshFn = vi.fn<(rt: string) => Promise<OAuthTokens>>()
      .mockRejectedValueOnce(new Error("transient network error"))
      .mockResolvedValueOnce({
        accessToken: "at-new",
        refreshToken: "rt-new",
        idToken: undefined,
        expiresAtMs: 9_999_999,
        chatgptAccountId: "acct-A",
        chatgptPlanType: "plus",
      });

    const store = createConnectionTokenStore(tempDir, "conn-1", refreshFn);
    await expect(store.refresh()).rejects.toThrow("transient network error");
    // The lock must be released so a subsequent retry can fire a fresh exchange.
    const result = await store.refresh();
    expect(result?.accessToken).toBe("at-new");
    expect(refreshFn).toHaveBeenCalledTimes(2);
  });

  it("scopes the lock per (configDir, connectionId) so unrelated stores don't block each other", async () => {
    writeConnectionWithTokens("rt-1", "at-1", 1);
    const otherDir = mkdtempSync(join(tmpdir(), "mv-token-store-other-"));
    try {
      writeFileSync(join(otherDir, "connections.json"), JSON.stringify({
        connections: [{
          id: "conn-1", provider: "openai-chatgpt", label: "ChatGPT", apiKey: "",
          chatgptAccount: { id: "acct-B", accessToken: "at-2", refreshToken: "rt-2", expiresAtMs: 1 },
          models: [], source: "oauth", addedAt: "",
        }],
        tierAssignments: { large: null, medium: null, small: null },
      }));

      const refreshFn = vi.fn<(rt: string) => Promise<OAuthTokens>>().mockImplementation(async (rt) => ({
        accessToken: `${rt}->fresh`,
        refreshToken: `${rt}-rot`,
        idToken: undefined,
        expiresAtMs: 1,
        chatgptAccountId: rt === "rt-1" ? "acct-A" : "acct-B",
        chatgptPlanType: "plus",
      }));

      const storeA = createConnectionTokenStore(tempDir, "conn-1", refreshFn);
      const storeB = createConnectionTokenStore(otherDir, "conn-1", refreshFn);
      const [a, b] = await Promise.all([storeA.refresh(), storeB.refresh()]);

      // Each store got its own exchange — unrelated lock scopes don't block.
      expect(refreshFn).toHaveBeenCalledTimes(2);
      expect(a?.accessToken).toBe("rt-1->fresh");
      expect(b?.accessToken).toBe("rt-2->fresh");
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });
});
