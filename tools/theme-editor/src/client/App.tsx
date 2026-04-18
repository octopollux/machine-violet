import { useEffect, useMemo, useState } from "react";
import type { AssetsResponse, ThemeAssetPayload } from "../shared/protocol";
import type { StyleVariant, ThemeAsset, PlayerPaneFrame } from "@engine-src/tui/themes/types.js";
import { parseThemeAsset, parsePlayerPaneFrame } from "@engine-src/tui/themes/parser.js";
import { deriveModalTheme } from "@engine-src/tui/themes/color-resolve.js";
import { buildDefinition } from "./lib/definition";
import { resolveThemeWithAssets } from "./lib/resolve";
import {
  renderConversationFrame,
  renderModal,
  renderPlayerPane,
  type SegmentRow,
} from "./lib/render";
import { FrameCanvas } from "./components/FrameCanvas";
import { SourceEditor } from "./components/SourceEditor";

const VARIANTS: StyleVariant[] = ["exploration", "combat", "ooc", "levelup", "dev"];

const MAIN_WIDTH = 120;
const MAIN_HEIGHT = 40;
const MODAL_WIDTH = 60;
const MODAL_HEIGHT = 20;
const PLAYER_WIDTH = 40;
const PLAYER_HEIGHT = 8;

const SAMPLE_CONTENT = [
  "  The dragon's shadow falls across the broken temple floor.",
  "  Faded frescoes show a battle long lost to history.",
  "",
  "  > I search the altar for hidden compartments.",
  "",
  "  You find a loose stone at the base; behind it, a brass",
  "  key engraved with a sigil you don't recognize.",
];

const SAMPLE_MODAL = [
  "Character: Elowen Briarleaf",
  "Class:     Druid (Circle of the Moon)",
  "Level:     5",
  "",
  "HP: 42 / 42    AC: 14    Speed: 30 ft",
];

const SAMPLE_PLAYER = ["Elowen  HP 42/42  AC 14", "Round 3  —  Your turn"];

function copyToClipboard(text: string): void {
  navigator.clipboard.writeText(text).catch((err) => {
    console.error("Clipboard write failed:", err);
  });
}

function useAssets(): AssetsResponse | null {
  const [assets, setAssets] = useState<AssetsResponse | null>(null);
  useEffect(() => {
    fetch("/api/assets")
      .then((r) => r.json())
      .then(setAssets)
      .catch((err) => console.error("Failed to load assets:", err));
  }, []);
  return assets;
}

function findAsset(list: ThemeAssetPayload[] | undefined, name: string): ThemeAssetPayload | undefined {
  return list?.find((a) => a.name === name);
}

