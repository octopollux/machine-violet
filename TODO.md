# TODO

When creating a plan to do any of these items, include a step to update this TODO file!

## Refactoring


## Bugs


## Features
- [x] **Cost display**: Move to Esc menu modal (bottom frame border, yellow text).
- [x] **Cost calculation**: Token counts by tier: `L input/cached | M input/cached | S input/cached`
- [ ] **Hex colors in character sheets**: In the character sheet modal, match on hex color strings (`#\d{6}`) and render the string itself to the specified color. This is so that users can see their color.
- [ ] Claude API connection errors should gracefully force a center-screen modal; this modal should poll a cheap Claude API endpoint (is there a health check endpoint?) and close automatically.
- Session recap should use a center modal, and the DM's turn should not begin until the user has cleared it.
- Human-facing recap should be a narrative summary, not bullets