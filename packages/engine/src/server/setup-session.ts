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
import Anthropic from "@anthropic-ai/sdk";
import type { ServerEvent } from "@machine-violet/shared";
import { createSetupConversation } from "../agents/subagents/setup-conversation.js";
import type { SetupConversation, SetupTurnResult } from "../agents/subagents/setup-conversation.js";
import type { SetupResult } from "../agents/setup-agent.js";
// buildCampaignConfig is used internally by buildCampaignWorld
import { buildCampaignWorld } from "../agents/world-builder.js";
import { createClient } from "../config/client.js";
import { createBaseFileIO } from "./fileio.js";
import type { FileIO } from "../agents/scene-manager.js";
import { norm } from "../utils/paths.js";
import { slugify } from "../agents/world-builder.js";
import { campaignPaths } from "../tools/filesystem/scaffold.js";
import { parseFrontMatter, serializeEntity } from "../tools/filesystem/frontmatter.js";
import { promoteCharacter } from "../agents/subagents/character-promotion.js";
import { processingPaths } from "../config/processing-paths.js";
import { readBundledRuleCard } from "../config/systems.js";

export class SetupSession {
  private conversation: SetupConversation | null = null;
  private client: Anthropic;
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
    this.client = createClient();
    this.fileIO = createBaseFileIO();
  }

  /** Start the setup conversation. Streams opening narrative to clients. */
  async start(): Promise<void> {
    this.conversation = createSetupConversation(this.client);
    this.started = true;

    const result = await this.conversation.start((delta) => {
      this.broadcast({
        type: "narrative:chunk",
        data: { text: delta, kind: "dm" },
      });
    });

    await this.handleResult(result);
  }

  /** Send player input to the setup conversation. */
  async send(text: string): Promise<{ finalized?: string }> {
    if (!this.conversation) throw new Error("Setup not started");

    const result = await this.conversation.send(text, (delta) => {
      this.broadcast({
        type: "narrative:chunk",
        data: { text: delta, kind: "dm" },
      });
    });

    return this.handleResult(result);
  }

  /** Resolve a choice selection. */
  async resolveChoice(selectedText: string): Promise<{ finalized?: string }> {
    if (!this.conversation) throw new Error("Setup not started");

    const result = await this.conversation.resolveChoice(selectedText, (delta) => {
      this.broadcast({
        type: "narrative:chunk",
        data: { text: delta, kind: "dm" },
      });
    });

    return this.handleResult(result);
  }

  get isStarted(): boolean {
    return this.started;
  }

  // --- Private ---

  private async handleResult(result: SetupTurnResult): Promise<{ finalized?: string }> {
    this.broadcast({ type: "narrative:complete", data: { text: result.text } });

    // Present choices to the client
    if (result.pendingChoices) {
      this.broadcast({
        type: "modal:show",
        data: {
          type: "choice",
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
      return { finalized: campaignId };
    }

    return {};
  }

  private async finalizeCampaign(result: SetupResult): Promise<string> {
    this.broadcast({
      type: "narrative:chunk",
      data: { text: "\nBuilding your world...", kind: "system" },
    });

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

    this.broadcast({
      type: "narrative:chunk",
      data: { text: "\nYour campaign is ready.", kind: "system" },
    });

    // Return the campaign directory name as the ID
    const parts = norm(campaignRoot).split("/");
    return parts[parts.length - 1];
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
      const { updatedSheet } = await promoteCharacter(this.client, {
        characterSheet: stub,
        systemRules: ruleCard,
        context: `Build initial character sheet: ${result.characterDetails}`,
        characterName: result.characterName,
      });
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
