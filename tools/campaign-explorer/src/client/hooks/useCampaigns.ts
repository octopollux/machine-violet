import { useState, useEffect } from "react";
import type { CampaignInfo } from "../../shared/protocol";

/** Fetch the list of campaigns from the API. */
export function useCampaigns(externalRefreshKey = 0): {
  campaigns: CampaignInfo[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [campaigns, setCampaigns] = useState<CampaignInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    setLoading(true);
    fetch("/api/campaigns")
      .then((res) => res.json())
      .then((data: CampaignInfo[]) => {
        setCampaigns(data);
        setError(null);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [refreshKey, externalRefreshKey]);

  return {
    campaigns,
    loading,
    error,
    refresh: () => setRefreshKey((k) => k + 1),
  };
}
