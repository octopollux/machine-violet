import { defaultCampaignRoot } from "../tools/filesystem/platform.js";
import { join, dirname } from "node:path";
import { existsSync, mkdirSync, copyFileSync, chmodSync, readFileSync as fsReadFileSync } from "node:fs";
import { config as dotenvConfig } from "dotenv";
import { isCompiled, configDir } from "../utils/paths.js";

/**
 * App-level config stored alongside .env.
 */
export interface AppSettings {
  homeDir: string;
  apiKeyConfigured: boolean;
}

/**
 * Check if the app has been configured (API key + home dir).
 */
export function isConfigured(envPath: string, readFileSync: (path: string) => string): boolean {
  try {
    const content = readFileSync(envPath);
    return content.includes("ANTHROPIC_API_KEY=") && content.trim().length > "ANTHROPIC_API_KEY=".length;
  } catch {
    return false;
  }
}

/**
 * Get the platform default home directory for Machine Violet.
 */
export function getDefaultHomeDir(): string {
  return defaultCampaignRoot(process.platform);
}

/**
 * Build the .env file content with the API key.
 */
export function buildEnvContent(apiKey: string): string {
  return `ANTHROPIC_API_KEY=${apiKey}\n`;
}

/**
 * Build the app-level config.json content.
 */
export function buildAppConfig(homeDir: string): string {
  const config = {
    home_dir: homeDir,
    campaigns_dir: join(homeDir, "campaigns"),
    rules_cache_dir: join(homeDir, "rules-cache"),
  };
  return JSON.stringify(config, null, 2) + "\n";
}

/**
 * Validate an API key format (starts with sk-ant-).
 */
export function validateApiKeyFormat(key: string): boolean {
  return /^sk-ant-[a-zA-Z0-9_-]{20,}$/.test(key.trim());
}

/**
 * Get the paths for app config files (in the platform config directory).
 */
export function getConfigPaths(dir?: string) {
  const d = dir ?? configDir();
  return {
    env: join(d, ".env"),
    appConfig: join(d, "config.json"),
  };
}

/**
 * Migrate config files from the old exe-local location to the config dir.
 * Copies files that exist next to the exe but not yet in the config dir.
 * Only runs in compiled mode.
 */
const CONFIG_FILES = [".env", "config.json", "api-keys.json"] as const;

const SECRET_FILES = new Set([".env", "api-keys.json"]);

export function migrateConfigFromExeDir(): void {
  if (!isCompiled()) return;

  const cfgDir = configDir();
  const exeDir = dirname(process.execPath);
  if (cfgDir === exeDir) return;

  try {
    mkdirSync(cfgDir, { recursive: true, mode: 0o700 });

    for (const file of CONFIG_FILES) {
      const src = join(exeDir, file);
      const dest = join(cfgDir, file);
      if (existsSync(src) && !existsSync(dest)) {
        copyFileSync(src, dest);
        if (SECRET_FILES.has(file) && process.platform !== "win32") {
          chmodSync(dest, 0o600);
        }
      }
    }
  } catch {
    // Best-effort migration — if it fails the legacy exe-local
    // fallback in loadEnv() will still find the files.
  }
}

/**
 * Load .env from the best available location.
 * Priority: env var already set > config dir > exe directory (legacy) > cwd
 * No-op if ANTHROPIC_API_KEY is already in the environment.
 */
export function loadEnv(): void {
  if (process.env.ANTHROPIC_API_KEY) return;

  // In compiled mode, use the platform config directory
  if (isCompiled()) {
    // Migrate any config files left next to the exe from a prior version
    migrateConfigFromExeDir();

    const cfgEnv = join(configDir(), ".env");
    if (existsSync(cfgEnv)) {
      dotenvConfig({ path: cfgEnv });
      return;
    }

    // Legacy fallback: check next to the executable
    const exeEnv = join(dirname(process.execPath), ".env");
    if (existsSync(exeEnv)) {
      dotenvConfig({ path: exeEnv });
      return;
    }
  }

  // Fall back to cwd (dev mode, or compiled without config-dir .env)
  dotenvConfig();
}

/**
 * Get the app version. Uses MV_VERSION define (set at build time),
 * falling back to package.json.
 */
export function getAppVersion(): string {
  // Build script injects this via --define
  if (typeof process.env.MV_VERSION === "string" && process.env.MV_VERSION) {
    return process.env.MV_VERSION;
  }

  // Dev fallback: read package.json
  try {
    const pkgPath = join(dirname(dirname(import.meta.dirname)), "package.json");
    const pkg = JSON.parse(fsReadFileSync(pkgPath, "utf-8"));
    return pkg.version ?? "dev";
  } catch {
    return "dev";
  }
}
