# Document Ingestion Design

> **Status: Not Implemented** — this is a design spec for a planned feature. No code exists yet.
> Tracked in [#67](https://github.com/Orthodox-531/tui-rpg/issues/67).

Machine Violet needs to import RPG sourcebooks (rulebooks and campaign books) from user-supplied files, primarily PDFs. These are complex, high-production-value documents with multi-column layouts, stat blocks, sidebars, tables, and decorative elements.

## Core Principles

- **Import is a one-time operation.** The expensive extraction happens once. After that, everything is organized files the DM can read natively through the filesystem.
- **Vision-capable models handle complex layouts.** Traditional PDF text extraction loses layout structure. A model that can see the page as an image understands columns, stat blocks, sidebars, and tables visually.
- **Text extraction where it works, vision where it doesn't.** If the PDF has embedded text and the extraction produces clean output (simple layout, no column interleaving), use the text — it's cheaper. Fall back to page images for complex layouts.
- **The output is the entity filesystem.** Imported content lands in the same directory structure as everything else: `rules/`, `locations/`, `characters/`, `lore/`, etc. No special "imported content" silo.

## The Import Pipeline

### Phase 1: Extraction (PDF → raw structured text)

Each page is processed independently into structured markdown.

**For pages with clean embedded text** (simple layout, single column):
- Extract text using a PDF parsing library
- Light cleanup pass — fix encoding, normalize whitespace
- Cheaper: ~500-800 input tokens per page

**For pages with complex layouts** (multi-column, stat blocks, sidebars, tables):
- Render page as image or send PDF page directly via the Claude API (which accepts PDFs natively)
- Haiku with vision extracts content with structure preserved: section headings, stat blocks, tables, sidebar boxes, and body text as distinct elements
- More reliable for complex layouts: ~1000-2000 input tokens per page

A simple heuristic can auto-select the approach: extract text first, check if the output has reasonable line lengths and recognizable structure, fall back to vision if it doesn't. Alternatively, just use the Claude API's native PDF support and let it handle the decision.

Output: a structured markdown file per page or chapter.

### Phase 2: Organization (raw text → entity filesystem)

A Haiku agent reads the extracted content and sorts it into the campaign directory structure:

- **Rules content** → `rules/` files, sectioned by topic (combat, spellcasting, character creation, etc.)
- **Location descriptions** → `locations/` directories with index files
- **NPC/monster stat blocks** → `characters/` files
- **Lore and world-building** → `lore/` files
- **Random tables** → left as markdown in the appropriate rules or lore files
- **Campaign plot structure** → campaign notes, scene seeds, DM guidance
- **Distilled rule cards** → compressed reference cards for the resolution subagent (see [randomization.md](randomization.md))

Cross-references are converted to wikilinks where possible. "See Chapter 4: The Goblin Caves" becomes a link to `locations/goblin-caves/index.md`.

### Phase 3: Indexing (make it findable)

Generate a **table of contents file** for the imported material — a markdown document with section headings and wikilinks to all organized content. This is the DM's entry point into the imported material.

For campaign books, also generate a **DM cheat sheet** — a dense summary of the adventure structure:
- Act/chapter breakdown
- Key NPCs and their agendas
- Plot branches and decision points
- Important locations
- Ticking clocks and scheduled events

The cheat sheet goes into the DM's context at session start so it has the big picture without loading the whole book.

## Rulebooks vs Campaign Books

**Rulebooks** are reference material. Extract, organize into topical sections, distill rule cards. The DM accesses specific sections on demand. Content is mostly static.

**Campaign books** are a mix of reference and narrative:
- **Reference material** (maps, stat blocks, encounter tables) → organized like rulebook content
- **Plot structure** (adventure hooks, act breakdowns, branching paths) → the DM cheat sheet
- **Boxed text / read-aloud sections** → preserved in location or scene files for the DM to use or adapt
- **DM guidance** (how to run encounters, pacing advice) → scene-specific notes or lore files, wikilinked from relevant locations

The key difference: campaign content has a narrative arc the DM needs to internalize, not just look up. The cheat sheet gets the arc into the DM's context without loading 200 pages.

## Normal vs Batch Import

The user chooses at import time:

### Normal import (immediate, full price)

Pages are processed in parallel via the standard API. Results come back in real time. The full pipeline (extraction → organization → indexing) runs in one session. A 300-page book takes a few minutes and costs approximately $2-3 through Haiku.

### Batch import (50% off, async)

The Batch API processes requests at half the token cost, typically completing within about an hour.

**Submission:**
1. Split PDF into pages
2. Generate a JSONL file with one extraction request per page (same prompt as normal mode)
3. Submit to the Batch API
4. Save the batch ID to `campaign-root/state/pending-import.json`
5. Notify the user: "Import submitted. The app will check for results automatically."

**Completion:**
- The app polls the Batch API on a ~5 minute timer in the background
- On completion: download results, run the organization and indexing phases (Phase 2 + 3), remove the pending-import marker
- Notify the user that the import is ready

**On app startup:**
- Check for `pending-import.json`. If present, poll immediately and resume the pipeline if results are ready.

The extraction prompt and response handling are identical in both modes. The only additional code is JSONL serialization, batch submission, polling, and result download.

**User-facing choice:** "Import now (~$2-3, takes a few minutes)" vs "Import via batch (~$1-1.50, usually ready within an hour)."

## Edge Cases

- **Scanned PDFs**: Older sourcebooks may be scanned images with no text layer. The vision approach handles this naturally, but OCR quality on old scans may be rough. The import agent should flag pages it's uncertain about for human review.
- **Cost transparency**: The app should estimate import cost before starting (based on page count and selected mode) and confirm with the user.
- **Incremental import**: Support importing a subset of pages ("just chapters 1-3 for now"). Reduces cost and supports campaigns you're only partway through.
- **Copyright notice**: The app should be clear that it processes the user's legally obtained copy. A brief "you must own this material" disclaimer during import.
- **Re-import**: If the user imports the same book again (e.g., after a pipeline improvement), the app should warn that existing organized files will be overwritten.

## What Stays at Runtime vs What's Pre-Processed

| Concern | When | How |
|---|---|---|
| PDF → structured text | Import time | Vision model or text extraction |
| Organizing into filesystem | Import time | Haiku agent sorts content |
| Generating rule cards | Import time | Haiku distills full rules |
| Generating DM cheat sheet | Import time | Haiku summarizes campaign structure |
| Finding a specific rule | Runtime | DM reads the index, follows links |
| Looking up a stat block | Runtime | DM reads the character file |
| Interpreting a random table | Runtime | Haiku reads the table markdown, rolls and interprets |
