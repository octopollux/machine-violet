import { useState, useEffect, useCallback } from "react";
import type { TreeEntry, FileChangeEvent } from "../../shared/protocol";
import { MACHINE_SLUG } from "../../shared/protocol";
import { CATEGORY_ORDER } from "../lib/categories";
import type { GroupedTree } from "./useFileTree";

/**
 * Fetch and manage the machine-scope file tree.
 * Machine-scope files (server.log, crash dumps) are always visible
 * regardless of the selected campaign.
 */
export function useMachineTree(): {
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
    setLoading(true);
    fetch("/api/machine/tree")
      .then((res) => res.json())
      .then((data: TreeEntry[]) => setEntries(data))
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, []);

  const handleFileChange = useCallback(
    (event: FileChangeEvent) => {
      if (event.campaignSlug !== MACHINE_SLUG) return;

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

      setUpdatedItems((prev) => {
        const next = new Set(prev);
        next.add(`${MACHINE_SLUG}:${event.relativePath}`);
        next.add(`${MACHINE_SLUG}:${event.category}`);
        next.add(MACHINE_SLUG);
        return next;
      });
    },
    [],
  );

  const markRead = useCallback(
    (relativePath: string) => {
      setUpdatedItems((prev) => {
        const next = new Set(prev);
        next.delete(`${MACHINE_SLUG}:${relativePath}`);
        const entry = entries.find((e) => e.relativePath === relativePath);
        if (entry) {
          const categoryFileKeys = entries
            .filter((e) => e.category === entry.category)
            .map((e) => `${MACHINE_SLUG}:${e.relativePath}`);
          if (!categoryFileKeys.some((k) => next.has(k))) {
            next.delete(`${MACHINE_SLUG}:${entry.category}`);
          }
          const anyUpdates = [...next].some(
            (k) => k.startsWith(`${MACHINE_SLUG}:`) && k !== MACHINE_SLUG,
          );
          if (!anyUpdates) next.delete(MACHINE_SLUG);
        }
        return next;
      });
    },
    [entries],
  );

  const groups: GroupedTree[] = CATEGORY_ORDER.map((cat) => ({
    category: cat,
    entries: entries
      .filter((e) => e.category === cat)
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
  })).filter((g) => g.entries.length > 0);

  return { groups, loading, updatedItems, markRead, handleFileChange };
}
