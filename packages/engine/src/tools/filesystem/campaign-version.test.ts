import { assertSupportedCampaign,createDefaultCampaignConfig,validateConfig } from "./config.js";
import { CAMPAIGN_FORMAT_VERSION } from "@machine-violet/shared/types/config.js";
describe("campaign format break",()=>{
  it("accepts only the current campaign format",()=>{
    const config=createDefaultCampaignConfig("New","Player","Character");
    expect(config.version).toBe(CAMPAIGN_FORMAT_VERSION);
    expect(()=>assertSupportedCampaign(config)).not.toThrow();
    expect(validateConfig(config)).toEqual([]);
    for(const version of [undefined,1,999,"2"]) {
      const old={...config,version};
      expect(()=>assertSupportedCampaign(old)).toThrow("Create a new campaign");
      expect(validateConfig(old).join(" ")).toContain("not supported");
      expect(old.version).toBe(version);
    }
  });
});
