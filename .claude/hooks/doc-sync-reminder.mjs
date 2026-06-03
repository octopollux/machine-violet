#!/usr/bin/env node
// Gentle, NON-BLOCKING doc-sync reminder.
//
// Fires as a PostToolUse hook on the Bash tool. It no-ops for everything except
// a successful `git commit`. When a commit lands that changed application code
// (packages/*/src/**.ts|tsx) but touched no docs/ files, it injects a soft
// reminder into the model's context pointing at docs/maintenance.md.
//
// It is deliberately advisory: it never blocks, never fails a tool, and it
// explicitly tells the agent that refactors / bug fixes / tests / internal
// changes need no documentation. The goal is to catch the case where a
// behavior/contract change shipped without its doc — not to tax every commit.
//
// Scope notes:
//   - Only packages/*/src code counts. The tools/ helper apps are intentionally
//     exempt (they carry their own light docs, not the maintenance.md loop).
//   - Tests (*.test.*, *.spec.*) and declaration files (*.d.ts) never count.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

function main() {
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    process.exit(0);
  }

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0); // not our concern — stay silent
  }

  const command = input?.tool_input?.command;
  if (typeof command !== "string" || !command.includes("git commit")) {
    process.exit(0);
  }

  // If the Bash tool reported failure, the commit likely didn't happen — don't
  // nag based on a stale HEAD.
  if (input?.tool_response && input.tool_response.success === false) {
    process.exit(0);
  }

  // Inspect the files in the most recent commit.
  const res = spawnSync(
    "git",
    ["show", "--name-only", "--pretty=format:", "HEAD"],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  if (res.status !== 0 || typeof res.stdout !== "string") {
    process.exit(0);
  }

  const files = res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (files.length === 0) process.exit(0);

  const isCode = (f) =>
    /^packages\/[^/]+\/src\/.+\.(ts|tsx)$/.test(f) &&
    !/\.(test|spec)\.[tj]sx?$/.test(f) &&
    !/\.d\.ts$/.test(f);
  const isDocs = (f) => f.startsWith("docs/");

  const codeFiles = files.filter(isCode);
  const docsTouched = files.some(isDocs);

  if (codeFiles.length === 0 || docsTouched) {
    process.exit(0); // either no app code changed, or docs were updated alongside
  }

  const shown = codeFiles.slice(0, 10);
  const more = codeFiles.length - shown.length;
  const fileList =
    shown.map((f) => `  - ${f}`).join("\n") +
    (more > 0 ? `\n  …and ${more} more` : "");

  const context =
    `📝 Doc-sync reminder — the commit you just made changed application code under ` +
    `packages/*/src but updated no docs/ files:\n${fileList}\n\n` +
    `Per docs/maintenance.md, changes to game behavior, tool/subagent contracts, state shape, ` +
    `REST/WebSocket contracts, or on-disk formats should update the matching doc in the same commit.\n\n` +
    `This is only a nudge — use your judgment. If this change is an internal refactor, bug fix, ` +
    `test, perf tweak, comment/formatting change, or otherwise doesn't alter documented behavior, ` +
    `no docs are needed; don't write documentation that adds no value. If docs ARE warranted, ` +
    `amend this commit (git commit --amend) or add a follow-up commit before moving on.`;

  process.stdout.write(
    JSON.stringify({
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: context,
      },
    }),
  );
  process.exit(0);
}

main();
