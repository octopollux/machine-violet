import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAtomicFile } from "./atomic-file.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const roots: string[] = [];
afterEach(async () => {
  vi.mocked(rename).mockClear();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
describe("atomic campaign JSON replacement", () => {
  it("leaves the previous journal intact after a failed replacement and cleans the incomplete proposal", async () => {
    const root = await mkdtemp(join(tmpdir(), "mv-atomic-journal-")); roots.push(root);
    const path = join(root, "pending-operation.json");
    const previous = JSON.stringify({ transitionId: "stable", updates: { operations: [{ op: "append_log", body: "Exact payload" }] } });
    await writeFile(path, previous);
    vi.mocked(rename).mockRejectedValueOnce(new Error("replace interrupted"));
    await expect(writeAtomicFile(path, JSON.stringify({ transitionId: "stable", step: "done" }))).rejects.toThrow("replace interrupted");
    expect(await readFile(path, "utf-8")).toBe(previous);
    expect(await readdir(root)).toEqual(["pending-operation.json"]);
    await writeAtomicFile(path, JSON.stringify({ transitionId: "stable", step: "done" }));
    expect(JSON.parse(await readFile(path, "utf-8"))).toEqual({ transitionId: "stable", step: "done" });
    expect(await readdir(root)).toEqual(["pending-operation.json"]);
  });
});
