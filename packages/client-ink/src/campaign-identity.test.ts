import { campaignLabel, NO_CAMPAIGN } from "./campaign-identity.js";

describe("campaignLabel", () => {
  it("prefers the server snapshot's name", () => {
    expect(campaignLabel("The Thirteenth Key", { id: "the-thirteenth-key", name: "handoff name" }))
      .toBe("The Thirteenth Key");
  });

  it("falls back to the locally-known name before the first snapshot", () => {
    expect(campaignLabel(undefined, { id: "the-thirteenth-key", name: "The Thirteenth Key" }))
      .toBe("The Thirteenth Key");
  });

  it("falls back to the slug when only the id is known (resume)", () => {
    expect(campaignLabel(undefined, { id: "the-thirteenth-key", name: "" }))
      .toBe("the-thirteenth-key");
  });

  it("renders nothing when there is no campaign (menu, setup conversation)", () => {
    expect(campaignLabel(undefined, NO_CAMPAIGN)).toBe("");
  });

  // The teardown snapshot the server broadcasts from endSession() carries
  // campaignName: "" and can land after the client's own reset. Treating it
  // as authoritative would blank a title the fallbacks can still fill.
  it("treats an empty snapshot name as absent, not as an override", () => {
    expect(campaignLabel("", { id: "the-thirteenth-key", name: "The Thirteenth Key" }))
      .toBe("The Thirteenth Key");
  });
});
