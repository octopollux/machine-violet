/**
* Campaign-wide validation orchestrator.
* Runs all checks and returns a consolidated report.
*/
import { validateJson, validateMap, validateClocks, } from "../filesystem/index.js";
import type { ValidationError } from "../filesystem/index.js";
import type { MapData } from "@machine-violet/shared/types/maps.js";
import type { ClocksState } from "@machine-violet/shared/types/clocks.js";
import { getCampaignKnowledge, type KnowledgeFileIO } from "../../knowledge/store.js";
import { assertSupportedCampaign } from "../filesystem/config.js";
export interface ValidationIssue {
  file: string;
  message: string;
  severity: "error" | "warning";
}
export interface ValidationResult {
  issues: ValidationIssue[];
  errorCount: number;
  warningCount: number;
  filesChecked: number;
}
/**
* Abstracted IO for validation — reads campaign files.
*/
export interface ValidationIO extends KnowledgeFileIO {
  readFile(path: string): Promise<string>;
  listDir(path: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
}
/**
* Run the full validation suite on a campaign directory.
*
* Checks: config.json format, entity files, wikilink integrity,
* map consistency, clock integrity.
*/
export async function validateCampaign(campaignRoot: string, maps: Record<string, MapData>, clocks: ClocksState, io: ValidationIO): Promise<ValidationResult> {
  const issues: ValidationIssue[] = [];
  let filesChecked = 0;
  // 1. Validate config.json
  const configPath = `${campaignRoot}/config.json`;
  if (await io.exists(configPath)) {
    const content = await io.readFile(configPath);
    const jsonErrors = validateJson(configPath, content);
    issues.push(...convertErrors(jsonErrors));
    filesChecked++;
    if (!jsonErrors.length) {
      try {
        assertSupportedCampaign(JSON.parse(content));
      }
      catch (error) {
        issues.push({ file: configPath, message: error instanceof Error ? error.message : String(error), severity: "error" });
      }
    }
  }
  else {
    issues.push({ file: configPath, message: "Missing config.json", severity: "error" });
  }
  if (issues.some(issue => issue.severity === "error"))
    return { issues, errorCount: issues.filter(i => i.severity === "error").length, warningCount: 0, filesChecked };
  // Integrity is enforced by SQLite constraints; inspect all collections through the store.
  const store = await getCampaignKnowledge(campaignRoot, io);
  const outline = await store.outline();
  filesChecked += outline.length;
  const charFileNames = new Set<string>();
  for (const node of outline)
    if (node.kind === "entity") {
      const record = await store.read(node.uid, { textLimit: 0, logLimit: 0 });
      charFileNames.add(node.uid.toLowerCase());
      charFileNames.add(node.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
      for (const alias of record.aliases)
        charFileNames.add(alias.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
    }
  for (const [mapId, mapData] of Object.entries(maps)) {
    const mapErrors = validateMap(`map:${mapId}`, mapData, charFileNames);
    issues.push(...convertErrors(mapErrors));
  }
  // 5. Clock integrity
  const clockErrors = validateClocks(clocks);
  issues.push(...convertErrors(clockErrors));
  const errorCount = issues.filter((i) => i.severity === "error").length;
  const warningCount = issues.filter((i) => i.severity === "warning").length;
  return { issues, errorCount, warningCount, filesChecked };
}
function convertErrors(errors: ValidationError[]): ValidationIssue[] {
  return errors.map((e) => ({
    file: e.file,
    message: e.message,
    severity: e.severity,
  }));
}
