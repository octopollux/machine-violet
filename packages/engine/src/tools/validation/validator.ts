/**
 * Campaign-wide validation orchestrator.
 * Runs all checks and returns a consolidated report.
 */
import {
  validateWikilinks,
  validateEntityFile,
  validateJson,
  validateMap,
  validateClocks,
} from "../filesystem/index.js";
import type { ValidationError } from "../filesystem/index.js";
import type { MapData } from "@machine-violet/shared/types/maps.js";
import type { ClocksState } from "@machine-violet/shared/types/clocks.js";

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
export interface ValidationIO {
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
export async function validateCampaign(
  campaignRoot: string,
  maps: Record<string, MapData>,
  clocks: ClocksState,
  io: ValidationIO,
): Promise<ValidationResult> {
  const issues: ValidationIssue[] = [];
  let filesChecked = 0;

  // 1. Validate config.json
  const configPath = `${campaignRoot}/config.json`;
  if (await io.exists(configPath)) {
    const content = await io.readFile(configPath);
    const jsonErrors = validateJson(configPath, content);
    issues.push(...convertErrors(jsonErrors));
    filesChecked++;
  } else {
    issues.push({ file: configPath, message: "Missing config.json", severity: "error" });
  }

  // 2. Gather all entity files and validate format
  const entityFiles: { path: string; content: string }[] = [];
  const entityDirs = ["characters", "locations", "factions", "lore"];

  for (const dir of entityDirs) {
    const dirPath = `${campaignRoot}/${dir}`;
    if (!(await io.exists(dirPath))) continue;

    const entries = await io.listDir(dirPath);
    for (const entry of entries) {
      let filePath: string;
      if (entry.endsWith(".md")) {
        filePath = `${dirPath}/${entry}`;
      } else {
        // Could be a subdirectory (locations use slug/index.md)
        const indexPath = `${dirPath}/${entry}/index.md`;
        if (await io.exists(indexPath)) {
          filePath = indexPath;
        } else {
          continue;
        }
      }
      const content = await io.readFile(filePath);
      entityFiles.push({ path: filePath, content });
      const entityErrors = validateEntityFile(filePath, content);
      issues.push(...convertErrors(entityErrors));
      filesChecked++;
    }
  }

  // 3. Wikilink integrity
  const existingPaths = new Set<string>();
  for (const ef of entityFiles) {
    existingPaths.add(ef.path);
  }
  // Also add common paths that might be linked
  existingPaths.add(`${campaignRoot}/log.json`);
  existingPaths.add(`${campaignRoot}/log.md`); // legacy
  existingPaths.add(`${campaignRoot}/config.json`);

  const wikiErrors = validateWikilinks(entityFiles, existingPaths);
  issues.push(...convertErrors(wikiErrors));

  // 4. Map consistency
  const charFileNames = new Set<string>();
  const charsDir = `${campaignRoot}/characters`;
  if (await io.exists(charsDir)) {
    const charFiles = await io.listDir(charsDir);
    for (const f of charFiles) {
      charFileNames.add(f.replace(/\.md$/, "").toLowerCase());
    }
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
