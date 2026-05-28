/**
 * Setup pseudo-campaign session.
 *
 * Wraps the SetupConversation subagent to present campaign creation
 * as a normal gameplay session. The client sees narrative streaming
 * and choice modals via the same WS events as regular play.
 *
 * When the setup agent calls finalize_setup, the server scaffolds
 * the campaign directory and optionally builds the initial character sheet.
 */
import type { ServerEvent } from "@machine-violet/shared";
import { createSetupConversation } from "../agents/subagents/setup-conversation.js";
import type { SetupConversation, SetupTurnResult, KnownPlayer } from "../agents/subagents/setup-conversation.js";
import type { SetupResult } from "../agents/setup-agent.js";
// buildCampaignConfig is used internally by buildCampaignWorld
import { buildCampaignWorld } from "../agents/world-builder.js";
import { createBaseFileIO } from "./fileio.js";
import type { FileIO } from "../agents/scene-manager.js";
import { norm, configDir } from "../utils/paths.js";
import { slugify } from "../agents/world-builder.js";
import { campaignPaths, machinePaths } from "../tools/filesystem/scaffold.js";
import { parseFrontMatter, serializeEntity } from "../tools/filesystem/frontmatter.js";
import { promoteCharacter } from "../agents/subagents/character-promotion.js";
import { processingPaths } from "../config/processing-paths.js";
import { readBundledRuleCard } from "../config/systems.js";
import { loadConnectionStore, buildEffectiveConnections } from "../config/connections.js";
import { buildTierProvidersWithCache } from "../config/tier-resolver.js";
import { createAnthropicProvider } from "../providers/index.js";
import type { LLMProvider, TierProvider } from "../providers/types.js";
import type { ModelTier } from "../config/models.js";
import type { CampaignConfig } from "@machine-violet/shared/types/config.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CampaignRepo } from "../tools/git/campaign-repo.js";
import { createGitIO } from "../tools/git/isogit-adapter.js";
import { logEvent } from "../context/engine-log.js";

export class SetupSession {
  private conversation: SetupConversation | null = null;
  private provider: LLMProvider;
  private model: string;
  /**
   * Per-tier resolved {provider, model} pairs. Setup runs on `large` for the
   * main conversation, but subagents invoked during setup (e.g.
   * `promoteCharacter` on the small tier) need to route through the
   * connection assigned to their tier — otherwise a heterogeneous setup
   * (Large=OpenAI, Small=Anthropic) sends an Anthropic model ID to OpenAI.
   */
  private tierProviders: Record<ModelTier, TierProvider>;
  /**
   * Distinct provider instances backing the tier map, keyed by connection
   * id. SessionManager calls `dispose()` on each one when the setup session
   * is dropped — without this, an openai-chatgpt setup tier would leak its
   * codex subprocess every time setup is started or torn down.
   */
  private providersByConnectionId: Map<string, LLMProvider>;
  private broadcast: (event: ServerEvent) => void;
  private campaignsDir: string;
  private homeDir: string;
  private fileIO: FileIO;
  private started = false;

  constructor(
    campaignsDir: string,
    homeDir: string,
    broadcast: (event: ServerEvent) => void,
  ) {
    this.campaignsDir = campaignsDir;
    this.homeDir = homeDir;
    this.broadcast = broadcast;
    this.fileIO = createBaseFileIO();

    // Setup runs on the large tier — the conversation is short and
    // cache-friendly (stable system prompt with BP1 1h caching), so the
    // incremental cost over medium is small and the quality of the handoff
    // note + world framing benefits meaningfully.
    const appConfigDir = configDir();
    const connStore = buildEffectiveConnections(loadConnectionStore(appConfigDir), appConfigDir);
    // configDir must be forwarded so openai-chatgpt connections get a
    // token store backed by connections.json — without it the codex
    // subprocess never sees the persisted ChatGPT tokens and the very
    // first setup turn throws "no active ChatGPT login" before any
    // model call. Game sessions (session-manager) already pass this;
    // setup was missing it, breaking any campaign whose large tier
    // resolves to an openai-chatgpt connection.
    const resolution = buildTierProvidersWithCache(connStore, () => createAnthropicProvider(), appConfigDir);
    this.tierProviders = resolution.tiers;
    this.providersByConnectionId = resolution.byConnectionId;
    this.provider = this.tierProviders.large.provider;
    this.model = this.tierProviders.large.model;
  }

