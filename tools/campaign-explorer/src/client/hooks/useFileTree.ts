import { useState, useEffect, useCallback } from "react";
import type { TreeEntry, FileCategory, FileChangeEvent } from "../../shared/protocol";
import { CATEGORY_ORDER } from "../lib/categories";

export interface GroupedTree {
  category: FileCategory;
  entries: TreeEntry[];
}

/** Fetch and manage the file tree for a campaign. */
export function useFileTree(campaignSlug: string | null, selectedFile: string | null): {
  groups: GroupedTree[];
  loading: boolean;
  error: string | null;
  updatedItems: Set<string>;
  markRead: (relativePath: string) => void;
  handleFileChange: (event: FileChangeEvent) => void;
} {
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updatedItems, setUpdatedItems] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!campaignSlug) {
      setEntries([]);
      return;
    }
    setLoading(true);
    setError(null);
    let stale = false;
    fetch(`/api/campaigns/${campaignSlug}/tree`)
      .then(async (res) => { const data = await res.json(); if (!res.ok) throw new Error(data.error ?? "Cannot read campaign"); return data; })
      .then((data: TreeEntry[]) => { if (!stale) setEntries(data); })
      .catch((failure: Error) => { if (!stale) { setEntries([]); setError(failure.message); } })
      .finally(() => { if (!stale) setLoading(false); });
    return () => { stale = true; };
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
            ...event.entry,
          };
          if (existing !== -1) {
            const updated = [...prev];
            updated[existing] = { ...updated[existing], ...newEntry };
            return updated;
          }
          return [...prev, newEntry];
        });
      }

      // Track updated items — but skip if the file is already selected (auto-acknowledge)
      if (event.relativePath === selectedFile) return;

      setUpdatedItems((prev) => {
        const next = new Set(prev);
        next.add(`${event.campaignSlug}:${event.relativePath}`);
        next.add(`${event.campaignSlug}:${event.category}`);
        next.add(event.campaignSlug);
        return next;
      });
    },
    [campaignSlug, selectedFile],
  );

  const markRead = useCallback(
    (relativePath: string) => {
      if (!campaignSlug) return;
      setUpdatedItems((prev) => {
        const next = new Set(prev);
        const fileKey = `${campaignSlug}:${relativePath}`;
        next.delete(fileKey);

        // Check if this category still has any updated files
        const entry = entries.find((e) => e.relativePath === relativePath);
        if (entry) {
          const categoryKey = `${campaignSlug}:${entry.category}`;
          const categoryFileKeys = entries
            .filter((e) => e.category === entry.category)
            .map((e) => `${campaignSlug}:${e.relativePath}`);
          const categoryHasUpdates = categoryFileKeys.some((k) => next.has(k));
          if (!categoryHasUpdates) {
            next.delete(categoryKey);
          }

          // Check if any category still has updates
          const anyUpdates = [...next].some(
            (k) => k.startsWith(`${campaignSlug}:`) && k !== campaignSlug,
          );
          if (!anyUpdates) {
            next.delete(campaignSlug);
          }
        }
        return next;
      });
    },
    [campaignSlug, entries],
  );

  // Group entries by category
  const categories = [...new Set([...CATEGORY_ORDER, ...entries.map((entry) => entry.category)])];
  const groups: GroupedTree[] = categories.map((cat) => ({
    category: cat,
    entries: entries
      .filter((e) => e.category === cat)
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
  })).filter((g) => g.entries.length > 0);

  return { groups, loading, error, updatedItems, markRead, handleFileChange };
}
