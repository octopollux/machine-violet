# WebSocket API Reference

Real-time server-to-client event stream for the Machine Violet engine.

## Connection

**Endpoint:** `GET /session/ws` (HTTP upgrade to WebSocket)

**Query parameters:**

| Param    | Required | Description |
|----------|----------|-------------|
| `role`   | No       | `"player"` or `"spectator"`. Default: `"spectator"`. |
| `player` | When role=player | Player identifier string (e.g. `"aldric"`). |

**Example:** `ws://127.0.0.1:7200/session/ws?role=player&player=aldric`

No authentication is required (localhost-only). Auth will be added when remote connections are enabled.

## Communication Direction

All WebSocket messages flow **server to client**. The WebSocket channel is one-way push — clients send commands via REST endpoints (`POST /session/turn/contribute`, `POST /session/choice/respond`, etc.), not over the WebSocket.

## Message Format

Every message is a JSON object with two fields:

```json
{ "type": "<event-type>", "data": { ... } }
```

The `type` field is a string discriminant. The `data` field varies by event type. All schemas are defined with TypeBox in `packages/shared/src/protocol/events.ts`.

## Connection Lifecycle

1. Client opens WebSocket to `/session/ws` with identity query params
2. Server immediately sends a `state:snapshot` event with the full current game state
3. Server pushes events as gameplay proceeds
4. On unexpected disconnect, clients should reconnect with exponential backoff
5. If all **player** connections drop for 5 minutes, the server auto-saves and ends the session (spectator connections are excluded from this check). If a client reconnects after the session has ended, no `state:snapshot` is sent (the server only sends snapshots for active sessions). Clients should treat the absence of a snapshot on connect as "no active session" and return the user to the main menu

## Events

### Narrative

#### `narrative:chunk`

Streaming DM narration text, buffered by word boundaries (whitespace/newline, or >200 chars, with a 50ms flush timeout). Multiple chunks arrive during a single DM response.

| Field     | Type     | Description |
|-----------|----------|-------------|
| `text`    | string   | A buffered fragment of DM output. |
| `speaker` | string?  | Speaker name, if applicable. |
| `kind`    | string?  | `"dm"`, `"player"`, `"system"`, or `"dev"`. |

#### `narrative:complete`

Signals the end of a DM response. Sent after all `narrative:chunk` events for that response.

| Field          | Type    | Description |
|----------------|---------|-------------|
| `text`         | string  | The complete DM response text. |
| `playerAction` | string? | The player action that triggered this response. |

---

### Turn Lifecycle

Turns progress through: `open` → `committed` → `processing` → `resolved`.

#### `turn:opened`

A new turn is ready for player contributions.

| Field          | Type     | Description |
|----------------|----------|-------------|
| `id`           | string   | Turn identifier (UUID). |
| `seq`          | number   | Sequential turn number within this session (1-based). |
| `campaignId`   | string   | Campaign this turn belongs to. |
| `status`       | string   | Always `"open"` for this event. |
| `activePlayers`| string[] | Human players who can contribute. |
| `aiPlayers`    | string[] | AI players scheduled to run after humans contribute. |
| `contributions`| array    | Initially empty. See `TurnContribution` below. |
| `commitPolicy` | string   | `"auto"` (single player, auto-commit) or `"all"` (wait for all). |

Clients should track `campaignId` and `seq` to detect staleness:
- **Campaign mismatch** (a different `campaignId` than expected) means the backend session changed — return the user to the main menu.
- **Seq gap** (a `seq` higher than expected by more than 1) means the client missed turns while disconnected. The state snapshot received on reconnect already hydrates the client, so no special action is needed — just accept the new turn and continue.

Clients may also include `campaignId` and `turnSeq` in `POST /session/turn/contribute` requests. The server returns **409 Conflict** on mismatch, allowing the client to silently discard the stale contribution and restore the player's input for resubmission.

**TurnContribution** (nested in turn events):

| Field       | Type    | Description |
|-------------|---------|-------------|
| `id`        | string  | Contribution identifier. |
| `playerId`  | string  | Who contributed. |
| `source`    | string  | `"client"` (human) or `"engine"` (AI player). |
| `text`      | string  | The contributed text. |
| `amendment` | boolean | If true, replaces the player's previous contribution. |

#### `turn:updated`

A player contributed to the current turn. Broadcast to all clients in real time.

| Field          | Type             | Description |
|----------------|------------------|-------------|
| `turnId`       | string           | Turn identifier. |
| `contribution` | TurnContribution | The new contribution. |

#### `turn:committed`

The turn has been submitted for DM processing. No more contributions accepted.

| Field    | Type   | Description |
|----------|--------|-------------|
| `turnId` | string | Turn identifier. |

#### `turn:resolved`

Turn processing is complete. The next `turn:opened` will follow shortly.

| Field    | Type   | Description |
|----------|--------|-------------|
| `turnId` | string | Turn identifier. |

---

### Choices

Structured choice data sent when the DM or setup agent presents options to the player. These are **not modals** — the reference TUI renders them inline in the Player Pane. Frontends can present them however they like (inline list, dropdown, buttons, etc.).

#### `choices:presented`

The DM or setup agent is offering the player a set of choices.

| Field          | Type     | Description |
|----------------|----------|-------------|
| `id`           | string   | Choice set identifier. |
| `prompt`       | string   | Question or prompt text. |
| `choices`      | string[] | Available options. |
| `descriptions` | string[]?| Optional per-choice descriptions. |