  /**
   * Tear down per-tier providers. Called by SessionManager whenever the
   * SetupSession is dropped — on successful handoff, on error, and on
   * session end. Each provider's `dispose()` is idempotent and
   * best-effort; failures are logged but never block teardown. The Map
   * already dedupes providers shared across tiers, so a connection-backed
   * codex subprocess is disposed exactly once even if two tiers point at
   * it.
   */
  async dispose(): Promise<void> {
    const providers = Array.from(this.providersByConnectionId.values());
    this.providersByConnectionId.clear();
    await Promise.all(providers.map(async (p) => {
      if (!p.dispose) return;
      try {
        await p.dispose();
      } catch (err) {
        logEvent("provider:dispose_error", {
          providerId: p.providerId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }));
  }

  /** Scan machine-scope players directory for returning player recognition. */
  private async scanKnownPlayers(): Promise<KnownPlayer[]> {
    const playersDir = machinePaths(this.homeDir).playersDir;
    try {
      const entries = await this.fileIO.listDir(playersDir);
      const players: KnownPlayer[] = [];
      for (const entry of entries) {
        if (!entry.endsWith(".md")) continue;
        try {
          const content = await this.fileIO.readFile(norm(playersDir + "/" + entry));
          const { frontMatter } = parseFrontMatter(content);
          const name = (frontMatter._title as string) || entry.replace(/\.md$/, "");
          players.push({
            name,
            ageGroup: frontMatter.age_group as string | undefined,
          });
        } catch { /* skip unreadable files */ }
      }
      return players;
    } catch {
      return []; // Directory doesn't exist yet
    }
  }

  private emitThinking(): void {
    this.broadcast({ type: "activity:update", data: { engineState: "dm_thinking" } });
  }

  private emitIdle(): void {
    this.broadcast({ type: "activity:update", data: { engineState: "waiting_input" } });
  }

  /** Start the setup conversation. Streams opening narrative to clients. */
  async start(): Promise<void> {
    const knownPlayers = await this.scanKnownPlayers();
    const paths = machinePaths(this.homeDir);
    // The __setup__ scratch campaign is materialized by SessionManager
    // before startSetup() is called. createSetupConversation uses it as
    // the on-disk root for portrait drafts (__setup__/campaign/images/)
    // and the confirmed portrait (__setup__/characters/<slug>-portrait.png),
    // which world-builder picks up at finalize and ports into the new
    // campaign.
    const setupRoot = join(this.campaignsDir, "__setup__");
    this.conversation = createSetupConversation(this.provider, this.model, knownPlayers, (status, delayMs) => {
      this.broadcast({
        type: "error",
        data: {
          message: `API retry (status ${status})`,
          recoverable: true,
          status,
          delayMs,
          category: "retryable",
        },
      });
    }, paths.worldsDir, paths.personalitiesDir, this.fileIO, setupRoot);
    this.started = true;

    this.emitThinking();
    try {
      const result = await this.conversation.start((delta) => {
        this.broadcast({
          type: "narrative:chunk",
          data: { text: delta, kind: "dm" },
        });
      });

      await this.handleResult(result);
    } finally {
      this.emitIdle();
    }
  }

  /** Send player input to the setup conversation. */
  async send(text: string): Promise<{ finalized?: string; campaignName?: string }> {
    if (!this.conversation) throw new Error("Setup not started");

    this.emitThinking();
    try {
      const result = await this.conversation.send(text, (delta) => {
        this.broadcast({
          type: "narrative:chunk",
          data: { text: delta, kind: "dm" },
        });
      });

      return await this.handleResult(result);
    } finally {
      this.emitIdle();
    }
  }

  /** Resolve a choice selection. */
  async resolveChoice(selectedText: string): Promise<{ finalized?: string; campaignName?: string }> {
    if (!this.conversation) throw new Error("Setup not started");

    this.emitThinking();
    try {
      const result = await this.conversation.resolveChoice(selectedText, (delta) => {
        this.broadcast({
          type: "narrative:chunk",
          data: { text: delta, kind: "dm" },
        });
      });

      return await this.handleResult(result);
    } finally {
      this.emitIdle();
    }
  }

  get isStarted(): boolean {
    return this.started;
  }

  /** True while the setup agent is awaiting a present_choices tool_result. */
  get hasPendingChoice(): boolean {
    return this.conversation?.hasPendingChoice ?? false;
  }

  // --- Private ---

  private async handleResult(result: SetupTurnResult): Promise<{ finalized?: string; campaignName?: string }> {
    this.broadcast({ type: "narrative:complete", data: { text: result.text } });

    // Portrait drafts: broadcast a display_image TUI command for each so
    // the client renders the draft inline. Same wire shape as the DM
    // playing-phase emits — the existing event-handler in client-ink
    // handles it identically.
    if (result.imageDisplays) {
      for (const display of result.imageDisplays) {
        // Same wire shape as bridge.ts uses for the DM-emitted display_image
        // TuiCommand. Spreading a typed object literal sidesteps excess-property
        // checks against ActivityUpdateEvent's strict data shape — the client's
        // event-handler reads filename/intent off the resulting payload either
        // way. Matching bridge.ts is what keeps both paths rendering identically.
        const cmd = {
          type: "display_image" as const,
          filename: display.filename,
          intent: display.intent,
        };
        this.broadcast({
          type: "activity:update",
          data: { engineState: `tui:${cmd.type}`, ...cmd },
        });
      }
    }

    // Present choices to the client
    if (result.pendingChoices) {
      this.broadcast({
        type: "choices:presented",
        data: {
          id: "setup-choice",
          prompt: result.pendingChoices.prompt,
          choices: result.pendingChoices.choices,
          descriptions: result.pendingChoices.descriptions,
        },
      });
    }

    // Campaign finalized — scaffold and return campaign ID
    if (result.finalized) {
      const campaignId = await this.finalizeCampaign(result.finalized);
      return { finalized: campaignId, campaignName: result.finalized.campaignName };
    }

    return {};
  }

  private async finalizeCampaign(result: SetupResult): Promise<string> {
    // Scaffold campaign directory
    const campaignRoot = await buildCampaignWorld(
      this.campaignsDir,
      result,
      this.fileIO,
      this.homeDir,
    );

    // Build initial character sheet (optional — needs system + characterDetails)
    if (result.system && result.characterDetails) {
      await this.buildInitialSheet(campaignRoot, result);
    }

    // Handoff commit — the campaign directory becomes a git repo and all
    // scaffolded files (config.json, character sheet, party.md, etc.) land
    // in a single commit BEFORE the DM's first turn runs. If the first turn
    // crashes mid-flight, reloading from disk restores this exact state and
    // the DM is re-primed with the same handoff note. Without this commit,
    // a crash would leave us with scaffolded-but-unsnapshot files and a lazy
    // "auto: initial state" commit baked into the first-turn critical path.
    await this.commitHandoff(campaignRoot);

    // Return the campaign directory name as the ID
    const parts = norm(campaignRoot).split("/");
    return parts[parts.length - 1];
  }

  /**
   * Initialize git + write the handoff commit for a freshly scaffolded campaign.
   *
   * Reads the just-written config.json to honour `recovery.enable_git` — if the
   * player opted out of git, this is a no-op. Failures here are logged but never
   * throw: git is recovery infrastructure, not a hard dependency of setup.
   */
  private async commitHandoff(campaignRoot: string): Promise<void> {
    let config: CampaignConfig;
    try {
      const raw = await readFile(join(campaignRoot, "config.json"), "utf-8");
      config = JSON.parse(raw) as CampaignConfig;
    } catch (err) {
      logEvent("setup:handoff_commit_error", {
        phase: "read_config",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (!config.recovery?.enable_git) return;

    try {
      const repo = new CampaignRepo({
        dir: campaignRoot,
        git: createGitIO(),
        enabled: true,
        autoCommitInterval: config.recovery.auto_commit_interval,
        maxCommits: config.recovery.max_commits,
      });
      await repo.init("handoff: campaign scaffolded from setup");
    } catch (err) {
      logEvent("setup:handoff_commit_error", {
        phase: "commit",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async buildInitialSheet(campaignRoot: string, result: SetupResult): Promise<void> {
    const charSlug = slugify(result.characterName);
    const charPath = norm(campaignPaths(campaignRoot).character(charSlug));

    let stub: string;
    try {
      stub = await this.fileIO.readFile(charPath);
    } catch {
      return;
    }

    // Load rule card
    let ruleCard: string | null = null;
    if (result.system) {
      const sysPaths = processingPaths(this.homeDir, result.system);
      try {
        ruleCard = await this.fileIO.readFile(norm(sysPaths.ruleCard));
      } catch {
        ruleCard = readBundledRuleCard(result.system);
      }
    }

    if (!ruleCard) return;

    try {
      const small = this.tierProviders.small;
      const { updatedSheet } = await promoteCharacter(small.provider, {
        characterSheet: stub,
        systemRules: ruleCard,
        context: `Build initial character sheet: ${result.characterDetails}`,
        characterName: result.characterName,
      }, undefined, small.model);
      if (updatedSheet) {
        const { frontMatter, body, changelog } = parseFrontMatter(updatedSheet);
        frontMatter.sheet_status = "complete";
        const title = String(frontMatter._title ?? result.characterName);
        const tagged = serializeEntity(title, frontMatter, body, changelog);
        await this.fileIO.writeFile(charPath, tagged);
      }
    } catch {
      // Best-effort — stub is still valid
    }
  }
}
