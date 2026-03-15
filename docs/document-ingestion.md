# Document Ingestion

PDF text extraction and content processing are implemented as a unified flow.

Tracked in [#67](https://github.com/octopollux/machine-violet/issues/67).

## Architecture

The pipeline has two distinct operations, separated by a durable cache:

1. **PDF Cracking** — local text extraction, no AI, no API calls
2. **Content Processing** — Haiku-powered classification, extraction, merging, indexing, and rule card generation

The content pipeline (`src/content/`) is **completely separate** from the game engine. They share only a filesystem format as interface.

## User Flow

1. User selects "Add Content" from the Main Menu
2. User picks a **game system** from the system picker (known systems like "D&D 5th Edition" or custom via "Other")
3. User drops one or more PDF file paths
4. App validates PDFs and displays page counts
5. On confirmation, the full pipeline runs:
   - Text extraction (local, instant)
   - 5-stage content processing (Haiku, uses Batch API)
6. Processed output lands at `~/.machine-violet/systems/<slug>/`

## PDF Cracking

Text extraction uses `pdf-parse` (built on Mozilla's pdf.js) to read embedded text layers directly from PDF pages. This is a mechanical operation — no AI, no API calls, no cost, nearly instant. Most commercial RPG sourcebooks have embedded text layers.

Pages that yield no text (full-art pages, image-only scans) are tracked as empty pages in the job manifest.

### Cache structure

```
~/.machine-violet/ingest/
  cache/
    <system-slug>/
      <pdf-basename-slug>/
        pages/
          0001.md ... 0343.md           # one file per page, raw extracted text
  jobs/
    <system-slug>/
      <pdf-basename-slug>.json          # job status, page counts, errors
```

### Why not the Claude API?

The original design used the Claude API's native PDF support with Haiku for extraction. This was blocked by content policy — the model refuses to reproduce text from copyrighted sourcebooks, regardless of system prompt framing. Local text extraction bypasses this entirely since it's a mechanical operation (like copy-paste), not content generation.

The Batch API client (`src/content/batch-client.ts`) is retained for the content processing pipeline, where AI is needed for *understanding* content, not reproducing it.

## Content Processing

After cracking, the raw cached text is processed through a five-stage pipeline. Each stage reads from the previous stage's output, never from the PDF.

### Output structure

```
~/.machine-violet/systems/<slug>/
  pipeline.json            # stage tracking for resume
  catalog.json             # Stage 1 output
  drafts/                  # Stage 2 output
    <category>/<entity>.md
  entities/                # Stage 3 output (merged)
    <category>/<entity>.md
    <category>/facets.json # Stage 4 output (faceted entity index per category)
  index.md                 # Stage 4 output
  cheat-sheet.md           # Stage 4 output
  rule-card.md             # Stage 5 output (generated or copied from bundled)
```

### Stage 1: Classifier (Haiku, Batch API)

Reads cached page text in 20-page overlapping chunks (2-page overlap). Produces a structured content catalog mapping page ranges to content types. This catalog is a retainable intermediate artifact.

### Stage 2: Extractors (Haiku, Batch API)

One job per catalog section, specialized by content type:
- Monsters / creatures
- Spells / abilities / powers
- Rules chapters
- Character creation / classes / archetypes
- Equipment / items
- Tables (random encounters, loot, names, etc.)
- Lore / setting / history
- Maps / location descriptions
- Generic fallback for uncategorized content

Every entity gets its own file (full granularity). Uses the Batch API for cost efficiency.

### Stage 3: Merge (Haiku, oneShot)

Compare-and-merge draft entities against existing content. Supports adding additional sourcebooks to an existing system.

### Stage 4: Index (Haiku, oneShot)

Build table of contents, DM cheat sheet, and faceted entity indexes from the final filesystem state. Each category directory gets a `facets.json` file containing all entity front matter fields as a structured index. This enables the `search_content` tool to find entities by mechanical properties (CR, level, type, etc.) without reading every entity file.

### Stage 5: Rule Card

For bundled systems with a hand-authored rule card in `systems/`, the bundled card is **copied** to the output directory. For unknown systems, a rule card is generated using Haiku with bundled rule cards as few-shot examples.

## System Catalog

Known game systems are defined in `src/config/systems.ts`. At runtime, `listAvailableSystems()` merges the static catalog with discovered directories in `~/.machine-violet/systems/` to show which systems have been processed.

## What Stays at Runtime vs What's Pre-Processed

| Concern | When | How |
|---|---|---|
| PDF → raw text | Add Content (local) | pdf-parse text extraction |
| Classifying content | Processing time | Haiku reads cached text |
| Extracting entities | Processing time | Haiku specialized extractors |
| Generating rule cards | Processing time | Haiku/Sonnet (for unknown systems only) |
| Generating DM cheat sheet | Processing time | Haiku summarizes structure |
| Finding a specific rule | Runtime | DM reads the index, follows links |
| Looking up a stat block | Runtime | DM reads the character file |
| Interpreting a random table | Runtime | Haiku reads the table markdown, rolls and interprets |
