/**
 * Kitty driver — verified at the escape-grammar level (the protocol contract):
 * transmit-once chunking, native source-crop placement, placement-only delete on
 * clear, and full-image delete on dispose.
 */
import { kittyDriver } from "./kitty.js";

const W = 8, H = 24;
const rgba = (): Buffer => Buffer.alloc(W * H * 4, 0x7f);

/** APC graphics escapes: `\x1b_G<keys>\x1b\\` or `\x1b_G<keys>;<payload>\x1b\\`. */
function apcs(s: string): { keys: string; payload: string }[] {
  // eslint-disable-next-line no-control-regex -- parsing APC graphics escapes
  return [...s.matchAll(/\x1b_G([^;\x1b]*)(?:;([^]*?))?\x1b\\/g)].map((m) => ({ keys: m[1], payload: m[2] ?? "" }));
}
const kv = (keys: string): Record<string, string> =>
  Object.fromEntries(keys.split(",").map((p) => p.split("=") as [string, string]));

describe("kittyDriver", () => {
  it("is a cheap (per-frame) encoder", () => {
    expect(kittyDriver.expensiveEncode).toBe(false);
  });

  it("transmits the raster once at prepare: f=32, correct dims, terminated by m=0", () => {
    let out = "";
    kittyDriver.prepare(rgba(), W, H, (s) => { out += s; }, 256);
    const escs = apcs(out);
    expect(escs.length).toBeGreaterThan(0);
    const first = kv(escs[0].keys);
    expect(first.f).toBe("32"); // raw RGBA
    expect(first.s).toBe(String(W));
    expect(first.v).toBe(String(H));
    expect(first.t).toBe("d");
    expect(escs[escs.length - 1].keys).toContain("m=0"); // final chunk
    // Reassembled base64 payload decodes to the full RGBA raster.
    const data = Buffer.from(escs.map((e) => e.payload).join(""), "base64");
    expect(data.length).toBe(W * H * 4);
  });

  it("places a native source crop for a band (x=0,y=top,w,h, single placement, no cursor move)", () => {
    const p = kittyDriver.prepare(rgba(), W, H, () => {}, 256);
    const place = kv(apcs(p.encodeBand(6, 12))[0].keys);
    expect(place.a).toBe("p");
    expect(place.x).toBe("0");
    expect(place.y).toBe("6");
    expect(place.w).toBe(String(W));
    expect(place.h).toBe("12");
    expect(place.p).toBe("1"); // fixed placement id → re-place replaces
    expect(place.C).toBe("1"); // don't move the cursor
  });

  it("returns empty string for a zero-height band", () => {
    const p = kittyDriver.prepare(rgba(), W, H, () => {}, 256);
    expect(p.encodeBand(0, 0)).toBe("");
  });

  it("clear() deletes placements but keeps image data (d=i)", () => {
    const p = kittyDriver.prepare(rgba(), W, H, () => {}, 256);
    const del = kv(apcs(p.clear!())[0].keys);
    expect(del.a).toBe("d");
    expect(del.d).toBe("i"); // lowercase → keep transmitted data
  });

  it("dispose() deletes the image data (d=I)", () => {
    const writes: string[] = [];
    const p = kittyDriver.prepare(rgba(), W, H, (s) => writes.push(s), 256);
    writes.length = 0; // discard transmit; capture only dispose's write
    p.dispose();
    const del = kv(apcs(writes.join(""))[0].keys);
    expect(del.a).toBe("d");
    expect(del.d).toBe("I"); // uppercase → free data
  });

  it("assigns a distinct image id to each prepared image", () => {
    const idOf = (s: string) => kv(apcs(s)[0].keys).i;
    let a = "", b = "";
    kittyDriver.prepare(rgba(), W, H, (s) => { a += s; }, 256);
    kittyDriver.prepare(rgba(), W, H, (s) => { b += s; }, 256);
    expect(idOf(a)).not.toBe(idOf(b));
  });
});
