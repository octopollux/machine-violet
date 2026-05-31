/**
 * Driver registry: maps a chosen graphics protocol to its driver.
 *
 * Returns null when the protocol has no driver yet, so the caller renders
 * nothing inline rather than crashing. (kitty + iTerm2 land in a follow-up
 * step; until then only sixel is wired.)
 */
import type { GraphicsProtocol } from "../capabilities.js";
import type { ImageDriver } from "./types.js";
import { sixelDriver } from "./sixel.js";

export function selectDriver(protocol: GraphicsProtocol): ImageDriver | null {
  switch (protocol) {
    case "sixel":
      return sixelDriver;
    case "kitty":
    case "iterm2":
      return null; // implemented in step 4
  }
}

export type { ImageDriver, PreparedImage } from "./types.js";
