import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: [
      // Monolith vestiges — these test modules that have engine-only imports
      // (campaignPaths, campaign-archive, updater, content pipeline).
      // They'll be fixed or removed during Phase 5 cleanup.
      "src/commands/slash-commands.test.ts",
      "src/tui/hooks/useGameCallbacks.test.ts",
      "src/phases/AddContentPhase.test.tsx",
      "src/phases/ArchivedCampaignsPhase.test.tsx",
      "src/phases/UpdatePhase.test.tsx",
      "src/tui/modals/DeleteCampaignModal.test.tsx",
    ],
  },
});
