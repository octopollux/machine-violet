import type { FileChangeEvent } from "../../shared/protocol";
import type { GroupedTree } from "../hooks/useFileTree";
import { TreeCategory } from "./TreeCategory";

interface FileTreeProps {
  groups: GroupedTree[];
  error?: string | null;
  selectedFile: string | null;
  updatedItems: Set<string>;
  campaignSlug: string;
  onSelectFile: (relativePath: string) => void;
  lastFileChange: FileChangeEvent | null;
}

export function FileTree({
  groups,
  error,
  selectedFile,
  updatedItems,
  campaignSlug,
  onSelectFile,
  lastFileChange,
}: FileTreeProps) {
  if (error) return <div className="loading">{error}</div>;
  if (groups.length === 0) {
    return <div className="loading">No files found</div>;
  }

  return (
    <div>
      {groups.map((group) => (
        <TreeCategory
          key={group.category}
          category={group.category}
          entries={group.entries}
          selectedFile={selectedFile}
          updatedItems={updatedItems}
          campaignSlug={campaignSlug}
          onSelectFile={onSelectFile}
          lastFileChange={lastFileChange}
        />
      ))}
    </div>
  );
}
