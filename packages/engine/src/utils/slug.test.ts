import { describe, it, expect } from "vitest";
import { slugify } from "./slug.js";

describe("slugify", () => {
  it("lowercases and collapses non-alnum runs to single hyphens", () => {
    expect(slugify("Janey Bruce")).toBe("janey-bruce");
    expect(slugify("Hello  World!")).toBe("hello-world");
    expect(slugify("Multi___under---score")).toBe("multi-under-score");
  });

  it("strips a single leading English article followed by whitespace", () => {
    expect(slugify("The Black Coin")).toBe("black-coin");
    expect(slugify("Black Coin")).toBe("black-coin");
    expect(slugify("A Hooded Figure")).toBe("hooded-figure");
    expect(slugify("An Old Tower")).toBe("old-tower");
  });

  it("does NOT strip 'the-' when no whitespace follows the article", () => {
    // This is deliberate — slugs that already contain "the-" as part of the
    // canonical slug (e.g. produced from "The-ory" or from a name where the
    // article wasn't at the start) must not be further mangled. Article
    // stripping is a display-name-only transform.
    expect(slugify("the-goblin-caves")).toBe("the-goblin-caves");
    expect(slugify("theory-of-everything")).toBe("theory-of-everything");
  });

  it("is idempotent on outputs produced by itself", () => {
    const inputs = ["Janey Bruce", "The Black Coin", "ring-of-power", "maren-crossing"];
    for (const input of inputs) {
      const once = slugify(input);
      expect(slugify(once)).toBe(once);
    }
  });

  it("caps at 50 characters", () => {
    const long = slugify("A Very Long Name That Exceeds Fifty Characters In Total Length Here");
    expect(long.length).toBeLessThanOrEqual(50);
  });

  it("falls back to entity-{hash} when the input has no ASCII alnum", () => {
    // Without the fallback these would produce "", and campaignPaths.character
    // would create hidden `.md` files that collide with each other.
    const whitespace = slugify("   ");
    expect(whitespace).toMatch(/^entity-[0-9a-f]{8}$/);

    const punct = slugify("!!!???");
    expect(punct).toMatch(/^entity-[0-9a-f]{8}$/);

    const nonAscii = slugify("花子");
    expect(nonAscii).toMatch(/^entity-[0-9a-f]{8}$/);
  });

  it("the fallback is deterministic — same input yields same slug", () => {
    expect(slugify("!!!")).toBe(slugify("!!!"));
    expect(slugify("花子")).toBe(slugify("花子"));
  });

  it("distinct empty-slug inputs map to distinct fallbacks", () => {
    // Not cryptographic, but any two distinct short strings should hash apart.
    expect(slugify("!!!")).not.toBe(slugify("???"));
    expect(slugify("花子")).not.toBe(slugify("太郎"));
  });

  it("the fallback itself slugifies to itself (idempotent)", () => {
    const fallback = slugify("!!!");
    expect(slugify(fallback)).toBe(fallback);
  });
});
