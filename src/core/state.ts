/**
 * Central application state + derived value mapping.
 */

import type { AttributeStats, CloudView, PointCloudData } from './cloud';
import { quantileOf } from './cloud';
import type { ValidationResult } from './validate';
import type { DownsampleOptions } from './downsample';
import { DOWNSAMPLE_DEFAULTS } from './downsample';
import type { FilterLogic, FilterRule } from './filters';
import type { ProfileResult } from './profile';
import { PROFILE_DEFAULTS } from './profile';
import type { ColorMode, GridPlane, PointShape, SizeMode } from '../render/Viewer';

export type InteractMode = 'orbit' | 'measure';

export interface RangeMapping {
  auto: boolean;
  min: number;
  max: number;
  /** Percent of points clipped at each end (0 – 40). */
  clipLow: number;
  clipHigh: number;
  log: boolean;
  /** Force a zero-centred range (handy for diverging maps). */
  symmetric: boolean;
}

export interface RenderState {
  colorMode: ColorMode;
  attribute: string;
  uniformColor: string;
  pointSize: number;
  sizeMode: SizeMode;
  shape: PointShape;
  opacity: number;
  colormapId: string;
  reverse: boolean;
  steps: number;
  background: string;
  grid: GridPlane;
  showBox: boolean;
  showAxes: boolean;
  colorGain: number;
  turntable: boolean;
  range: RangeMapping;
}

export interface MeasureRecord {
  id: string;
  a: [number, number, number];
  b: [number, number, number];
  field: string;
  length: number;
  sampled: number;
  at: number;
}

export type Vec3 = [number, number, number];

export interface MeasureState {
  active: boolean;
  /** Picked endpoint coordinates (stable across filtering / downsampling). */
  a: Vec3 | null;
  b: Vec3 | null;
  aLabel: string;
  bLabel: string;
  field: string;
  radius: number;
  bins: number;
  smooth: number;
  history: MeasureRecord[];
  activeId: string | null;
}

export interface FileInfo {
  name: string;
  size: number;
  format: string;
  parseMs: number;
}

export interface UiState {
  leftTab: string;
  rightTab: string;
  dockTab: string;
  leftOpen: boolean;
  rightOpen: boolean;
  dockOpen: boolean;
  dockHeight: number;
  mode: InteractMode;
}

export interface AppState {
  stage: 'empty' | 'loading' | 'ready';
  source: PointCloudData | null;
  /** After downsampling, before filtering. */
  baseView: CloudView | null;
  /** After filtering — what is rendered and analysed. */
  view: CloudView | null;
  fileInfo: FileInfo | null;
  validation: ValidationResult | null;
  render: RenderState;
  downsample: DownsampleOptions;
  autoDownsample: boolean;
  filters: { rules: FilterRule[]; logic: FilterLogic };
  measure: MeasureState;
  profile: ProfileResult | null;
  hoverIndex: number | null;
  ui: UiState;
}

export function initialState(): AppState {
  return {
    stage: 'empty',
    source: null,
    baseView: null,
    view: null,
    fileInfo: null,
    validation: null,
    render: {
      colorMode: 'attribute',
      attribute: '',
      uniformColor: '#9fb4d0',
      pointSize: 2.2,
      sizeMode: 'fixed',
      shape: 'circle',
      opacity: 1,
      colormapId: 'turbo',
      reverse: false,
      steps: 0,
      background: '#0a0d12',
      grid: 'none',
      showBox: false,
      showAxes: false,
      colorGain: 1,
      turntable: false,
      range: {
        auto: true,
        min: 0,
        max: 1,
        clipLow: 1,
        clipHigh: 1,
        log: false,
        symmetric: false,
      },
    },
    downsample: { ...DOWNSAMPLE_DEFAULTS },
    autoDownsample: true,
    filters: { rules: [], logic: 'and' },
    measure: {
      active: false,
      a: null,
      b: null,
      aLabel: '',
      bLabel: '',
      field: '',
      radius: 0,
      bins: PROFILE_DEFAULTS.bins,
      smooth: 0,
      history: [],
      activeId: null,
    },
    profile: null,
    hoverIndex: null,
    ui: {
      leftTab: 'display',
      rightTab: 'file',
      dockTab: 'stats',
      leftOpen: true,
      rightOpen: true,
      dockOpen: true,
      dockHeight: 232,
      mode: 'orbit',
    },
  };
}

