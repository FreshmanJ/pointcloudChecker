/**
 * Colormap library + colour-transfer utilities.
 *
 * A colormap is a list of stops (t, r, g, b) with t ∈ [0,1] and channels ∈ [0,1].
 * Everything downstream consumes a baked 256×3 LUT (`Uint8Array`).
 */

export interface ColorStop {
  t: number;
  r: number;
  g: number;
  b: number;
}

export interface ColormapDef {
  id: string;
  name: string;
  stops: ColorStop[];
  diverging?: boolean;
  builtin?: boolean;
}

export const LUT_SIZE = 256;

/* ────────── helpers ────────── */

function s(t: number, hex: string): ColorStop {
  return { t, ...hexToRgb01(hex) };
}

export function hexToRgb01(hex: string): { r: number; g: number; b: number } {
  let h = hex.trim().replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const v = parseInt(h, 16);
  return {
    r: ((v >> 16) & 255) / 255,
    g: ((v >> 8) & 255) / 255,
    b: (v & 255) / 255,
  };
}

export function rgb01ToHex(r: number, g: number, b: number): string {
  const c = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function rgbBytesToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/* ────────── built-in colormaps ────────── */

export const BUILTIN_COLORMAPS: ColormapDef[] = [
  {
    id: 'thermal',
    name: 'Thermal 温度',
    stops: [
      s(0.0, '#05061a'),
      s(0.15, '#3b0a6b'),
      s(0.35, '#8c1a6b'),
      s(0.55, '#d63a2f'),
      s(0.75, '#f79a1e'),
      s(0.9, '#ffe066'),
      s(1.0, '#fffdf0'),
    ],
  },
  {
    id: 'turbo',
    name: 'Turbo',
    stops: [
      s(0.0, '#30123b'),
      s(0.1, '#4145ab'),
      s(0.2, '#4676ed'),
      s(0.3, '#39a2fc'),
      s(0.4, '#1bcfd4'),
      s(0.5, '#24eca6'),
      s(0.6, '#61fc6c'),
      s(0.7, '#a4fc3b'),
      s(0.8, '#d1e834'),
      s(0.9, '#f3c63a'),
      s(1.0, '#7a0403'),
    ],
  },
  {
    id: 'viridis',
    name: 'Viridis',
    stops: [
      s(0.0, '#440154'),
      s(0.125, '#482878'),
      s(0.25, '#3e4989'),
      s(0.375, '#31688e'),
      s(0.5, '#26828e'),
      s(0.625, '#1f9e89'),
      s(0.75, '#35b779'),
      s(0.875, '#6ece58'),
      s(1.0, '#fde725'),
    ],
  },
  {
    id: 'inferno',
    name: 'Inferno',
    stops: [
      s(0.0, '#000004'),
      s(0.125, '#1b0c41'),
      s(0.25, '#4a0c6b'),
      s(0.375, '#781c6d'),
      s(0.5, '#a52c60'),
      s(0.625, '#cf4446'),
      s(0.75, '#ed6925'),
      s(0.875, '#fb9b06'),
      s(1.0, '#f7d13d'),
    ],
  },
  {
    id: 'magma',
    name: 'Magma',
    stops: [
      s(0.0, '#000004'),
      s(0.125, '#180f3d'),
      s(0.25, '#440f76'),
      s(0.375, '#721f81'),
      s(0.5, '#9e2f7f'),
      s(0.625, '#cd4071'),
      s(0.75, '#f1605d'),
      s(0.875, '#fd9668'),
      s(1.0, '#fcfdbf'),
    ],
  },
  {
    id: 'plasma',
    name: 'Plasma',
    stops: [
      s(0.0, '#0d0887'),
      s(0.125, '#41049d'),
      s(0.25, '#6a00a8'),
      s(0.375, '#8f0da4'),
      s(0.5, '#b12a90'),
      s(0.625, '#cc4778'),
      s(0.75, '#e16462'),
      s(0.875, '#f2844b'),
      s(1.0, '#f0f921'),
    ],
  },
  {
    id: 'cividis',
    name: 'Cividis',
    stops: [
      s(0.0, '#00224e'),
      s(0.25, '#35456c'),
      s(0.5, '#666970'),
      s(0.75, '#9d9d6a'),
      s(1.0, '#f9e721'),
    ],
  },
  {
    id: 'jet',
    name: 'Jet',
    stops: [
      s(0.0, '#00008f'),
      s(0.125, '#0000ff'),
      s(0.375, '#00ffff'),
      s(0.5, '#00ff80'),
      s(0.625, '#ffff00'),
      s(0.875, '#ff0000'),
      s(1.0, '#800000'),
    ],
  },
  {
    id: 'coolwarm',
    name: 'Cool–Warm',
    diverging: true,
    stops: [
      s(0.0, '#3b4cc0'),
      s(0.25, '#7b9ff0'),
      s(0.5, '#dddddd'),
      s(0.75, '#f0907a'),
      s(1.0, '#b40426'),
    ],
  },
  {
    id: 'spectral',
    name: 'Spectral',
    diverging: true,
    stops: [
      s(0.0, '#9e0142'),
      s(0.125, '#d53e4f'),
      s(0.25, '#f46d43'),
      s(0.375, '#fdae61'),
      s(0.5, '#fee08b'),
      s(0.625, '#e6f598'),
      s(0.75, '#abdda4'),
      s(0.875, '#66c2a5'),
      s(1.0, '#3288bd'),
    ],
  },
  {
    id: 'terrain',
    name: 'Terrain 高程',
    stops: [
      s(0.0, '#2c3393'),
      s(0.18, '#1f7fe0'),
      s(0.32, '#00d4aa'),
      s(0.46, '#7ddf4a'),
      s(0.62, '#d6c64a'),
      s(0.78, '#a06a3c'),
      s(1.0, '#fffaf0'),
    ],
  },
  {
    id: 'icefire',
    name: 'Ice–Fire',
    diverging: true,
    stops: [
      s(0.0, '#00c2ff'),
      s(0.25, '#5ce1e6'),
      s(0.5, '#12122b'),
      s(0.75, '#ff8c42'),
      s(1.0, '#ffdd55'),
    ],
  },
  {
    id: 'ocean',
    name: 'Ocean 深度',
    stops: [
      s(0.0, '#000b2e'),
      s(0.3, '#084081'),
      s(0.55, '#2b8cbe'),
      s(0.75, '#7fcdbb'),
      s(0.9, '#c7e9b4'),
      s(1.0, '#ffffd9'),
    ],
  },
  {
    id: 'grayscale',
    name: 'Grayscale',
    stops: [s(0.0, '#050505'), s(1.0, '#f5f7fa')],
  },
];

BUILTIN_COLORMAPS.forEach((m) => (m.builtin = true));

/* ────────── LUT baking ────────── */

export function sortStops(stops: ColorStop[]): ColorStop[] {
  return [...stops].sort((a, b) => a.t - b.t);
}

/** Bake stops into a `LUT_SIZE` × 3 RGB byte array, with optional post-processing. */
export function buildLUT(
  stops: ColorStop[],
  opts: { reverse?: boolean; steps?: number } = {}
): Uint8Array {
  const st = sortStops(stops);
  const lut = new Uint8Array(LUT_SIZE * 3);
  if (st.length === 0) return lut;
  if (st.length === 1) {
    for (let i = 0; i < LUT_SIZE; i++) {
      lut[i * 3] = Math.round(st[0].r * 255);
      lut[i * 3 + 1] = Math.round(st[0].g * 255);
      lut[i * 3 + 2] = Math.round(st[0].b * 255);
    }
    return lut;
  }

  const steps = opts.steps && opts.steps > 1 ? Math.floor(opts.steps) : 0;
  let cursor = 0;

  for (let i = 0; i < LUT_SIZE; i++) {
    let t = i / (LUT_SIZE - 1);
    if (opts.reverse) t = 1 - t;

    // Optional quantization into discrete bands.
    let tt = t;
    if (steps > 1) tt = Math.floor(t * steps) / (steps - 1);
    tt = Math.max(0, Math.min(1, tt));

    while (cursor < st.length - 2 && tt > st[cursor + 1].t) cursor++;
    while (cursor > 0 && tt < st[cursor].t) cursor--;

    const a = st[cursor];
    const b = st[Math.min(st.length - 1, cursor + 1)];
    const span = b.t - a.t;
    const f = span <= 1e-9 ? 0 : Math.max(0, Math.min(1, (tt - a.t) / span));

    lut[i * 3] = Math.round((a.r + (b.r - a.r) * f) * 255);
    lut[i * 3 + 1] = Math.round((a.g + (b.g - a.g) * f) * 255);
    lut[i * 3 + 2] = Math.round((a.b + (b.b - a.b) * f) * 255);
  }
  return lut;
}

export function sampleLUT(lut: Uint8Array, t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t)) * (LUT_SIZE - 1);
  const i0 = Math.floor(x);
  const i1 = Math.min(LUT_SIZE - 1, i0 + 1);
  const f = x - i0;
  const a = i0 * 3;
  const b = i1 * 3;
  return [
    lut[a] + (lut[b] - lut[a]) * f,
    lut[a + 1] + (lut[b + 1] - lut[a + 1]) * f,
    lut[a + 2] + (lut[b + 2] - lut[a + 2]) * f,
  ];
}

