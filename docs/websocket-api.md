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

WebSocket messages are predominantly **server to client**. Clients send gameplay commands via REST endpoints (`POST /session/turn/contribute`, `POST /session/command/:name`, etc.), not over the WebSocket.

The one client→server WebSocket message is `client:viewport`, used to report the active terminal dimensions so the DM's per-turn length hint can adapt to the smallest connected client. See [Client Events](#client-events) below.

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

If a streaming API call fails mid-response and the engine is about to retry, the server first publishes a `state:snapshot` containing the committed `narrativeLines` (everything before the failed turn). Clients should treat that snapshot as authoritative and replace their accumulated log — otherwise the retry's chunks will visibly duplicate the partial text from the failed attempt. See `state:snapshot` below.

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

##### Server-side processing wait on contribute

When a contribution arrives while the current turn is in `"processing"` status (the DM is actively running), the server busy-waits up to **5 seconds** (50 polls × 100 ms) for the turn to transition to `"open"` before responding. If the turn opens within that window, the contribution proceeds normally. If it does not — or if there is no current turn — the server returns **400** with `{ "error": "No open turn. (status: processing)" }`.

This grace window silently absorbs the common race where a client submits immediately after the previous turn commits (the new turn may not have opened yet). A 400 with `status: processing` after the full window has elapsed is a definitive rejection, not a transient error to retry immediately — the DM is still running and will emit `turn:opened` when ready. This 400 path is distinct from the **409 Conflict** staleness check above, which fires only after the turn is confirmed open.

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

The player responds by sending the selected text as a turn contribution (`POST /session/turn/contribute`) with `fromChoice: true` so the setup agent can distinguish a real selection from a dismissal+free-form reply. The wire path is identical for setup and gameplay.

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
- `tui:resource_refresh` — no additional fields beyond `engineState`. Fired by the engine after a `resolve_turn` produces `hp_change` or `resource_spend` deltas, signalling the client to re-render resource gauges from current state. The reference client has no dedicated branch for this type; its purpose is to trigger a re-render via any state update on the `activity:update` path.
- `tui:set_theme` — carries optional `theme` (theme name), `key_color` (hex color override), and `variant` (style variant). Fired by `handleStyleSceneTool` (via the `style_scene` tool) and by the theme-styler subagent. The reference client applies theme changes from the post-turn `state:snapshot` (which carries `themeName`, `keyColor`, `variant`); the live `tui:set_theme` command is forwarded for alternative frontends that want to apply theme changes immediately rather than waiting for the snapshot.
- `tui:display_image` — carries `filename` (absolute path), `relPath` (campaign-relative path), and `intent` (`"scene_snapshot"`, `"player_request"`, or `"character_portrait"`). Fired by the `generate_image` tool path. The reference client appends a separator and an `image` narrative line to the log immediately (mid-turn, before the DM continuation runs). Both `filename` and a valid `intent` are required; if `intent` is not one of the three values the client silently ignores the command.
- `tui:show_character_sheet` — carries `character` (character name). Fired by the OOC/Dev Mode agent via the `show_character_sheet` tool (excluded from DM tool access) to open the character sheet modal programmatically. The reference client surfaces this as a tool-activity indicator but has no dedicated event-handler branch — the modal open is handled by the OOC/Dev mode's own UI path rather than the event stream.

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
| `narrativeLines`   | array?   | Authoritative committed transcript (`{ kind: "dm" \| "player", text }`). When present, the client REPLACES its accumulated narrative log; when omitted, the existing log is preserved. Sent on connect (so reconnecting clients see history) and on retry rollback (so a partial DM stream that's about to be re-issued doesn't accumulate twice on the client). Per-turn snapshots intentionally omit it to avoid clobbering in-flight stream deltas. |

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

