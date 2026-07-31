/**
 * ConnectionsArea — the "Connect to AI" area: connection list, per-connection
 * detail, advanced model assignments, and the connect wizard.
 *
 * Navigation is a small push/pop stack (`AreaScreen[]`): Esc always pops, and
 * popping the last screen calls `onBack()`. Entered either at the list
 * (Settings → Connect to AI) or directly at the wizard (main-menu CTA).
 *
 * One selected provider drives the game: the connection assigned to the Large
 * tier is "in use", and applying a connection sets every tier to that
 * provider's default models (no cross-provider blending — see
 * `applyConnection`). Overrides in Model Assignments are scoped to the
 * in-use connection.
 */
import React, { useState, useEffect, useRef, useCallback } from "react";
import { useWindowSize } from "ink";
import type { ResolvedTheme } from "../../tui/themes/types.js";
import { TerminalTooSmall } from "../../tui/components/index.js";
import { MIN_COLUMNS, MIN_ROWS } from "../../tui/responsive.js";
import type {
  ConnectionInfo, TierAssignmentsResponse, TierAssignmentEntry,
  KnownImageModelInfo, KnownModelInfo, ConnectionHealthResponse,
  ChatGptLoginStartResponse, ChatGptLoginStatusResponse, UsageResponse,
  ProviderTierDefaults,
} from "../../api-client.js";
import { ConnectionsList } from "./ConnectionsList.js";
import { ConnectionDetail } from "./ConnectionDetail.js";
import { ModelAssignments } from "./ModelAssignments.js";
import { ConnectWizard } from "./ConnectWizard.js";
import { FixConnection } from "./FixConnection.js";
import { ChatGptSignIn } from "./ChatGptSignIn.js";

export type AreaScreen =
  | { kind: "list" }
  | { kind: "detail"; connectionId: string }
  | { kind: "models" }
  | { kind: "wizard" }
  /** Re-enter a failed key in place (key-based providers). */
  | { kind: "fix"; connectionId: string }
  /** Re-run the ChatGPT OAuth flow (upserts the connection in place). */
  | { kind: "signin"; connectionId: string };

export interface SetTiersBody {
  large?: TierAssignmentEntry;
  medium?: TierAssignmentEntry;
  small?: TierAssignmentEntry;
  imageAssignment?: TierAssignmentEntry | null;
}

export interface ConnectionsAreaProps {
  theme: ResolvedTheme;
  /** Entry point: the management list, or straight into the connect wizard. */
  initialScreen: "list" | "wizard";
  connections: ConnectionInfo[];
  tierAssignments: TierAssignmentsResponse;
  imageAssignment: TierAssignmentEntry | null;
  healthResults: Record<string, ConnectionHealthResponse>;
  knownModels: Record<string, KnownModelInfo>;
  knownImageModels: Record<string, KnownImageModelInfo>;
  tierDefaults: Record<string, ProviderTierDefaults>;
  /** Add a connection; resolves with the new connection, rejects with the server's message. */
  onAddConnection: (provider: string, apiKey: string, baseUrl?: string) => Promise<ConnectionInfo>;
  /** Replace a connection's API key in place (Fix flow). */
  onUpdateConnectionKey: (id: string, apiKey: string) => Promise<void>;
  onRemoveConnection: (id: string) => Promise<void>;
  /** Health-check a connection; resolves with the result (also recorded in `healthResults`). */
  onCheckHealth: (id: string) => Promise<ConnectionHealthResponse>;
  onSetTiers: (body: SetTiersBody) => Promise<void>;
  onStartChatGptLogin: () => Promise<ChatGptLoginStartResponse>;
  onPollChatGptLogin: (loginId: string) => Promise<ChatGptLoginStatusResponse>;
  onCancelChatGptLogin: (loginId: string) => Promise<unknown>;
  onRefreshConnections: () => void;
  onFetchUsage?: (connectionId: string) => Promise<UsageResponse>;
  onBack: () => void;
}

