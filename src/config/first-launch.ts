import { defaultCampaignRoot } from "../tools/filesystem/platform.js";
import { join, dirname } from "node:path";
import { existsSync, readFileSync as fsReadFileSync } from "node:fs";
import { config as dotenvConfig } from "dotenv";
import { isCompiled } from "../utils/paths.js";

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
 * Get the paths for app config files.
 */
export function getConfigPaths(appDir: string) {
  return {
    env: join(appDir, ".env"),
    appConfig: join(appDir, "config.json"),
  };
}

/**
 * Load .env from the best available location.
 * Priority: env var already set > exe directory > cwd
 * No-op if ANTHROPIC_API_KEY is already in the environment.
 */
export function loadEnv(): void {
  if (process.env.ANTHROPIC_API_KEY) return;

  // In compiled mode, check next to the executable first
  if (isCompiled()) {
    const exeEnv = join(dirname(process.execPath), ".env");
    if (existsSync(exeEnv)) {
      dotenvConfig({ path: exeEnv });
      return;
    }
  }

  // Fall back to cwd (dev mode, or compiled without exe-local .env)
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
