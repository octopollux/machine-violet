# Include Files

Files here are reusable prompt fragments that other prompts (and inline
prompt strings — campaign seed, DM personality) can pull in via the
`<!--include:TagName-->` or `<!--include:TagName.Variant-->` directive.

The directive is resolved by `processIncludes` in
[../process-includes.ts](../process-includes.ts) — see that file's header
comment for the authoritative spec. Short version:

- An include lives at `include/<TagName>.md`. The directive
  `<!--include:NPCS-->` reads `include/NPCS.md`; `<!--include:NPCS.Military-->`
  selects the `<Military>` section from the same file.
- The directive is replaced inline with `<TagName>…</TagName>`. The outer
  tag is always the file stem, never the variant. So `NPCS.Military` always
  produces `<NPCS>` — that's the *whole point* of the dot notation: pick a
  variant of the same logical entity.
- Dotless includes (`<!--include:NPCS-->`) look for a section named
  `<NPCS>` inside `NPCS.md` — the conventional default. A file with no
  top-level XML sections at all is treated as one implicit default section.

## Cascading override

When the same top-level XML tag appears in more than one override slot, the
latest slot wins and earlier occurrences are removed entirely. `buildDMPrefix`
passes **five slots**, lowest → highest priority: `dm-identity` →
`dm-directives` → `campaign_detail` → DM-personality `prompt_fragment` →
DM-personality `detail` (three conceptual sources — main DM, campaign seed, DM
personality — but five distinct slots). So a personality template can include
`NPCS.HighFantasy` to replace whatever `<NPCS>` block the main DM prompt
established, without editing the main file; likewise the setup agent's appended
`campaign_detail` can override a seed's block.

This applies to inline `<NPCS>…</NPCS>` blocks too, not just blocks
produced by `<!--include:-->`.