/* ══════════════════════════════════════════════════════════════
   Store
   ══════════════════════════════════════════════════════════════ */

export type StoreEvent =
  | 'cloud'      // a different cloud / view is active
  | 'render'     // appearance changed
  | 'range'      // colour range changed
  | 'filters'    // filter set changed
  | 'measure'    // measurement changed
  | 'profile'
  | 'hover'
  | 'ui'
  | 'meta';

type Listener = (events: Set<StoreEvent>) => void;

export class Store {
  state: AppState = initialState();
  private listeners = new Set<Listener>();

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(...events: StoreEvent[]): void {
    const set = new Set(events);
    for (const fn of this.listeners) fn(set);
  }
}

/* ══════════════════════════════════════════════════════════════
   Value mapping
   ══════════════════════════════════════════════════════════════ */

export interface EffectiveRange {
  lo: number;
  hi: number;
  dataMin: number;
  dataMax: number;
  clipped: boolean;
}

export function effectiveRange(
  mapping: RangeMapping,
  stats: AttributeStats | null
): EffectiveRange {
  const dataMin = stats?.min ?? mapping.min;
  const dataMax = stats?.max ?? mapping.max;

  if (!mapping.auto) {
    let lo = mapping.min;
    let hi = mapping.max;
    if (mapping.symmetric) {
      const m = Math.max(Math.abs(lo), Math.abs(hi));
      lo = -m;
      hi = m;
    }
    if (hi <= lo) hi = lo + 1e-9;
    return { lo, hi, dataMin, dataMax, clipped: false };
  }

  if (!stats) return { lo: dataMin, hi: dataMax || 1, dataMin, dataMax, clipped: false };

  let lo = quantileOf(stats, mapping.clipLow / 100);
  let hi = quantileOf(stats, 1 - mapping.clipHigh / 100);
  if (mapping.symmetric) {
    const m = Math.max(Math.abs(lo), Math.abs(hi));
    lo = -m;
    hi = m;
  }
  if (!(hi > lo)) {
    lo = stats.min;
    hi = stats.max || stats.min + 1;
  }
  return {
    lo, hi, dataMin: stats.min, dataMax: stats.max,
    clipped: mapping.clipLow > 0 || mapping.clipHigh > 0,
  };
}

/** Normalise raw values into [0,1] according to the mapping (log-aware). */
export function normalizeValues(
  raw: Float32Array,
  lo: number,
  hi: number,
  log: boolean,
  out?: Float32Array
): Float32Array {
  const n = raw.length;
  const dst = out && out.length === n ? out : new Float32Array(n);
  const span = hi - lo || 1;
  if (log) {
    const minShift = lo > 0 ? 0 : 1 - lo;
    const denom = Math.log(hi + minShift) - Math.log(lo + minShift) || 1;
    for (let i = 0; i < n; i++) {
      const v = raw[i];
      if (!Number.isFinite(v)) { dst[i] = 0; continue; }
      let t = (Math.log(v + minShift) - Math.log(lo + minShift)) / denom;
      dst[i] = t < 0 ? 0 : t > 1 ? 1 : t;
    }
  } else {
    const inv = 1 / span;
    for (let i = 0; i < n; i++) {
      const v = raw[i];
      if (!Number.isFinite(v)) { dst[i] = 0; continue; }
      const t = (v - lo) * inv;
      dst[i] = t < 0 ? 0 : t > 1 ? 1 : t;
    }
  }
  return dst;
}

/** Inverse of `normalizeValues` — used for colour-bar ticks. */
export function denormalize(t: number, lo: number, hi: number, log: boolean): number {
  if (log) {
    const minShift = lo > 0 ? 0 : 1 - lo;
    const a = Math.log(lo + minShift);
    const b = Math.log(hi + minShift);
    return Math.exp(a + (b - a) * t) - minShift;
  }
  return lo + (hi - lo) * t;
}
