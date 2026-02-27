import { useState, useEffect, useCallback } from "react";
import type { TreeEntry, FileCategory, FileChangeEvent } from "../../shared/protocol";
import { CATEGORY_ORDER } from "../lib/categories";

export interface GroupedTree {
  category: FileCategory;
  entries: TreeEntry[];
}

/** Fetch and manage the file tree for a campaign. */
export function useFileTree(campaignSlug: string | null): {
  groups: GroupedTree[];
  loading: boolean;
  updatedItems: Set<string>;
  markRead: (relativePath: string) => void;
  handleFileChange: (event: FileChangeEvent) => void;
} {
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [updatedItems, setUpdatedItems] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!campaignSlug) {
      setEntries([]);
      return;
    }
    setLoading(true);
    fetch(`/api/campaigns/${campaignSlug}/tree`)
      .then((res) => res.json())
      .then((data: TreeEntry[]) => setEntries(data))
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, [campaignSlug]);

  const handleFileChange = useCallback(
    (event: FileChangeEvent) => {
      if (event.campaignSlug !== campaignSlug) return;

      if (event.changeType === "unlink") {
        setEntries((prev) => prev.filter((e) => e.relativePath !== event.relativePath));
      } else {
        setEntries((prev) => {
          const existing = prev.findIndex((e) => e.relativePath === event.relativePath);
          const newEntry: TreeEntry = {
            relativePath: event.relativePath,
            category: event.category,
            size: 0,
            mtime: new Date().toISOString(),
          };
          if (existing !== -1) {
            const updated = [...prev];
            updated[existing] = { ...updated[existing], mtime: newEntry.mtime };
            return updated;
          }
          return [...prev, newEntry];
        });
      }

      // Track updated items: file, category, and campaign level
      setUpdatedItems((prev) => {
        const next = new Set(prev);
        next.add(`${event.campaignSlug}:${event.relativePath}`);
        next.add(`${event.campaignSlug}:${event.category}`);
        next.add(event.campaignSlug);
        return next;
      });
    },
    [campaignSlug],
  );

  const markRead = useCallback(
    (relativePath: string) => {
      if (!campaignSlug) return;
      setUpdatedItems((prev) => {
        const next = new Set(prev);
        next.delete(`${campaignSlug}:${relativePath}`);

        // Check if category still has updated items
        const entry = entries.find((e) => e.relativePath === relativePath);
        if (entry) {
          const categoryKey = `${campaignSlug}:${entry.category}`;
          const hasOthers = [...next].some(
            (k) => k.startsWith(`${campaignSlug}:`) && k !== categoryKey && k !== campaignSlug,
          );
          if (!hasOthers) {
            next.delete(categoryKey);
            next.delete(campaignSlug);
          }
        }
        return next;
      });
    },
    [campaignSlug, entries],
  );

  // Group entries by category
  const groups: GroupedTree[] = CATEGORY_ORDER.map((cat) => ({
    category: cat,
    entries: entries
      .filter((e) => e.category === cat)
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
  })).filter((g) => g.entries.length > 0);

  return { groups, loading, updatedItems, markRead, handleFileChange };
}
