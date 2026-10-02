# Dependency experiment runner

This isolated, zero-dependency Node runner does not import game code or call a model. Fixtures, prompts, raw model outputs, frozen scoring expectations, and reports belong in this directory. Use `fixtures/` for shared inputs and `results/run-N/` for independent trials.

```text
node docs/experiments/metadata-dependencies/runner.mjs init <fixture-state.json> <run-directory>
node docs/experiments/metadata-dependencies/runner.mjs prepare <run-directory> <stage-name>
node docs/experiments/metadata-dependencies/runner.mjs apply <run-directory> <stage-name> <model-output.json>
node --test docs/experiments/metadata-dependencies/runner.test.mjs
```

Initial state is `{entities:[{id,name,kind?,data,depends_on:[{target,reason}]}]}`. IDs are opaque, stable strings. Every entity must have an object `data` and an array `depends_on`. Model output is exactly `{updates:[{id,name?,data?,depends_on?}],changed:[ids],handled:[ids],notes:[strings]}`. Unknown fields, duplicate update IDs, duplicate dependency targets, duplicate list IDs, and nonexistent IDs reject the entire batch. Entity creation and deletion are intentionally out of scope.

Data updates merge only the top level. Nested values replace their previous value; null, booleans, numbers, arrays, and objects retain their JSON types. A supplied dependency array replaces that entity's entire list, including an empty array to retire all links. Omitted fields are preserved. No edge IDs are needed.

After validating and applying the whole batch, the runner retrieves incoming dependencies up to two edges from every declared changed target. Both old and new lists participate, so retiring a dependency in the same batch does not erase its pending consequence. Notices deduplicate by dependent and preserve paths, old/new reasons, and removal markers. They flag candidate impacted records, not confirmed consequences. Explicitly handled destinations suppress notices but permit traversal through them. Changed-but-unhandled dependents still receive notices from other changed targets. Cyclic paths and paths returning to their origin are skipped. Notices are capped at five in changed-list order with breadth-first retrieval and fixture entity ordering; overflow reports omitted destinations. No automatic narrative mutation occurs.

`prepare` reads `fixtures/stages.json`, keyed by stage name with `{prompt,externalBefore?}` entries. `externalBefore` is a list of trusted runner-side updates using the same shallow merge behavior. Preparation saves the full agent-facing state and prompt to `<stage>.prepared.json` and advances current state before model output. Each stage can be prepared once. `fixtures/config.json` is copied into each run on initialization; `{readonly:[ids]}` rejects model updates to baseline-owned records while permitting trusted external updates.

Each stage saves `raw.json`, `before.json`, `after.json`, and `diagnostics.json`. Invalid batches instead save `rejected.json` and leave current `state.json` unchanged. Existing stage directories reject reuse to preserve evidence. `state.json` advances using a temporary file and rename. This is a serial experiment tool: concurrent writes to the same run directory and crash recovery across multiple files are not supported.

Diagnostics report declared changes, handled IDs, structurally mutated records, mismatches between declarations and mutations, and notice counts. These are inspection aids, not semantic scores: a cosmetic rename can mutate a record without being a meaningful event, and narrative resolution cannot be inferred from structural equality. The coordinator judges frozen semantic expectations. Notes are commentary, never narrative truth. Arbitrary JSON data cannot express key deletion via this shallow merge contract.

`node score.mjs <diagnostics.json> <oracle.json> [stage-name]` checks frozen required/forbidden edges, changed and handled IDs, exact typed values, and notice precision/recall. Oracle schema is documented in the script. Additional edges are allowed unless explicitly forbidden. `overallPass` remains null until coordinator semantic review. Oracle files must never be supplied to the model.
