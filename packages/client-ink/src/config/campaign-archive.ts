/**
 * Campaign archive types for the client.
 * Archive/delete operations are done server-side via REST.
 */

export interface ArchivedCampaignEntry {
  name: string;
  zipPath: string;
  archivedDate: string;
}

export interface CampaignDeleteInfo {
  campaignName: string;
  characterNames: string[];
  dmTurnCount: number;
}