export function cssColorFromLUT(lut: Uint8Array, t: number): string {
  const [r, g, b] = sampleLUT(lut, t);
  return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
}

/** Paint a LUT horizontally into a canvas (used for previews & the legend). */
export function paintLUT(
  ctx: CanvasRenderingContext2D,
  lut: Uint8Array,
  x: number,
  y: number,
  w: number,
  h: number,
  vertical = false
): void {
  const img = ctx.createImageData(vertical ? 1 : LUT_SIZE, vertical ? LUT_SIZE : 1);
  for (let i = 0; i < LUT_SIZE; i++) {
    const src = vertical ? (LUT_SIZE - 1 - i) * 3 : i * 3;
    img.data[i * 4] = lut[src];
    img.data[i * 4 + 1] = lut[src + 1];
    img.data[i * 4 + 2] = lut[src + 2];
    img.data[i * 4 + 3] = 255;
  }
  const tmp = document.createElement('canvas');
  tmp.width = img.width;
  tmp.height = img.height;
  tmp.getContext('2d')!.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(tmp, x, y, w, h);
}

/* ────────── registry ────────── */

const registry = new Map<string, ColormapDef>();
BUILTIN_COLORMAPS.forEach((m) => registry.set(m.id, m));

export function registerColormap(def: ColormapDef): void {
  registry.set(def.id, def);
}

