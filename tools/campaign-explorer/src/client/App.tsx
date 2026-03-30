import { useState, useCallback, useRef, useEffect } from "react";
import { useCampaigns } from "./hooks/useCampaigns";
import { useFileTree } from "./hooks/useFileTree";
import { useMachineTree } from "./hooks/useMachineTree";
import { useSSE } from "./hooks/useSSE";
import { CampaignSelector } from "./components/CampaignSelector";
import { FileTree } from "./components/FileTree";
import { ContentPane } from "./components/ContentPane";
import type { SSEEvent, FileChangeEvent } from "../shared/protocol";
import { MACHINE_SLUG } from "../shared/protocol";

const STORAGE_KEY_CAMPAIGN = "ce:selectedCampaign";
const STORAGE_KEY_FILE = "ce:selectedFile";

function loadStored(key: string): string | null {
  try { return sessionStorage.getItem(key); } catch { return null; }
}

function saveStored(key: string, value: string | null): void {
  try {
    if (value == null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch { /* storage unavailable */ }
}

export function App() {
  const [campaignRefreshKey, setCampaignRefreshKey] = useState(0);
  const { campaigns, loading: campaignsLoading } = useCampaigns(campaignRefreshKey);
  const [selectedCampaign, setSelectedCampaign] = useState<string | null>(
    loadStored(STORAGE_KEY_CAMPAIGN),
  );
  const [selectedFile, setSelectedFile] = useState<string | null>(
    loadStored(STORAGE_KEY_FILE),
  );
  const [refreshKey, setRefreshKey] = useState(0);
  const lastFileChangeRef = useRef<FileChangeEvent | null>(null);

  // Validate restored selection once campaigns load — clear if the campaign no longer exists
  const restoredRef = useRef(false);
  useEffect(() => {
    if (campaignsLoading || restoredRef.current) return;
    restoredRef.current = true;
    if (selectedCampaign && !campaigns.some((c) => c.slug === selectedCampaign)) {
      setSelectedCampaign(null);
      setSelectedFile(null);
      saveStored(STORAGE_KEY_CAMPAIGN, null);
      saveStored(STORAGE_KEY_FILE, null);
    }
  }, [campaignsLoading, campaigns, selectedCampaign]);

  // Track which scope the selected file belongs to
  const [selectedScope, setSelectedScope] = useState<"campaign" | "machine">("campaign");

  const { groups, loading: treeLoading, updatedItems, markRead, handleFileChange } =
    useFileTree(selectedCampaign, selectedFile);

  const {
    groups: machineGroups,
    loading: machineLoading,
    updatedItems: machineUpdatedItems,
    markRead: machineMarkRead,
    handleFileChange: machineHandleFileChange,
  } = useMachineTree();

  const handleSSE = useCallback(
    (event: SSEEvent) => {
      if (event.type === "file-change") {
        if (event.campaignSlug === MACHINE_SLUG) {
          machineHandleFileChange(event);
        } else {
          handleFileChange(event);
        }
        lastFileChangeRef.current = event;

        // If the changed file is currently selected, refresh content
        const isSelectedMachineFile =
          selectedScope === "machine" &&
          event.campaignSlug === MACHINE_SLUG &&
          event.relativePath === selectedFile;
        const isSelectedCampaignFile =
          selectedScope === "campaign" &&
          event.campaignSlug === selectedCampaign &&
          event.relativePath === selectedFile;

        if (isSelectedMachineFile || isSelectedCampaignFile) {
          setRefreshKey((k) => k + 1);
        }
      } else if (event.type === "campaign-change") {
        // Re-fetch campaign list when campaigns are added/removed
        setCampaignRefreshKey((k) => k + 1);
      }
    },
    [handleFileChange, machineHandleFileChange, selectedCampaign, selectedFile, selectedScope],
  );

  useSSE(handleSSE);

  const handleSelectFile = useCallback(
    (relativePath: string) => {
      setSelectedFile(relativePath);
      setSelectedScope("campaign");
      saveStored(STORAGE_KEY_FILE, relativePath);
      markRead(relativePath);
      setRefreshKey((k) => k + 1);
    },
    [markRead],
  );

  const handleSelectMachineFile = useCallback(
    (relativePath: string) => {
      setSelectedFile(relativePath);
      setSelectedScope("machine");
      saveStored(STORAGE_KEY_FILE, relativePath);
      machineMarkRead(relativePath);
      setRefreshKey((k) => k + 1);
    },
    [machineMarkRead],
  );

  const handleCampaignChange = useCallback((slug: string | null) => {
    setSelectedCampaign(slug);
    setSelectedFile(null);
    setSelectedScope("campaign");
    saveStored(STORAGE_KEY_CAMPAIGN, slug);
    saveStored(STORAGE_KEY_FILE, null);
  }, []);

  // Get category of selected file (check both campaign and machine trees)
  const selectedCategory = selectedScope === "machine"
    ? machineGroups.flatMap((g) => g.entries).find((e) => e.relativePath === selectedFile)?.category ?? null
    : groups.flatMap((g) => g.entries).find((e) => e.relativePath === selectedFile)?.category ?? null;

  // Navigate wikilinks: search for matching entity files
  const handleNavigate = useCallback(
    (target: string) => {
      const slug = target.toLowerCase().replace(/\s+/g, "-");
      const allEntries = groups.flatMap((g) => g.entries);
      const match = allEntries.find(
        (e) =>
          e.relativePath.includes(slug) ||
          e.relativePath.toLowerCase().includes(target.toLowerCase()),
      );
      if (match) {
        handleSelectFile(match.relativePath);
      }
    },
    [groups, handleSelectFile],
  );

  // Resolve the effective slug for ContentPane fetches
  const effectiveSlug = selectedScope === "machine" ? MACHINE_SLUG : selectedCampaign;

  return (
    <>
      <div className="app-header">
        <h1>Campaign Explorer</h1>
        {campaignsLoading ? (
          <span style={{ color: "var(--text-muted)" }}>Loading...</span>
        ) : (
          <CampaignSelector
            campaigns={campaigns}
            selected={selectedCampaign}
            onChange={handleCampaignChange}
          />
        )}
      </div>
      <div className="app-body">
        <div className="sidebar">
          {/* Machine-scope files — always visible */}
          {!machineLoading && machineGroups.length > 0 && (
            <div className="machine-section">
              <div className="machine-section-header">Machine</div>
              <FileTree
                groups={machineGroups}
                selectedFile={selectedScope === "machine" ? selectedFile : null}
                updatedItems={machineUpdatedItems}
                campaignSlug={MACHINE_SLUG}
                onSelectFile={handleSelectMachineFile}
                lastFileChange={lastFileChangeRef.current}
              />
            </div>
          )}
          {/* Campaign-scope files */}
          {treeLoading ? (
            <div className="loading">Loading tree...</div>
          ) : selectedCampaign ? (
            <FileTree
              groups={groups}
              selectedFile={selectedScope === "campaign" ? selectedFile : null}
              updatedItems={updatedItems}
              campaignSlug={selectedCampaign}
              onSelectFile={handleSelectFile}
              lastFileChange={lastFileChangeRef.current}
            />
          ) : (
            <div className="loading">Select a campaign</div>
          )}
        </div>
        <ContentPane
          campaignSlug={effectiveSlug}
          selectedFile={selectedFile}
          fileCategory={selectedCategory}
          refreshKey={refreshKey}
          onNavigate={handleNavigate}
        />
      </div>
    </>
  );
}
