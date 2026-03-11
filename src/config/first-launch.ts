import { defaultCampaignRoot } from "../tools/filesystem/platform.js";
import { join } from "node:path";

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
