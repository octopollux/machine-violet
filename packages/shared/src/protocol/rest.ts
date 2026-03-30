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
  /** Campaign ID the client believes it is playing. Rejected on mismatch. */
  campaignId: Type.Optional(Type.String()),
  /** Turn sequence number the client believes is current. Rejected on mismatch. */
  turnSeq: Type.Optional(Type.Number()),
});

export const CommitResponse = Type.Object({
  turnId: Type.String(),
});

export const CommandRequest = Type.Object({
  args: Type.Optional(Type.String()),
});

export const ChoiceResponseRequest = Type.Object({
  /** The selected choice text. */
  value: Type.String(),
});

export const SettingsPatch = Type.Object({}, { additionalProperties: true });

export const SessionEndResponse = Type.Object({
  summary: Type.Optional(Type.String()),
});

export const ErrorResponse = Type.Object({
  error: Type.String(),
});

// --- Common params ---

export const IdParams = Type.Object({ id: Type.String() });
export const NameParams = Type.Object({ name: Type.String() });

// --- Session responses ---

export const ContributeResponse = Type.Object({
  turnId: Type.String(),
  contributionId: Type.String(),
});

export const ContributeQuery = Type.Object({
  player: Type.Optional(Type.String()),
});

export const CommandParams = Type.Object({ name: Type.String() });

export const CommandResponse = Type.Object({
  ok: Type.Boolean(),
  message: Type.Optional(Type.String()),
});

export const OkResponse = Type.Object({ ok: Type.Boolean() });

export const CyclePlayerResponse = Type.Object({
  activePlayerIndex: Type.Number(),
  character: Type.Optional(Type.String()),
});

// --- Data responses ---

export const CharacterResponse = Type.Object({
  name: Type.String(),
  content: Type.String(),
});

export const CompendiumResponse = Type.Object({
  data: Type.Unknown(),
});

export const NotesResponse = Type.Object({
  content: Type.String(),
});

export const NotesUpdateRequest = Type.Object({
  content: Type.String(),
});

export const SettingsResponse = Type.Object({
  config: Type.Unknown(),
});

export const CostResponse = Type.Object({
  breakdown: Type.Unknown(),
  formatted: Type.String(),
});

// --- Management schemas ---

export const ConnectionModel = Type.Object({
  id: Type.String(),
  displayName: Type.String(),
  available: Type.Boolean(),
});

export const SerializedConnection = Type.Object({
  id: Type.String(),
  provider: Type.String(),
  label: Type.String(),
  masked: Type.String(),
  baseUrl: Type.Optional(Type.String()),
  models: Type.Array(Type.Unknown()),
  source: Type.String(),
  addedAt: Type.String(),
});

export const TierAssignmentSchema = Type.Object({
  connectionId: Type.String(),
  modelId: Type.String(),
});

export const ConnectionsListResponse = Type.Object({
  connections: Type.Array(SerializedConnection),
  tierAssignments: Type.Unknown(),
});

export const AddConnectionRequest = Type.Object({
  provider: Type.Union([
    Type.Literal("anthropic"),
    Type.Literal("openai"),
    Type.Literal("openai-oauth"),
    Type.Literal("openrouter"),
    Type.Literal("custom"),
  ]),
  apiKey: Type.String(),
  label: Type.Optional(Type.String()),
  baseUrl: Type.Optional(Type.String()),
});

export const HealthCheckResponse = Type.Object({
  id: Type.String(),
  status: Type.Union([Type.Literal("ok"), Type.Literal("error")]),
  message: Type.Optional(Type.String()),
});

export const UpdateModelsRequest = Type.Object({
  models: Type.Array(ConnectionModel),
});

export const TiersResponse = Type.Object({
  tierAssignments: Type.Unknown(),
});

export const SetTiersRequest = Type.Object({
  large: Type.Optional(TierAssignmentSchema),
  medium: Type.Optional(TierAssignmentSchema),
  small: Type.Optional(TierAssignmentSchema),
});

export const ModelsResponse = Type.Object({
  models: Type.Unknown(),
});

export const ArchiveResponse = Type.Object({
  ok: Type.Boolean(),
  zipPath: Type.Optional(Type.String()),
});

export const ArchivedListResponse = Type.Object({
  archives: Type.Array(Type.Unknown()),
});

export const RestoreRequest = Type.Object({
  zipPath: Type.Optional(Type.String()),
});

export const DiscordSettings = Type.Object({
  enabled: Type.Boolean(),
});

export const KeysListResponse = Type.Object({
  keys: Type.Array(Type.Unknown()),
  activeKeyId: Type.Union([Type.String(), Type.Null()]),
});

export const DeleteInfoResponse = Type.Object({
  name: Type.String(),
  sceneCount: Type.Optional(Type.Number()),
  lastPlayed: Type.Optional(Type.String()),
});

// --- Static types ---

export type CampaignSummary = Static<typeof CampaignSummary>;
export type ListCampaignsResponse = Static<typeof ListCampaignsResponse>;
export type StartCampaignResponse = Static<typeof StartCampaignResponse>;
export type ContributeRequest = Static<typeof ContributeRequest>;
export type CommitResponse = Static<typeof CommitResponse>;
export type CommandRequest = Static<typeof CommandRequest>;
export type ChoiceResponseRequest = Static<typeof ChoiceResponseRequest>;
export type SettingsPatch = Static<typeof SettingsPatch>;
export type SessionEndResponse = Static<typeof SessionEndResponse>;
export type ErrorResponse = Static<typeof ErrorResponse>;
export type IdParams = Static<typeof IdParams>;
export type NameParams = Static<typeof NameParams>;
export type ContributeResponse = Static<typeof ContributeResponse>;
export type ContributeQuery = Static<typeof ContributeQuery>;
export type CommandParams = Static<typeof CommandParams>;
export type CommandResponse = Static<typeof CommandResponse>;
export type OkResponse = Static<typeof OkResponse>;
export type CyclePlayerResponse = Static<typeof CyclePlayerResponse>;
export type CharacterResponse = Static<typeof CharacterResponse>;
export type CompendiumResponse = Static<typeof CompendiumResponse>;
export type NotesResponse = Static<typeof NotesResponse>;
export type NotesUpdateRequest = Static<typeof NotesUpdateRequest>;
export type SettingsResponse = Static<typeof SettingsResponse>;
export type CostResponse = Static<typeof CostResponse>;
export type ConnectionModel = Static<typeof ConnectionModel>;
export type SerializedConnection = Static<typeof SerializedConnection>;
export type TierAssignmentSchema = Static<typeof TierAssignmentSchema>;
export type ConnectionsListResponse = Static<typeof ConnectionsListResponse>;
export type AddConnectionRequest = Static<typeof AddConnectionRequest>;
export type HealthCheckResponse = Static<typeof HealthCheckResponse>;
export type UpdateModelsRequest = Static<typeof UpdateModelsRequest>;
export type TiersResponse = Static<typeof TiersResponse>;
export type SetTiersRequest = Static<typeof SetTiersRequest>;
export type ModelsResponse = Static<typeof ModelsResponse>;
export type ArchiveResponse = Static<typeof ArchiveResponse>;
export type ArchivedListResponse = Static<typeof ArchivedListResponse>;
export type RestoreRequest = Static<typeof RestoreRequest>;
export type DiscordSettings = Static<typeof DiscordSettings>;
export type KeysListResponse = Static<typeof KeysListResponse>;
export type DeleteInfoResponse = Static<typeof DeleteInfoResponse>;
