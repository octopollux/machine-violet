/**
 * Full-stack golden envelope — what `mvplay save-tape` writes and the
 * packaged-artifact replay gate reads back.
 *
 * It pairs a recorded LLM {@link tape} with everything needed to drive the
 * *same* session deterministically against a running binary:
 *
 *  - `inputs`  — the ordered player input ops that drove the session (menu
 *    navigation + setup answers + DM turns). The replay harness re-issues
 *    them in order; since the tape makes setup + DM deterministic and the
 *    menu is static under a hermetic config dir, identical screens reproduce
 *    identical navigation.
 *  - `expectedNarrative` — the DM/non-player narrative the session produced,
 *    the assertion target on replay.
 *
 * The `inputs` field is additive and lives on the ENVELOPE, not the Tape, so
 * existing engine-level corpus goldens (which carry their inputs in test
 * code) stay valid with no tape-version bump. See docs/tape-format.md.
 */

/** One player input operation, captured at the same semantic level mvplay drives. */
export type RecordedInput =
  | { kind: "key"; name: string }        // a single named key (menu nav: down/up/return/escape/…)
  | { kind: "say"; text: string }        // free-text action / answer + Enter
  | { kind: "pick"; index: number; label: string }; // choose overlay item (0-based index; label for readability)

/** The on-disk shape `mvplay save-tape` writes for a full-stack golden. */
export interface FullStackGolden {
  scenario: string;
  /** Serialized Tape (opaque here — the engine owns the shape). */
  tape: unknown;
  /** DM/non-player narrative lines produced this session; the replay assertion target. */
  expectedNarrative: string[];
  /** Ordered player input ops that drove the session; replayed by the harness. */
  inputs: RecordedInput[];
}
