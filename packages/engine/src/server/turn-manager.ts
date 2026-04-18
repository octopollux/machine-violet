/**
 * Turn manager — manages the collaborative turn lifecycle.
 *
 * Turns are first-class entities: opened by the server after DM narration,
 * contributed to by players (visible in real-time), and committed to
 * trigger the next DM response.
 *
 * Commit policies:
 * - "auto": single active player, auto-commit after first contribution
 * - "all": multiple active players, commit when all have contributed
 *
 * AI players run sequentially after all human players have contributed.
 */
import { randomUUID } from "node:crypto";
import type {
  Turn, TurnContribution, ServerEvent,
} from "@machine-violet/shared";

export class TurnManager {
  private currentTurn: Turn | null = null;
  private broadcast: (event: ServerEvent) => void;
  private onCommit: ((contributions: TurnContribution[]) => Promise<void>) | null = null;
  private commitPending = false;
  private seq = 0;
  private campaignId: string;

  constructor(broadcast: (event: ServerEvent) => void, campaignId: string) {
    this.broadcast = broadcast;
    this.campaignId = campaignId;
  }

  /** Set the callback invoked when a turn is committed. */
  setCommitHandler(handler: (contributions: TurnContribution[]) => Promise<void>): void {
    this.onCommit = handler;
  }

  /** Open a new turn for the given players. */
  openTurn(activePlayers: string[], aiPlayers: string[] = []): Turn {
    if (this.currentTurn && this.currentTurn.status === "open") {
      throw new Error("Cannot open a new turn while one is already open.");
    }

    this.seq++;
    const turn: Turn = {
      id: randomUUID(),
      seq: this.seq,
      campaignId: this.campaignId,
      status: "open",
      activePlayers,
      aiPlayers,
      contributions: [],
      commitPolicy: activePlayers.length <= 1 ? "auto" : "all",
    };

    this.currentTurn = turn;
    this.broadcast({ type: "turn:opened", data: turn });
    return turn;
  }

  /** Cancel the current open turn (e.g., when a choice modal supersedes it). */
  cancelTurn(): void {
    if (this.currentTurn && this.currentTurn.status === "open") {
      this.currentTurn = null;
    }
  }

  /** Add a contribution to the current turn. Returns the contribution. */
  contribute(
    playerId: string,
    text: string,
    source: "client" | "engine" = "client",
    options: { fromChoice?: boolean } = {},
  ): TurnContribution {
    const turn = this.currentTurn;
    if (!turn || turn.status !== "open") {
      throw new Error("No open turn to contribute to.");
    }

    // Check if this player is allowed to contribute
    if (source === "client" && !turn.activePlayers.includes(playerId)) {
      throw new Error(`Player "${playerId}" is not an active player in this turn.`);
    }

    // Check for amendment (replaces previous contribution from same player)
    const existing = turn.contributions.findIndex((c) => c.playerId === playerId);
    const amendment = existing !== -1;
    if (amendment) {
      turn.contributions.splice(existing, 1);
    }

    const contribution: TurnContribution = {
      id: randomUUID(),
      playerId,
      source,
      text,
      amendment,
      ...(options.fromChoice ? { fromChoice: true } : {}),
    };

    turn.contributions.push(contribution);

    // Broadcast to all clients in real-time
    this.broadcast({
      type: "turn:updated",
      data: { turnId: turn.id, contribution },
    });

    // Auto-commit check
    if (this.shouldAutoCommit(turn) && !this.commitPending) {
      this.commitPending = true;
      // Use setImmediate to avoid blocking the HTTP response
      setImmediate(() => {
        this.commit().catch((err) => {
          this.broadcast({
            type: "error",
            data: {
              message: err instanceof Error ? err.message : String(err),
              recoverable: true,
            },
          });
        }).finally(() => {
          this.commitPending = false;
        });
      });
    }

    return contribution;
  }

  /** Explicitly commit the current turn. */
  async commit(): Promise<void> {
    const turn = this.currentTurn;
    if (!turn || turn.status !== "open") {
      throw new Error("No open turn to commit.");
    }

    turn.status = "committed";
    this.broadcast({ type: "turn:committed", data: { turnId: turn.id } });

    // Run AI players sequentially
    for (const aiPlayerId of turn.aiPlayers) {
      // TODO: Phase 2a — run AI player subagent
      // const result = await aiPlayerTurn(client, gameState, aiPlayerId);
      // this.contribute(aiPlayerId, result, "engine");
      void aiPlayerId; // placeholder
    }

    // Process the assembled contributions
    turn.status = "processing";
    if (this.onCommit) {
      await this.onCommit(turn.contributions);
    }

    turn.status = "resolved";
    this.broadcast({ type: "turn:resolved", data: { turnId: turn.id } });
  }

  /** Get the current turn (if any). */
  getCurrentTurn(): Turn | null {
    return this.currentTurn;
  }

  // --- Private ---

  private shouldAutoCommit(turn: Turn): boolean {
    if (turn.commitPolicy !== "auto") {
      // "all" policy: check if all active players have contributed
      const contributed = new Set(turn.contributions.map((c) => c.playerId));
      return turn.activePlayers.every((p) => contributed.has(p));
    }
    // "auto" policy: commit after first human contribution
    return turn.contributions.some((c) => c.source === "client");
  }
}