export function removeColormap(id: string): void {
  const d = registry.get(id);
  if (d && !d.builtin) registry.delete(id);
}

export function getColormap(id: string): ColormapDef | undefined {
  return registry.get(id);
}

export function allColormaps(): ColormapDef[] {
  return [...registry.values()];
}

export function builtinColormaps(): ColormapDef[] {
  return BUILTIN_COLORMAPS;
}

export function customColormaps(): ColormapDef[] {
  return [...registry.values()].filter((m) => !m.builtin);
}

/** Guess a sensible default colormap from an attribute name. */
export function guessColormapFor(name: string): string {
  const n = name.toLowerCase();
  if (/(temp|thermal|温度|°c|k$|_k\b)/.test(n)) return 'thermal';
  if (/(elev|height|alt|z$|高程|海拔)/.test(n)) return 'terrain';
  if (/(depth|bath|水深|深度)/.test(n)) return 'ocean';
  if (/(intensity|反射强度|强度)/.test(n)) return 'grayscale';
  if (/(error|residual|偏差|误差|deviation)/.test(n)) return 'coolwarm';
  if (/(curvature|roughness|曲率)/.test(n)) return 'spectral';
  return 'turbo';
}

/** Guess a display unit from an attribute name. */
export function guessUnitFor(name: string): string {
  const n = name.toLowerCase();
  if (/_k$/.test(n)) return 'K';
  if (/(temp|thermal|温度)/.test(n)) return '°C';
  if (/(intensity|反射强度)/.test(n)) return '';
  if (/(elev|height|alt|z$|高程|海拔|depth|水深|depth)/.test(n)) return 'm';
  if (/(dist|distance|距离|radius|半径)/.test(n)) return 'm';
  if (/(time|时间|gps)/.test(n)) return 's';
  if (/(angle|角度|scan_angle)/.test(n)) return '°';
  return '';
}