The player responds by sending the selected text as a turn contribution (`POST /session/turn/contribute`) during gameplay, or via `POST /session/choice/respond` during setup.

#### `choices:cleared`

The active choice set has been dismissed (player selected, or context changed).

| Field | Type   | Description |
|-------|--------|-------------|
| *(empty object)* | | |

---

### Activity

#### `activity:update`

Engine state changes and tool lifecycle tracking. Also carries embedded TUI commands for modeline/resource updates.

| Field          | Type    | Description |
|----------------|---------|-------------|
| `engineState`  | string? | New engine state (e.g. `"thinking"`, `"idle"`). |
| `toolStarted`  | string? | Name of a tool that just started executing. |
| `toolEnded`    | string? | Name of a tool that just finished executing. |

The `data` payload may also include TUI command fields (forwarded from the engine's `onTuiCommand` callback):

- `tui:update_modeline` — modeline text update for a character
- `tui:set_display_resources` — configure which resources to show per character
- `tui:set_resource_values` — update resource values per character

---

### State

#### `state:snapshot`

Full game state. Sent on initial connect, after every DM turn completes, after scene transitions, and after player cycling. The post-turn snapshot is authoritative — it overwrites any incremental `activity:update` patches the client assembled during the turn, making the system self-healing if any individual event is missed.

| Field              | Type     | Description |
|--------------------|----------|-------------|
| `campaignId`       | string   | Campaign directory name. |
| `campaignName`     | string   | Human-readable campaign name. |
| `system`           | string?  | Game system identifier. |
| `players`          | array    | Player roster (see below). |
| `activePlayerIndex`| number   | Index into `players` of the active player. |
| `displayResources` | object   | `{ [character]: string[] }` — resource names to display. |
| `resourceValues`   | object   | `{ [character]: { [resource]: string } }` — current values. |
| `modelines`        | object   | `{ [character]: string }` — status text per character. |
| `themeName`        | string?  | Active theme name. |
| `variant`          | string?  | Style variant (e.g. scene mood). |
| `keyColor`         | string?  | Theme key color override. |
| `engineState`      | string?  | Current engine state. |
| `mode`             | string   | `"play"`, `"ooc"`, `"dev"`, or `"setup"`. |
| `cost`             | object?  | Token cost breakdown. |
| `sceneNumber`      | number?  | Current scene number. |
| `scenePrecis`      | string?  | One-line scene summary. |
| `sessionRecap`     | object?  | `{ id, lines }` — present only in the first snapshot after a clean session-end. Client renders the "Previously on..." modal; server clears the pending flag as it emits. Omitted on mid-session reconnects and fresh campaigns. |

**Player** (nested in `players` array):

| Field       | Type   | Description |
|-------------|--------|-------------|
| `name`      | string | Player display name. |
| `character` | string | Character name. |
| `type`      | string | `"human"` or `"ai"`. |
| `color`     | string?| Player color for UI. |

---

### Session

#### `session:mode`

The session mode has changed.

| Field     | Type    | Description |
|-----------|---------|-------------|
| `mode`    | string  | `"play"`, `"ooc"`, `"dev"`, or `"setup"`. |
| `variant` | string? | Style variant (e.g. `"tense"`, `"mysterious"`). |

#### `session:transition`

The server is transitioning from the setup session to a newly created campaign. Clients should reset their state (clear stateSnapshot, currentTurn, etc.) — the new session will broadcast a fresh `state:snapshot` over the existing WebSocket connection.

| Field          | Type    | Description |
|----------------|---------|-------------|
| `campaignId`   | string  | The campaign ID of the newly created campaign. |
| `campaignName` | string? | Human-readable campaign name for immediate display. |

#### `session:ended`

The campaign session has ended.

| Field     | Type    | Description |
|-----------|---------|-------------|
| `summary` | string? | End-of-session summary text. |
| `cost`    | object? | Final token cost breakdown. |

---

### Discord Presence

#### `discord:presence`

Frontend-local Discord rich-presence event. The engine is shared across multiple frontends; opting in to Discord is a per-frontend setting. The engine always emits these events; each frontend forwards them to its local Discord IPC iff the user has opted in on that frontend.

The `data.action` discriminator selects the payload shape:

| `action` | Additional fields | When emitted |
|---|---|---|
| `"start"` | `campaignName: string`, `dmPersona: string` | Once at session start. |
| `"update"` | `details: string` | Every 8th DM narrative completion. `details` is a punchy ≤40-char status line generated by a small-model subagent from the latest narrative. |
| `"stop"` | — | Once on session end. |

The DM-narrative counter resets per backend session (i.e. each call to `startSession`).

---

### Error

#### `error`

Error or retry notification.

| Field         | Type    | Description |
|---------------|---------|-------------|
| `message`     | string  | Human-readable error description. |
| `recoverable` | boolean | If true, the client should wait and retry. |
| `status`      | number? | HTTP-style status code, if applicable. |
| `delayMs`     | number? | Suggested wait time before retry (ms). |

## Canonical Source

All event schemas are defined as TypeBox objects in:

- `packages/shared/src/protocol/events.ts` — event types, `ChoicesData`, and `ServerEvent` union
- `packages/shared/src/protocol/turn.ts` — `Turn` and `TurnContribution`
- `packages/shared/src/protocol/state.ts` — `StateSnapshot`
- `packages/shared/src/protocol/connection.ts` — `ConnectionIdentity`

The bridge that translates engine callbacks to wire events lives in `packages/engine/src/server/bridge.ts`.
