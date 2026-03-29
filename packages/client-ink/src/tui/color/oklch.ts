/**
 * OKLCH ↔ sRGB conversion via Oklab intermediate.
 * Reference: Björn Ottosson — https://bottosson.github.io/posts/oklab/
 */

export interface OklchColor {
  L: number; // Lightness [0, 1]
  C: number; // Chroma   [0, ~0.37]
  H: number; // Hue      [0, 360)
}

export interface RgbColor {
  r: number; // [0, 1]
  g: number; // [0, 1]
  b: number; // [0, 1]
}

// --- Linear sRGB ↔ sRGB gamma ---

function linearToSrgb(c: number): number {
  if (c <= 0.0031308) return 12.92 * c;
  return 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function srgbToLinear(c: number): number {
  if (c <= 0.04045) return c / 12.92;
  return Math.pow((c + 0.055) / 1.055, 2.4);
}

// --- Oklab ↔ Linear sRGB ---

interface OklabColor {
  L: number;
  a: number;
  b: number;
}

function linearRgbToOklab(rgb: RgbColor): OklabColor {
  const l = 0.4122214708 * rgb.r + 0.5363325363 * rgb.g + 0.0514459929 * rgb.b;
  const m = 0.2119034982 * rgb.r + 0.6806995451 * rgb.g + 0.1073969566 * rgb.b;
  const s = 0.0883024619 * rgb.r + 0.2817188376 * rgb.g + 0.6299787005 * rgb.b;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  return {
    L: 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  };
}

function oklabToLinearRgb(lab: OklabColor): RgbColor {
  const l_ = lab.L + 0.3963377774 * lab.a + 0.2158037573 * lab.b;
  const m_ = lab.L - 0.1055613458 * lab.a - 0.0638541728 * lab.b;
  const s_ = lab.L - 0.0894841775 * lab.a - 1.2914855480 * lab.b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  return {
    r: +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  };
}

// --- OKLCH ↔ Oklab ---

function oklchToOklab(oklch: OklchColor): OklabColor {
  const hRad = (oklch.H * Math.PI) / 180;
  return {
    L: oklch.L,
    a: oklch.C * Math.cos(hRad),
    b: oklch.C * Math.sin(hRad),
  };
}

function oklabToOklch(lab: OklabColor): OklchColor {
  const C = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
  let H = (Math.atan2(lab.b, lab.a) * 180) / Math.PI;
  if (H < 0) H += 360;
  return { L: lab.L, C, H };
}

// --- Gamut check & clamping ---

function isInGamut(rgb: RgbColor, epsilon = 1e-6): boolean {
  return (
    rgb.r >= -epsilon && rgb.r <= 1 + epsilon &&
    rgb.g >= -epsilon && rgb.g <= 1 + epsilon &&
    rgb.b >= -epsilon && rgb.b <= 1 + epsilon
  );
}

function clampChannel(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Gamut-clamp an OKLCH color into sRGB by binary-searching chroma reduction.
 * Preserves L and H, reduces C until the color fits.
 */
export function gamutClamp(oklch: OklchColor): OklchColor {
  const lab = oklchToOklab(oklch);
  const rgb = oklabToLinearRgb(lab);
  if (isInGamut(rgb)) return oklch;

  let lo = 0;
  let hi = oklch.C;
  let best: OklchColor = { L: oklch.L, C: 0, H: oklch.H };

  for (let i = 0; i < 32; i++) {
    const mid = (lo + hi) / 2;
    const candidate: OklchColor = { L: oklch.L, C: mid, H: oklch.H };
    const candidateRgb = oklabToLinearRgb(oklchToOklab(candidate));
    if (isInGamut(candidateRgb)) {
      best = candidate;
      lo = mid;
    } else {
      hi = mid;
    }
  }

  return best;
}

// --- Public API ---

/** Convert OKLCH to hex sRGB string (e.g. "#ff8800"). Gamut-clamps automatically. */
export function oklchToHex(oklch: OklchColor): string {
  const clamped = gamutClamp(oklch);
  const lab = oklchToOklab(clamped);
  const rgb = oklabToLinearRgb(lab);

  const r = Math.round(clampChannel(linearToSrgb(rgb.r)) * 255);
  const g = Math.round(clampChannel(linearToSrgb(rgb.g)) * 255);
  const b = Math.round(clampChannel(linearToSrgb(rgb.b)) * 255);

  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

/** Convert hex sRGB (e.g. "#ff8800" or "ff8800") to OKLCH. */
export function hexToOklch(hex: string): OklchColor {
  const h = hex.replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`Invalid hex color: ${hex}`);

  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;

  const linearRgb: RgbColor = {
    r: srgbToLinear(r),
    g: srgbToLinear(g),
    b: srgbToLinear(b),
  };

  const lab = linearRgbToOklab(linearRgb);
  return oklabToOklch(lab);
}

/** Convert hex to RGB triplet [0-255]. */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace(/^#/, "");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}
