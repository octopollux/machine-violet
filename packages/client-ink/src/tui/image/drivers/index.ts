/**
 * Driver registry: maps a chosen graphics protocol to its driver.
 *
 * Returns null when the protocol has no driver, so the caller renders nothing
 * inline rather than crashing.
 */
import type { GraphicsProtocol } from "../capabilities.js";
import type { ImageDriver } from "./types.js";
import { sixelDriver } from "./sixel.js";
import { iterm2Driver } from "./iterm2.js";
import { kittyDriver } from "./kitty.js";

export function selectDriver(protocol: GraphicsProtocol): ImageDriver | null {
  switch (protocol) {
    case "sixel":
      return sixelDriver;
    case "iterm2":
      return iterm2Driver;
    case "kitty":
      return kittyDriver;
  }
}

export type { ImageDriver, PreparedImage } from "./types.js";
