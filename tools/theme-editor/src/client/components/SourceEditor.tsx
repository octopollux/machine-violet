interface SourceEditorProps {
  label: string;
  value: string;
  onChange: (next: string) => void;
  error?: string | null;
  rows?: number;
}

export function SourceEditor({ label, value, onChange, error, rows = 20 }: SourceEditorProps) {
  return (
    <div className="source-editor">
      <div className="source-editor-header">
        <label>{label}</label>
        {error && <span className="source-editor-error">{error}</span>}
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        spellCheck={false}
        className={error ? "has-error" : undefined}
      />
    </div>
  );
}
