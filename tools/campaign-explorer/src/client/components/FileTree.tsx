import type { FileChangeEvent } from "../../shared/protocol";
import type { GroupedTree } from "../hooks/useFileTree";
import { TreeCategory } from "./TreeCategory";

interface FileTreeProps {
  groups: GroupedTree[];
  selectedFile: string | null;
  updatedItems: Set<string>;
  campaignSlug: string;
  onSelectFile: (relativePath: string) => void;
  lastFileChange: FileChangeEvent | null;
}

export function FileTree({
  groups,
  selectedFile,
  updatedItems,
  campaignSlug,
  onSelectFile,
  lastFileChange,
}: FileTreeProps) {
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
