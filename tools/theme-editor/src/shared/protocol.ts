/** Shared types between the Theme Editor server and client. */

export interface ThemeAssetPayload {
  name: string;
  content: string;
}

export interface AssetsResponse {
  themes: ThemeAssetPayload[];
  playerFrames: ThemeAssetPayload[];
}
