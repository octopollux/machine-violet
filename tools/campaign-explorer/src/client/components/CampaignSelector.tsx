import type { CampaignInfo } from "../../shared/protocol";

interface CampaignSelectorProps {
  campaigns: CampaignInfo[];
  selected: string | null;
  onChange: (slug: string | null) => void;
}

export function CampaignSelector({
  campaigns,
  selected,
  onChange,
}: CampaignSelectorProps) {
  return (
    <div className="campaign-selector">
      <select
        value={selected ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">-- select campaign --</option>
        {campaigns.map((c) => (
          <option key={c.slug} value={c.slug}>
            {c.name}
          </option>
        ))}
      </select>
    </div>
  );
}
