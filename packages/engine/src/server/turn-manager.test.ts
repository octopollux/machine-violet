import { describe, it, expect, vi, beforeEach } from "vitest";
import { TurnManager } from "./turn-manager.js";
import type { ServerEvent } from "@machine-violet/shared";

describe("TurnManager", () => {
  let events: ServerEvent[];
  let tm: TurnManager;

  beforeEach(() => {
    events = [];
    tm = new TurnManager((event) => events.push(event));
  });

  describe("openTurn", () => {
    it("opens a turn and broadcasts turn:opened", () => {
      const turn = tm.openTurn(["aldric"]);
      expect(turn.status).toBe("open");
      expect(turn.activePlayers).toEqual(["aldric"]);
      expect(turn.commitPolicy).toBe("auto");
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("turn:opened");
    });

    it("sets 'all' commit policy for multiple players", () => {
      const turn = tm.openTurn(["aldric", "sable"]);
      expect(turn.commitPolicy).toBe("all");
    });

    it("rejects opening a turn when one is already open", () => {
      tm.openTurn(["aldric"]);
      expect(() => tm.openTurn(["sable"])).toThrow("already open");
    });
  });

  describe("contribute", () => {
    it("adds a contribution and broadcasts turn:updated", () => {
      tm.openTurn(["aldric"]);
      const contribution = tm.contribute("aldric", "I attack the goblin");

      expect(contribution.playerId).toBe("aldric");
      expect(contribution.text).toBe("I attack the goblin");
      expect(contribution.source).toBe("client");
      expect(contribution.amendment).toBe(false);

      // turn:opened + turn:updated
      expect(events).toHaveLength(2);
      expect(events[1].type).toBe("turn:updated");
    });

    it("rejects contributions from non-active players", () => {
      tm.openTurn(["aldric"]);
      expect(() => tm.contribute("sable", "I help")).toThrow("not an active player");
    });

    it("marks amendments correctly", () => {
      tm.openTurn(["aldric", "sable"]);
      tm.contribute("aldric", "I attack");
      const amended = tm.contribute("aldric", "Actually, I defend");

      expect(amended.amendment).toBe(true);
      const turn = tm.getCurrentTurn()!;
      expect(turn.contributions).toHaveLength(1);
      expect(turn.contributions[0].text).toBe("Actually, I defend");
    });
  });

  describe("commit policies", () => {
    it("auto-commits for single player", async () => {
      tm.openTurn(["aldric"]);
      tm.setCommitHandler(vi.fn());
      tm.contribute("aldric", "I look around");

      // Auto-commit happens via setImmediate, so wait a tick
      await new Promise((r) => setTimeout(r, 10));
      const turn = tm.getCurrentTurn()!;
      expect(turn.status).toBe("resolved");
    });

    it("waits for all players in 'all' policy", () => {
      tm.openTurn(["aldric", "sable"]);
      tm.contribute("aldric", "I attack");

      const turn = tm.getCurrentTurn()!;
      // Should still be open — sable hasn't contributed
      expect(turn.status).toBe("open");
    });

    it("auto-commits when all players contribute in 'all' policy", async () => {
      tm.openTurn(["aldric", "sable"]);
      tm.setCommitHandler(vi.fn());
      tm.contribute("aldric", "I attack");
      tm.contribute("sable", "I heal");

      await new Promise((r) => setTimeout(r, 10));
      const turn = tm.getCurrentTurn()!;
      expect(turn.status).toBe("resolved");
    });
  });

  describe("commit handler", () => {
    it("calls the commit handler with contributions", async () => {
      const handler = vi.fn();
      tm.openTurn(["aldric"]);
      tm.setCommitHandler(handler);
      tm.contribute("aldric", "I search the room");

      await new Promise((r) => setTimeout(r, 10));
      expect(handler).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ playerId: "aldric", text: "I search the room" }),
        ]),
      );
    });
  });

  describe("explicit commit", () => {
    it("commits manually", async () => {
      tm.openTurn(["aldric", "sable"]);
      tm.setCommitHandler(vi.fn());
      tm.contribute("aldric", "Let's go");

      await tm.commit();
      const turn = tm.getCurrentTurn()!;
      expect(turn.status).toBe("resolved");
    });
  });
});
