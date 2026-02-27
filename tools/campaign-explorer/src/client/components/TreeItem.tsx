import { UpdateDot } from "./UpdateDot";

interface TreeItemProps {
  relativePath: string;
  selected: boolean;
  updated: boolean;
  onClick: () => void;
}

export function TreeItem({ relativePath, selected, updated, onClick }: TreeItemProps) {
  // Show just the filename, with parent dir for context
  const parts = relativePath.split("/");
  const display = parts.length > 1
    ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}`
    : parts[0];

  return (
    <div
      className={`tree-item${selected ? " selected" : ""}`}
      onClick={onClick}
      title={relativePath}
    >
      <UpdateDot visible={updated} />
      <span className="filename">{display}</span>
    </div>
  );
}
