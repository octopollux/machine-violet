import Fastify from "fastify";
import { describe, it, expect } from "vitest";
import { SqliteKnowledgeStore } from "../../knowledge/sqlite-store.js";
import { dataRoutes } from "./data.js";

describe("approved public knowledge endpoints", () => {
  it("reads UID/name approved content without private bodies, fields or dependency reasons", async () => {
    const store = new SqliteKnowledgeStore(":memory:");
    const server = Fastify();
    try {
      await store.mutate([{ op: "create_collection", name: "Rituals" }]);
      const rituals = (await store.resolve("Rituals"))!;
      await store.mutate([{ op: "upsert", collection: rituals, name: "Hidden Flame", body: "SECRET_BODY", fields: { plot: "SECRET_FIELD" }, aliases: ["SECRET_ALIAS"] }]);
      const hidden = (await store.resolve("Rituals/Hidden Flame"))!;
      await store.mutate([{ op: "create_collection", name: "Player Knowledge" }]);
      const publicCollection = (await store.resolve("Player Knowledge"))!;
      await store.mutate([{ op: "upsert", collection: publicCollection, name: "Approved", visibility: "player-facing", fields: { subject: { $ref: hidden }, display_name: "Blue Flame", summary: "A known ritual.", public_aliases: ["Old Flame"], firstScene: 1, lastScene: 2 } }]);
      await store.mutate([{ op: "upsert", collection: rituals, name: "Other Secret", body: "OTHER_SECRET" }]);
      const other = (await store.resolve("Rituals/Other Secret"))!;
      const fileIO = { campaignKnowledge: async () => store };
      server.decorate("sessionManager", { isActive: true, getGameState: () => ({ campaignRoot: "/fixture" }), getEngine: () => ({ getSceneManager: () => ({ getFileIO: () => fileIO }) }) });
      await server.register(dataRoutes, { prefix: "/session" });
      const compendium = await server.inject("/session/compendium");
      expect(compendium.statusCode).toBe(200);
      expect(compendium.body).toContain("A known ritual.");
      for (const secret of ["SECRET_BODY", "SECRET_FIELD", "SECRET_ALIAS", "OTHER_SECRET"]) expect(compendium.body).not.toContain(secret);
      const record = await server.inject(`/session/knowledge/${hidden}`);
      expect(record.json()).toMatchObject({ uid: hidden, name: "Blue Flame", content: "# Blue Flame\n\nA known ritual." });
      expect((await server.inject(`/session/knowledge/${other}`)).statusCode).toBe(404);
      expect((await server.inject("/session/character/SECRET_ALIAS")).statusCode).toBe(404);
      expect((await server.inject("/session/character/Old%20Flame")).json().uid).toBe(hidden);
      expect((await server.inject("/session/knowledge/knowledge.sqlite")).statusCode).toBe(404);
    } finally { await server.close(); await store.close(); }
  });
});
