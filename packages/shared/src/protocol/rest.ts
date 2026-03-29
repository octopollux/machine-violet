/**
 * REST API request/response schemas.
 *
 * TypeBox schemas used by both the Fastify server (validation + serialization)
 * and the client (typed fetch wrappers).
 */
import { Type, type Static } from "@sinclair/typebox";

// --- Campaigns ---

export const CampaignSummary = Type.Object({
  id: Type.String(),
  name: Type.String(),
  path: Type.Optional(Type.String()),
  system: Type.Optional(Type.String()),
  genre: Type.Optional(Type.String()),
  createdAt: Type.Optional(Type.String()),
  lastPlayed: Type.Optional(Type.String()),
});

export const ListCampaignsResponse = Type.Object({
  campaigns: Type.Array(CampaignSummary),
});

export const StartCampaignResponse = Type.Object({
  sessionId: Type.String(),
  wsUrl: Type.String(),
});

// --- Session ---

export const ContributeRequest = Type.Object({
  text: Type.String(),
  type: Type.Optional(Type.Union([
    Type.Literal("action"),
    Type.Literal("dialogue"),
    Type.Literal("ooc"),
  ])),
});

export const CommitResponse = Type.Object({
  turnId: Type.String(),
});

export const CommandRequest = Type.Object({
  args: Type.Optional(Type.String()),
});

export const ModalResponse = Type.Object({
  /** For choice modals: the selected option index. For others: acknowledgment. */
  value: Type.Union([Type.String(), Type.Number()]),
});

export const SettingsPatch = Type.Object({}, { additionalProperties: true });

export const SessionEndResponse = Type.Object({
  summary: Type.Optional(Type.String()),
});

export const ErrorResponse = Type.Object({
  error: Type.String(),
});

// --- Static types ---

export type CampaignSummary = Static<typeof CampaignSummary>;
export type ListCampaignsResponse = Static<typeof ListCampaignsResponse>;
export type StartCampaignResponse = Static<typeof StartCampaignResponse>;
export type ContributeRequest = Static<typeof ContributeRequest>;
export type CommitResponse = Static<typeof CommitResponse>;
export type CommandRequest = Static<typeof CommandRequest>;
export type ModalResponse = Static<typeof ModalResponse>;
export type SettingsPatch = Static<typeof SettingsPatch>;
export type SessionEndResponse = Static<typeof SessionEndResponse>;
export type ErrorResponse = Static<typeof ErrorResponse>;