The reference client keeps its activity line live across the transition by setting `engineState` to `"starting_session"` on receipt (and timestamping the change), so the indicator survives the WS reconnect and the long first DM call. See [Activity Indicators / Elapsed-time hints](tui-design.md#elapsed-time-hints-and-tier-escalation).

#### `session:ended`

The campaign session has ended.

| Field     | Type    | Description |
|-----------|---------|-------------|
| `summary` | string? | End-of-session summary text. |
| `cost`    | object? | Final token cost breakdown. |

Immediately before `session:ended`, the server broadcasts a final `state:snapshot` carrying `mode: "play"` (and otherwise-empty campaign fields). This is the canonical "you are back in play mode" signal for clients that were in OOC/Dev mode — without it, paths that null the engine's mode session as part of teardown (e.g. OOC rollback) would leave clients believing they're still in a mode session, and the next ESC would call `/exit_mode` against a dead session.

#### Poll-and-wait after session exit

After receiving `session:ended`, the server may still be completing async teardown (flushing the recap, resetting state). Clients that need to re-enable session-starting UI (New Campaign / Continue) should poll a REST endpoint until the status is `"idle"` before allowing a new session to start — this prevents a race condition where a quick exit + re-enter outruns backend teardown.

**Endpoint:** `GET /campaigns/session-status`

**Response (200):**

```json
{ "status": "idle" }
```

| `status` | Meaning |
|---|---|
| `"idle"` | No session is running; safe to start a new one. |
| `"starting"` | Session startup is in progress. |
| `"active"` | A session is fully running. |
| `"stopping"` | Teardown is in progress; wait before re-entering. |

The reference client's `waitForIdle()` helper polls this endpoint with backoff (starting at 100 ms, growing 1.5× per poll, capping at 500 ms) for up to 10 seconds. The poll is best-effort — a timeout is non-fatal. The call is made immediately after the end-session request resolves, while a saving overlay is shown to the user.

---

### Discord Presence

#### `discord:presence`

Frontend-local Discord rich-presence event. The engine is shared across multiple frontends; opting in to Discord is a per-frontend setting. The engine always emits these events; each frontend forwards them to its local Discord IPC iff the user has opted in on that frontend.

The `data.action` discriminator selects the payload shape:

| `action` | Additional fields | When emitted |
|---|---|---|
| `"start"` | `campaignName: string`, `dmPersona: string` | Once at session start. |
| `"update"` | `details: string` | Every 8th DM narrative completion. `details` is a punchy ≤40-char status line generated by the `discord-status` small-tier subagent from the latest narrative. |
| `"stop"` | — | Once on session end. |

The DM-narrative counter resets per backend session (i.e. each call to `startSession`). The interval is a fixed constant (`DISCORD_STATUS_INTERVAL = 8`) in `packages/engine/src/server/session-manager.ts`.

`details` always carries a non-empty string: the `discord-status` subagent never throws and falls back to `"Adventuring..."` on any failure, so an `update` is still emitted (the subagent's token usage is recorded against the session cost tracker under the small tier when the call succeeds). See the `discord-status` entry in [subagents-catalog.md](subagents-catalog.md).

#### How a frontend consumes these events

The reference client forwards each `discord:presence` event to a `DiscordPresenceController` (`packages/client-ink/src/services/discord/`), which acts only when the local opt-in is on:

- `"start"` records the session info and (if enabled) opens a Rich Presence connection: the `details` line shows the AI-generated status, the `state` line shows `{campaignName} — {dmPersona}`, an elapsed-time timestamp starts, and the large image is the `mv-logo` asset registered under Discord application ID `1485029427468435646`.
- `"update"` patches only the `details` line on the live presence.
- `"stop"` clears the activity and closes the connection.

The controller guards `start`/`stop` races with a generation counter, so a `stop` (or a mid-session opt-out) that arrives while a `start` is still connecting tears the connection back down instead of leaking it. The underlying `DiscordIPCClient` speaks Discord's named-pipe RPC framing — an 8-byte header (opcode `u32LE` + payload length `u32LE`) followed by UTF-8 JSON — over `\\?\pipe\discord-ipc-{0-9}` on win32 or `$XDG_RUNTIME_DIR/discord-ipc-{0-9}` on POSIX, and silently no-ops when Discord is not running. Other frontends are free to handle the same events however they like, or ignore them.

#### Configuring the Discord opt-in

The per-frontend opt-in is persisted in the engine's `configDir` as `discord-settings.json` (default: enabled). Two management REST endpoints read and write it:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/manage/discord` | Returns the current setting: `{ "enabled": boolean }`. If the file is absent, defaults to `enabled: true`. |
| `PUT` | `/manage/discord` | Accepts `{ "enabled": boolean }` and persists it. Returns the saved value. |

The client reads this setting on startup and after the user changes it in the Discord settings UI. When `enabled` is `false`, the client suppresses forwarding of `discord:presence` events to the OS Discord IPC even though the engine continues emitting them.

---

### Provider Usage

#### `usage:update`

Broadcasts the current provider quota snapshot to all connected clients. Powers the bottom-right usage gauge and the Esc-menu percentage in the TUI.

**When emitted:**
- On initial WebSocket connect, if a cached snapshot exists from a prior provider push.
- On every push from the active DM-tier provider's `subscribeUsage` callback (including the initial seed from `getUsageStatus` at session start).

Only providers that implement `subscribeUsage` (currently openai-chatgpt) emit this event. Sessions backed by providers without that interface never send `usage:update`.

| Field        | Type    | Description |
|--------------|---------|-------------|
| `segments`   | array   | One or more `UsageSegment` objects (see below). |
| `snapshotAt` | number  | Epoch milliseconds when this snapshot was captured. |
| `fresh`      | boolean | `false` when the data is cached/stale (e.g. no successful request yet). |

**UsageSegment** (element of `segments`):

The `kind` field selects the shape:
- `"percentage"` — window used as 0–100 (e.g. Codex 5-hour / 7-day windows).
- `"balance"` — currency credits (`used` / `total` with a unit such as `"USD"`).
- `"tokens"` — token counts (`used` / `total` with unit `"tokens"`).

| Field         | Type     | Description |
|---------------|----------|-------------|
| `id`          | string   | Stable identifier within the provider (e.g. `"primary"`, `"credits"`). |
| `label`       | string   | Short human-readable label (e.g. `"5-hour window"`, `"Credit balance"`). |
| `kind`        | string   | `"percentage"`, `"balance"`, or `"tokens"`. |
| `usedPercent` | number?  | 0–100. Populated when `kind === "percentage"`. |
| `used`        | number?  | Populated when `kind === "balance"` or `"tokens"`. |
| `total`       | number?  | Populated when `kind === "balance"` or `"tokens"`. |
| `unit`        | string?  | Display unit (e.g. `"USD"`, `"tokens"`, `"%"`). |
| `resetsAt`    | number?  | Epoch seconds when this window resets, if it resets at all. |
| `status`      | string   | `"ok"`, `"warning"`, `"critical"`, or `"exceeded"`. |
| `detail`      | string?  | Optional free-text annotation (tooltip / aria-label material). |
| `liveUpdates` | boolean? | `true` when the provider pushes updates in real time vs. polling. |
| `source`      | string?  | Diagnostic origin: `"request-header"`, `"api"`, `"local-budget"`, or `"rpc-notification"`. |

---

### Error

#### `error`

Error or retry notification.

| Field         | Type    | Description |
|---------------|---------|-------------|
| `message`     | string  | Human-readable error description. |
| `recoverable` | boolean | If true, the client should wait and retry. (Derived from `category`; present for backward compatibility.) |
| `status`      | number? | HTTP-style status code, if applicable. |
| `delayMs`     | number? | Suggested wait time before retry (ms). |
| `category`    | string? | Three-tier UX discriminant (see below). Absent means `"retryable"` for backward compatibility. |

##### Error category taxonomy

The optional `category` field is the canonical discriminant for which client UX to show — it is set server-side by `classifyServerError` (`packages/engine/src/server/error-classify.ts`) and must never be inferred from `message`. The union is closed (`packages/shared/src/protocol/events.ts`) so new buckets force both the type and the matching client handler to change.

| Value | Client behaviour |
|-------|-----------------|
| `"retryable"` | Transient failure (429, network blip). Server will retry; show the existing retry/wait overlay. Default value when `category` is absent. |
| `"session-fatal-recoverable"` | This session cannot continue (auth expired, forbidden model, classifier refusal) but the process is healthy. Client drops to the main menu and shows `message` verbatim in a red banner. The player must re-authenticate, change model config, or fix config, then start a new session. |
| `"process-fatal"` | Catastrophic failure; the process cannot continue. Show the hard-exit error screen. Reserved for extreme conditions; rarely emitted in practice. |

`recoverable` is `true` when `category` is `"retryable"` and `false` for the other two buckets, preserving backward compatibility for clients that have not yet adopted `category`.

## Client Events

The handful of messages clients may send to the server over the WebSocket.

### `client:viewport`

Reports this client's current terminal dimensions. Sent on every WS `open` and whenever the terminal resizes. The server keeps a per-connection map of dims; the value passed to the DM's length-steering injection is the **floor** — the smallest `narrativeRows` across all connected clients. If the smallest client raises its value (resize larger) or disconnects, the floor recomputes upward to whichever client is now smallest.

| Field            | Type   | Description |
|------------------|--------|-------------|
| `columns`        | number | Total terminal width in columns. |
| `rows`           | number | Total terminal height in rows. |
| `narrativeRows`  | number | Usable narrative-area rows after subtracting UI chrome (top frame, modelines, player pane, input line). The DM's `[length]` hint is keyed on this. |

```json
{ "type": "client:viewport", "data": { "columns": 120, "rows": 50, "narrativeRows": 32 } }
```

Unknown WebSocket messages from the client are logged and dropped.

## Canonical Source

All event schemas are defined as TypeBox objects in:

- `packages/shared/src/protocol/events.ts` — event types, `ChoicesData`, `ServerEvent`, and `ClientEvent` unions
- `packages/shared/src/protocol/turn.ts` — `Turn` and `TurnContribution`
- `packages/shared/src/protocol/state.ts` — `StateSnapshot`
- `packages/shared/src/protocol/connection.ts` — `ConnectionIdentity`

The bridge that translates engine callbacks to wire events lives in `packages/engine/src/server/bridge.ts`.