export function App() {
  const assets = useAssets();

  const [themeName, setThemeName] = useState<string>("arcane");
  const [frameName, setFrameName] = useState<string>("default");
  const [themeSource, setThemeSource] = useState<string>("");
  const [frameSource, setFrameSource] = useState<string>("");
  const [keyColor, setKeyColor] = useState<string>("#8888aa");
  const [variant, setVariant] = useState<StyleVariant>("exploration");

  // Seed source from selected asset when it loads/changes.
  useEffect(() => {
    const match = findAsset(assets?.themes, themeName);
    if (match) setThemeSource(match.content);
  }, [assets, themeName]);

  useEffect(() => {
    const match = findAsset(assets?.playerFrames, frameName);
    if (match) setFrameSource(match.content);
  }, [assets, frameName]);

  // Parse theme + frame, catching errors separately so one bad edit doesn't break the other.
  const parsed = useMemo(() => {
    let asset: ThemeAsset | null = null;
    let assetError: string | null = null;
    let frame: PlayerPaneFrame | null = null;
    let frameError: string | null = null;

    try {
      if (themeSource.trim()) asset = parseThemeAsset(themeSource);
    } catch (err) {
      assetError = err instanceof Error ? err.message : String(err);
    }
    try {
      if (frameSource.trim()) frame = parsePlayerPaneFrame(frameSource);
    } catch (err) {
      frameError = err instanceof Error ? err.message : String(err);
    }

    return { asset, assetError, frame, frameError };
  }, [themeSource, frameSource]);

  const definition = useMemo(() => {
    if (!parsed.asset) return null;
    try {
      return buildDefinition(themeName, themeSource);
    } catch (err) {
      console.error("buildDefinition failed:", err);
      return null;
    }
  }, [parsed.asset, themeName, themeSource]);

  const resolved = useMemo(() => {
    if (!definition || !parsed.asset || !parsed.frame) return null;
    try {
      return resolveThemeWithAssets(definition, parsed.asset, parsed.frame, variant, keyColor);
    } catch (err) {
      console.error("resolveTheme failed:", err);
      return null;
    }
  }, [definition, parsed.asset, parsed.frame, variant, keyColor]);

  const mainRows: SegmentRow[] = useMemo(() => {
    if (!resolved) return [];
    const contentHeight = MAIN_HEIGHT - 2 * resolved.asset.height;
    const rows: string[] = new Array(contentHeight).fill("");
    for (let i = 0; i < SAMPLE_CONTENT.length && i < contentHeight; i++) {
      rows[i] = SAMPLE_CONTENT[i];
    }
    const turnRow = Math.floor(contentHeight * 0.6);
    return renderConversationFrame(resolved, {
      width: MAIN_WIDTH,
      height: MAIN_HEIGHT,
      title: "Machine Violet  —  The Silent Spires",
      turnIndicator: "Round 3 · Elowen's turn",
      contentRows: rows,
      turnSeparatorRow: turnRow,
    }).rows;
  }, [resolved]);

  const modalRows: SegmentRow[] = useMemo(() => {
    if (!resolved) return [];
    const modalTheme = deriveModalTheme(resolved);
    const contentHeight = MODAL_HEIGHT - 2 * modalTheme.asset.height;
    const rows: string[] = new Array(contentHeight).fill("");
    for (let i = 0; i < SAMPLE_MODAL.length && i < contentHeight; i++) rows[i] = SAMPLE_MODAL[i];
    return renderModal(modalTheme, {
      width: MODAL_WIDTH,
      height: MODAL_HEIGHT,
      title: "Character Sheet",
      footer: "Enter to close",
      contentRows: rows,
    }).rows;
  }, [resolved]);

  const playerRows: SegmentRow[] = useMemo(() => {
    if (!resolved) return [];
    const contentHeight = PLAYER_HEIGHT - 2;
    const rows: string[] = new Array(contentHeight).fill("");
    for (let i = 0; i < SAMPLE_PLAYER.length && i < contentHeight; i++) rows[i] = SAMPLE_PLAYER[i];
    return renderPlayerPane(resolved, {
      width: PLAYER_WIDTH,
      height: PLAYER_HEIGHT,
      contentRows: rows,
    }).rows;
  }, [resolved]);

  // Tile period annotations help diagnose whether repeats are landing cleanly.
  const tileInfo = useMemo(() => {
    if (!parsed.asset) return null;
    const { edge_top, edge_left } = parsed.asset.components;
    return {
      horizontal: edge_top.width,
      vertical: edge_left.height,
    };
  }, [parsed.asset]);

  const themesList = assets?.themes ?? [];
  const framesList = assets?.playerFrames ?? [];

  const resetTheme = () => {
    const match = findAsset(themesList, themeName);
    if (match) setThemeSource(match.content);
  };
  const resetFrame = () => {
    const match = findAsset(framesList, frameName);
    if (match) setFrameSource(match.content);
  };

  return (
    <>
      <div className="app-header">
        <h1>Theme Editor</h1>
        <div className="controls">
          <label>
            Theme
            <select value={themeName} onChange={(e) => setThemeName(e.target.value)}>
              {themesList.map((t) => (
                <option key={t.name} value={t.name}>{t.name}</option>
              ))}
            </select>
          </label>
          <label>
            Player frame
            <select value={frameName} onChange={(e) => setFrameName(e.target.value)}>
              {framesList.map((f) => (
                <option key={f.name} value={f.name}>{f.name}</option>
              ))}
            </select>
          </label>
          <label>
            Variant
            <select value={variant} onChange={(e) => setVariant(e.target.value as StyleVariant)}>
              {VARIANTS.map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          </label>
          <label>
            Key color
            <input
              type="color"
              value={keyColor}
              onChange={(e) => setKeyColor(e.target.value)}
            />
            <input
              type="text"
              value={keyColor}
              onChange={(e) => setKeyColor(e.target.value)}
              className="hex-input"
              spellCheck={false}
            />
          </label>
        </div>
      </div>
      <div className="app-body">
        <div className="editors">
          <div className="editor-section">
            <div className="editor-actions">
              <button onClick={() => copyToClipboard(themeSource)}>Copy .theme</button>
              <button onClick={resetTheme}>Reset to {themeName}</button>
            </div>
            <SourceEditor
              label={`${themeName}.theme`}
              value={themeSource}
              onChange={setThemeSource}
              error={parsed.assetError}
              rows={26}
            />
          </div>
          <div className="editor-section">
            <div className="editor-actions">
              <button onClick={() => copyToClipboard(frameSource)}>Copy .player-frame</button>
              <button onClick={resetFrame}>Reset to {frameName}</button>
            </div>
            <SourceEditor
              label={`${frameName}.player-frame`}
              value={frameSource}
              onChange={setFrameSource}
              error={parsed.frameError}
              rows={14}
            />
          </div>
        </div>
        <div className="previews">
          {!resolved && (
            <div className="preview-empty">
              {parsed.assetError || parsed.frameError
                ? "Fix parse errors to render a preview."
                : "Loading theme..."}
            </div>
          )}
          {resolved && (
            <>
              <FrameCanvas
                rows={mainRows}
                caption={`Conversation pane — ${MAIN_WIDTH}×${MAIN_HEIGHT}${tileInfo ? ` · edge tile H:${tileInfo.horizontal} V:${tileInfo.vertical}` : ""}`}
              />
              <FrameCanvas
                rows={modalRows}
                caption={`Modal (derived theme) — ${MODAL_WIDTH}×${MODAL_HEIGHT}`}
              />
              <FrameCanvas
                rows={playerRows}
                caption={`Player pane — ${PLAYER_WIDTH}×${PLAYER_HEIGHT}`}
              />
            </>
          )}
        </div>
      </div>
    </>
  );
}
