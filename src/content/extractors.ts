/**
 * Stage 2: Extractors — per-section batch requests for entity extraction.
 *
 * Reads the catalog from Stage 1, loads page text for each section,
 * dispatches to the appropriate extractor prompt based on contentType,
 * and parses results into DraftEntity objects using entity-parser.
 *
 * Each catalog section becomes one batch request. Results are parsed
 * and written to drafts/<category>/<slug>.md.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { FileIO } from "../agents/scene-manager.js";
import { getModel } from "../config/models.js";
import { serializeEntity } from "../tools/filesystem/frontmatter.js";
import { ingestPaths } from "./job-manager.js";
import { parseEntities } from "./entity-parser.js";
import { loadContentPrompt } from "./prompts/load-content-prompt.js";
import { processingPaths } from "./processing-paths.js";
import type { CatalogSection, ContentType, DraftEntity, EntityCategory } from "./processing-types.js";

/** Map contentType → extractor prompt name. */
const PROMPT_MAP: Record<ContentType, string> = {
  monsters: "extractor-monsters",
  spells: "extractor-spells",
  rules: "extractor-rules",
  chargen: "extractor-chargen",
  equipment: "extractor-equipment",
  tables: "extractor-tables",
  lore: "extractor-lore",
  locations: "extractor-locations",
  generic: "extractor-generic",
};

/**
 * Get the extractor system prompt for a given content type.
 */
export function getExtractorPrompt(contentType: ContentType): string {
  return loadContentPrompt(PROMPT_MAP[contentType]);
}

/**
 * Load page text for a catalog section from cache.
 */
export async function loadSectionPages(
  io: FileIO,
  homeDir: string,
  collectionSlug: string,
  jobSlug: string,
  section: CatalogSection,
): Promise<string> {
  const paths = ingestPaths(homeDir);
  const pages: string[] = [];

  for (let p = section.startPage; p <= section.endPage; p++) {
    const pagePath = paths.pageFile(collectionSlug, jobSlug, p);
    if (await io.exists(pagePath)) {
      const text = await io.readFile(pagePath);
      pages.push(`--- PAGE ${p} ---\n${text}`);
    }
  }

  return pages.join("\n\n");
}

/**
 * Build batch request items for all catalog sections.
 * One request per section, using the appropriate extractor prompt.
 */
export function buildExtractorBatchRequests(
  sections: CatalogSection[],
  sectionTexts: string[],
  collectionSlug: string,
): Anthropic.Messages.Batches.BatchCreateParams.Request[] {
  return sections.map((section, i) => ({
    custom_id: `extract-${collectionSlug}-${section.startPage}-${section.endPage}`,
    params: {
      model: getModel("small"),
      max_tokens: 8192,
      system: getExtractorPrompt(section.contentType),
      messages: [
        {
          role: "user" as const,
          content: `Extract entities from the following "${section.title}" section (pages ${section.startPage}–${section.endPage}).\n\n${sectionTexts[i]}`,
        },
      ],
    },
  }));
}

/**
 * Parse extractor batch results into DraftEntity objects.
 * Maps each result back to its source section for provenance.
 */
export function parseExtractorResults(
  results: Array<{ customId: string; text?: string; error?: string }>,
  sections: CatalogSection[],
  collectionSlug: string,
): DraftEntity[] {
  const sectionMap = new Map<string, CatalogSection>();
  for (const section of sections) {
    const key = `extract-${collectionSlug}-${section.startPage}-${section.endPage}`;
    sectionMap.set(key, section);
  }

  const allEntities: DraftEntity[] = [];

  for (const result of results) {
    if (result.error || !result.text) continue;
    const section = sectionMap.get(result.customId);
    const entities = parseEntities(result.text, section?.title);
    allEntities.push(...entities);
  }

  return allEntities;
}

/**
 * Write draft entities to disk.
 * Creates category directories and writes one .md file per entity.
 */
export async function writeDraftEntities(
  io: FileIO,
  homeDir: string,
  collectionSlug: string,
  entities: DraftEntity[],
): Promise<number> {
  const paths = processingPaths(homeDir, collectionSlug);
  const categories = new Set<EntityCategory>();
  let written = 0;

  for (const entity of entities) {
    categories.add(entity.category);
  }

  // Create category directories
  for (const cat of categories) {
    await io.mkdir(paths.draftCategoryDir(cat));
  }

  // Write entity files
  for (const entity of entities) {
    const filePath = paths.draftFile(entity.category, entity.slug);
    const content = serializeEntity(
      entity.name,
      entity.frontMatter,
      entity.body,
      [],
    );
    await io.writeFile(filePath, content);
    written++;
  }

  return written;
}
