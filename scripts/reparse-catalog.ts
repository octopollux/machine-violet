/**
 * Re-parse the classifier batch results with the improved merger.
 * Avoids re-running the classifier batch.
 */
import "dotenv/config";
import { createClient } from "../packages/engine/src/config/client.js";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { collectBatchResults } from "../packages/engine/src/content/batch-client.js";
import { parseClassifierResults, mergeSections, buildCatalog } from "../packages/engine/src/content/classifier.js";
import { loadModelConfig } from "../packages/engine/src/config/models.js";

async function main() {
  loadModelConfig({ reset: true });
  const client = createClient();
  const batchId = "msgbatch_01EJbc9Cp3nGpjk62rWrcscr";

  console.log("Collecting batch results...");
  const results = await collectBatchResults(client, batchId);
  console.log(`Got ${results.length} results`);

  const rawSections = parseClassifierResults(results);
  console.log(`Parsed ${rawSections.length} raw sections`);

  const merged = mergeSections(rawSections);
  console.log(`After merge: ${merged.length} sections`);

  // Show the merged sections
  for (const s of merged) {
    console.log(`  [${s.contentType}] ${s.title} (pp. ${s.startPage}-${s.endPage})`);
  }

  // Write catalog
  const catalog = buildCatalog("dnd-5e", rawSections, 320);
  const outPath = resolve(
    process.env.USERPROFILE ?? process.env.HOME ?? "~",
    "Documents", ".machine-violet", "systems", "dnd-5e", "catalog.json",
  );
  writeFileSync(outPath, JSON.stringify(catalog, null, 2));
  console.log(`\nWrote catalog to: ${outPath}`);
  console.log(`Sections in catalog: ${catalog.sections.length}`);
}

main().catch(console.error);
