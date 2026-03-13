# Document Ingestion

PDF text extraction is implemented. Content processing is planned.

Tracked in [#67](https://github.com/Orthodox-531/machine-violet/issues/67).

## Architecture

The pipeline has two distinct operations, separated by a durable cache:

1. **PDF Cracking** (implemented) — local text extraction, no AI, no API calls
2. **Content Processing** (planned) — Haiku-powered classification and organization

The content pipeline (`src/content/`) is **completely separate** from the game engine. They share only a filesystem format as interface.

## PDF Cracking (Implemented)

### User flow

1. User selects "Add Content" from the Main Menu
2. User names a **collection** (e.g. "D&D 5e") — the grouping key for related PDFs
3. User drops one or more PDF file paths
4. App validates PDFs and displays page counts
5. On confirmation, text is extracted locally and cached

### How it works

Text extraction uses `pdf-parse` (built on Mozilla's pdf.js) to read embedded text layers directly from PDF pages. This is a mechanical operation — no AI, no API calls, no cost, nearly instant. Most commercial RPG sourcebooks have embedded text layers.

Pages that yield no text (full-art pages, image-only scans) are tracked as empty pages in the job manifest.

### Cache structure

```
~/.machine-violet/ingest/
  cache/
    <collection-slug>/
      manifest.json                     # collection-level metadata
      <pdf-basename-slug>/
        pages/
          0001.md ... 0343.md           # one file per page, raw extracted text
  jobs/
    <collection-slug>/
      <pdf-basename-slug>.json          # job status, page counts, errors
```

Job naming: `{collection} — {PDF basename}` (e.g. "D&D 5e — Dungeon Master's Guide").

### Why not the Claude API?

The original design used the Claude API's native PDF support with Haiku for extraction. This was blocked by content policy — the model refuses to reproduce text from copyrighted sourcebooks, regardless of system prompt framing. Local text extraction bypasses this entirely since it's a mechanical operation (like copy-paste), not content generation.

The Batch API client (`src/content/batch-client.ts`) is retained for the content processing pipeline, where AI is needed for *understanding* content, not reproducing it.

## Content Processing (Planned)

After cracking, the raw cached text is processed through a five-stage pipeline. Each stage reads from the previous stage's output, never from the PDF.

### Stage 1: Classifier (Haiku)

Reads cached page text in 20-page overlapping chunks (2-page overlap). Produces a structured content catalog mapping page ranges to content types. This catalog is a retainable intermediate artifact.

### Stage 2: Extractors (Haiku, parallelizable)

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

### Stage 3: Merge (Haiku, agentic)

Compare-and-merge draft entities against existing content in the system cache. Supports adding additional sourcebooks to an existing system.

### Stage 4: Index (Haiku)

Build table of contents and DM cheat sheet from the final filesystem state.

### Stage 5: Rule Card Generation (model TBD)

Runs last, against all well-baked extracted content. Only fires for systems without a hand-authored rule card in `systems/`. Uses bundled rule cards as few-shot examples. Produces XML-directive format output matching the hand-authored card structure.

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
