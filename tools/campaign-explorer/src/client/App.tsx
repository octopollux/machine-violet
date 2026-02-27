import { useState, useCallback, useRef } from "react";
import { useCampaigns } from "./hooks/useCampaigns";
import { useFileTree } from "./hooks/useFileTree";
import { useSSE } from "./hooks/useSSE";
import { CampaignSelector } from "./components/CampaignSelector";
import { FileTree } from "./components/FileTree";
import { ContentPane } from "./components/ContentPane";
import type { SSEEvent, FileChangeEvent } from "../shared/protocol";

export function App() {
  const { campaigns, loading: campaignsLoading } = useCampaigns();
  const [selectedCampaign, setSelectedCampaign] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const lastFileChangeRef = useRef<FileChangeEvent | null>(null);

  const { groups, loading: treeLoading, updatedItems, markRead, handleFileChange } =
    useFileTree(selectedCampaign);

  const handleSSE = useCallback(
    (event: SSEEvent) => {
      if (event.type === "file-change") {
        handleFileChange(event);
        lastFileChangeRef.current = event;

        // If the changed file is currently selected, refresh content
        if (
          event.campaignSlug === selectedCampaign &&
          event.relativePath === selectedFile
        ) {
          setRefreshKey((k) => k + 1);
        }
      }
    },
    [handleFileChange, selectedCampaign, selectedFile],
  );

  useSSE(handleSSE);

  const handleSelectFile = useCallback(
    (relativePath: string) => {
      setSelectedFile(relativePath);
      markRead(relativePath);
      setRefreshKey((k) => k + 1);
    },
    [markRead],
  );

  const handleCampaignChange = useCallback((slug: string | null) => {
    setSelectedCampaign(slug);
    setSelectedFile(null);
  }, []);

  // Get category of selected file
  const selectedCategory =
    groups
      .flatMap((g) => g.entries)
      .find((e) => e.relativePath === selectedFile)?.category ?? null;

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
          {treeLoading ? (
            <div className="loading">Loading tree...</div>
          ) : selectedCampaign ? (
            <FileTree
              groups={groups}
              selectedFile={selectedFile}
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
          campaignSlug={selectedCampaign}
          selectedFile={selectedFile}
          fileCategory={selectedCategory}
          refreshKey={refreshKey}
          onNavigate={handleNavigate}
        />
      </div>
    </>
  );
}