export function ConnectionsArea(props: ConnectionsAreaProps) {
  const { columns: cols, rows: termRows } = useWindowSize();
  const [stack, setStack] = useState<AreaScreen[]>(() =>
    props.initialScreen === "wizard" ? [{ kind: "wizard" }] : [{ kind: "list" }],
  );
  const screen = stack[stack.length - 1];

  const push = useCallback((s: AreaScreen) => setStack((prev) => [...prev, s]), []);
  const pop = useCallback(() => {
    setStack((prev) => {
      if (prev.length <= 1) {
        props.onBack();
        return prev;
      }
      return prev.slice(0, -1);
    });
  }, [props.onBack]);
  /** Wizard completion always lands on the list, whatever the entry point. */
  const landOnList = useCallback(() => setStack([{ kind: "list" }]), []);

  // Auto-check health for connections that have no result yet.
  const checkedRef = useRef(new Set<string>());
  useEffect(() => {
    for (const conn of props.connections) {
      if (!props.healthResults[conn.id] && !checkedRef.current.has(conn.id)) {
        checkedRef.current.add(conn.id);
        void props.onCheckHealth(conn.id).catch(() => { /* recorded as error state by the caller */ });
      }
    }
  }, [props.connections, props.healthResults, props.onCheckHealth]);

  // Per-connection usage cache, polled every 30s while the list or a detail
  // screen is visible. Connections without a live snapshot stay absent and
  // render no usage line.
  const [usageByConn, setUsageByConn] = useState<Record<string, UsageResponse>>({});
  const usageVisible = screen.kind === "list" || screen.kind === "detail";
  const fetchUsage = props.onFetchUsage;
  useEffect(() => {
    if (!usageVisible || !fetchUsage) return;
    let cancelled = false;
    const fetchAll = async () => {
      for (const conn of props.connections) {
        try {
          const res = await fetchUsage(conn.id);
          if (cancelled) return;
          setUsageByConn((prev) => ({ ...prev, [conn.id]: res }));
        } catch {
          // best-effort — leave the row's usage line absent
        }
      }
    };
    void fetchAll();
    const timer = setInterval(() => void fetchAll(), 30_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [usageVisible, props.connections, fetchUsage]);

  /**
   * Make `conn` the game's connection: assign every tier to that provider's
   * registry defaults (falling back to the connection's first model where a
   * default is missing, so no tier is ever left pointing at another
   * provider), and reset the image model to the provider default.
   */
  const applyConnection = useCallback(async (conn: ConnectionInfo) => {
    const defaults = props.tierDefaults[conn.provider] ?? {};
    const fallback = conn.models[0]?.id;
    const pick = (tier: "large" | "medium" | "small"): TierAssignmentEntry => {
      const def = defaults[tier];
      const modelId = def && conn.models.some((m) => m.id === def) ? def : fallback;
      if (!modelId) throw new Error("This connection has no models to use.");
      return { connectionId: conn.id, modelId };
    };
    await props.onSetTiers({
      large: pick("large"),
      medium: pick("medium"),
      small: pick("small"),
      imageAssignment: null,
    });
  }, [props.tierDefaults, props.onSetTiers]);

  if (cols < MIN_COLUMNS || termRows < MIN_ROWS) {
    return <TerminalTooSmall columns={cols} rows={termRows} />;
  }

  const activeConnectionId = props.tierAssignments.large?.connectionId ?? null;

  if (screen.kind === "wizard") {
    return (
      <ConnectWizard
        theme={props.theme}
        columns={cols}
        rows={termRows}
        connections={props.connections}
        tierAssignments={props.tierAssignments}
        knownModels={props.knownModels}
        onAddConnection={props.onAddConnection}
        onRemoveConnection={props.onRemoveConnection}
        onCheckHealth={props.onCheckHealth}
        onApplyConnection={applyConnection}
        onStartChatGptLogin={props.onStartChatGptLogin}
        onPollChatGptLogin={props.onPollChatGptLogin}
        onCancelChatGptLogin={props.onCancelChatGptLogin}
        onRefreshConnections={props.onRefreshConnections}
        onDone={landOnList}
        onExit={pop}
      />
    );
  }

  if (screen.kind === "fix" || screen.kind === "signin" || screen.kind === "detail") {
    const conn = props.connections.find((c) => c.id === screen.connectionId);
    if (conn && screen.kind === "fix") {
      return (
        <FixConnection
          theme={props.theme}
          columns={cols}
          rows={termRows}
          connection={conn}
          onUpdateKey={(apiKey) => props.onUpdateConnectionKey(conn.id, apiKey)}
          onCheck={() => props.onCheckHealth(conn.id)}
          onDone={pop}
          onBack={pop}
        />
      );
    }
    if (conn && screen.kind === "signin") {
      return (
        <ChatGptSignIn
          theme={props.theme}
          columns={cols}
          rows={termRows}
          onStart={props.onStartChatGptLogin}
          onPoll={props.onPollChatGptLogin}
          onCancel={props.onCancelChatGptLogin}
          onSuccess={() => {
            // The OAuth upsert refreshed the credential in place — reload the
            // list and re-verify so the detail screen shows the fresh state.
            props.onRefreshConnections();
            void props.onCheckHealth(conn.id).catch(() => { /* recorded as error state */ });
            pop();
          }}
          onExit={pop}
        />
      );
    }
    if (!conn) {
      // Connection disappeared under us (deleted elsewhere) — fall back.
      return (
        <ConnectionsList
          theme={props.theme}
          columns={cols}
          rows={termRows}
          connections={props.connections}
          healthResults={props.healthResults}
          usageByConn={usageByConn}
          activeConnectionId={activeConnectionId}
          onOpenDetail={(c) => push({ kind: "detail", connectionId: c.id })}
          onAdd={() => push({ kind: "wizard" })}
          onModels={() => push({ kind: "models" })}
          onBack={pop}
        />
      );
    }
    return (
      <ConnectionDetail
        theme={props.theme}
        columns={cols}
        rows={termRows}
        connection={conn}
        health={props.healthResults[conn.id]}
        usage={usageByConn[conn.id]}
        isActive={conn.id === activeConnectionId}
        knownModels={props.knownModels}
        tierAssignments={props.tierAssignments}
        onApply={() => applyConnection(conn)}
        onCheck={() => props.onCheckHealth(conn.id)}
        onFix={() => push(
          conn.provider === "openai-chatgpt"
            ? { kind: "signin", connectionId: conn.id }
            : { kind: "fix", connectionId: conn.id },
        )}
        onRemove={async () => {
          await props.onRemoveConnection(conn.id);
          pop();
        }}
        onBack={pop}
      />
    );
  }

  if (screen.kind === "models") {
    return (
      <ModelAssignments
        theme={props.theme}
        columns={cols}
        rows={termRows}
        connections={props.connections}
        tierAssignments={props.tierAssignments}
        imageAssignment={props.imageAssignment}
        knownModels={props.knownModels}
        knownImageModels={props.knownImageModels}
        tierDefaults={props.tierDefaults}
        onSetTiers={props.onSetTiers}
        onBack={pop}
      />
    );
  }

  return (
    <ConnectionsList
      theme={props.theme}
      columns={cols}
      rows={termRows}
      connections={props.connections}
      healthResults={props.healthResults}
      usageByConn={usageByConn}
      activeConnectionId={activeConnectionId}
      onOpenDetail={(c) => push({ kind: "detail", connectionId: c.id })}
      onAdd={() => push({ kind: "wizard" })}
      onModels={() => push({ kind: "models" })}
      onBack={pop}
    />
  );
}
