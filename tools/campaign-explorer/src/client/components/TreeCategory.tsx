import { useState, useEffect, useCallback } from "react";
import type { TreeEntry, FileCategory, FileChangeEvent } from "../../shared/protocol";
import { CATEGORY_LABELS, CATEGORY_COLORS } from "../lib/categories";
import { TreeItem } from "./TreeItem";
import { UpdateDot } from "./UpdateDot";

interface TreeCategoryProps {
  category: FileCategory;
  entries: TreeEntry[];
  selectedFile: string | null;
  updatedItems: Set<string>;
  campaignSlug: string;
  onSelectFile: (relativePath: string) => void;
  lastFileChange: FileChangeEvent | null;
}

export function TreeCategory({
  category,
  entries,
  selectedFile,
  updatedItems,
  campaignSlug,
  onSelectFile,
  lastFileChange,
}: TreeCategoryProps) {
  const [expanded, setExpanded] = useState(true);
  const [autoFollow, setAutoFollow] = useState(false);

  const hasUpdates = updatedItems.has(`${campaignSlug}:${category}`);

  // Auto-follow: when a file change arrives in this category, select it
  const handleAutoFollow = useCallback(
    (event: FileChangeEvent) => {
      if (
        autoFollow &&
        event.category === category &&
        event.changeType !== "unlink"
      ) {
        onSelectFile(event.relativePath);
      }
    },
    [autoFollow, category, onSelectFile],
  );

  useEffect(() => {
    if (lastFileChange) handleAutoFollow(lastFileChange);
  }, [lastFileChange, handleAutoFollow]);

  return (
    <div className="tree-category">
      <div
        className="tree-category-header"
        onClick={() => setExpanded(!expanded)}
      >
        <span className={`chevron${expanded ? " open" : ""}`}>&#9654;</span>
        <span style={{ color: CATEGORY_COLORS[category] }}>
          {CATEGORY_LABELS[category]}
        </span>
        <span className="tree-category-count">({entries.length})</span>
        <UpdateDot visible={hasUpdates} />
        <button
          className={`auto-follow-btn${autoFollow ? " active" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            setAutoFollow(!autoFollow);
          }}
          title={autoFollow ? "Auto-follow: ON" : "Auto-follow: OFF"}
        >
          {autoFollow ? "follow" : "follow"}
        </button>
      </div>
      {expanded &&
        entries.map((entry) => (
          <TreeItem
            key={entry.relativePath}
            relativePath={entry.relativePath}
            selected={selectedFile === entry.relativePath}
            updated={updatedItems.has(`${campaignSlug}:${entry.relativePath}`)}
            onClick={() => onSelectFile(entry.relativePath)}
          />
        ))}
    </div>
  );
}
