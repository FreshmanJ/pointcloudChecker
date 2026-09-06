/**
 * Non-destructive point filtering. Rules are evaluated against the *source*
 * cloud but expressed over view indices, so filters compose with downsampling.
 */

import type { CloudView } from './cloud';
import { quantileOf, uid } from './cloud';
import { t } from '../i18n';

export type FilterMode = 'range' | 'set';

export interface FilterRule {
  id: string;
  enabled: boolean;
  /** `axis` targets x/y/z, `attr` targets a named scalar. */
  kind: 'axis' | 'attr';
  /** 'x' | 'y' | 'z' for axis rules; the attribute name otherwise. */
  field: string;
  mode: FilterMode;
  /** Inclusive range for `range` mode. */
  min: number;
  max: number;
  /** Allowed values for `set` mode (integers, e.g. LAS classification codes). */
  set: number[];
  /** Keep the complement of the predicate. */
  invert: boolean;
}

export type FilterLogic = 'and' | 'or';

export const AXIS_LABELS: Record<string, string> = { x: 'X', y: 'Y', z: 'Z' };

export function createRule(kind: 'axis' | 'attr', field: string, min: number, max: number): FilterRule {
  return {
    id: uid('r'),
    enabled: true,
    kind,
    field,
    mode: 'range',
    min,
    max,
    set: [],
    invert: false,
  };
}

/** Resolve the raw value array backing a rule (length = view.count, already sliced). */
function ruleValues(view: CloudView, rule: FilterRule): Float32Array | null {
  if (rule.kind === 'axis') {
    const pos = view.positions;
    const axis = rule.field === 'x' ? 0 : rule.field === 'y' ? 1 : 2;
    const out = new Float32Array(view.count);
    for (let i = 0, p = axis; i < view.count; i++, p += 3) out[i] = pos[p];
    return out;
  }
  return view.values(rule.field);
}

/**
 * Apply rules to a view. Disabled rules are skipped.
 * When `logic` is 'or' a point survives if *any* enabled rule accepts it.
 */
export function applyFilters(view: CloudView, rules: FilterRule[], logic: FilterLogic): Uint32Array {
  const active = rules.filter((r) => r.enabled);
  const n = view.count;
  if (active.length === 0 || n === 0) return view.indices.slice();

  const masks: Uint8Array[] = [];
  for (const rule of active) {
    const arr = ruleValues(view, rule);
    const mask = new Uint8Array(n);
    if (!arr) {
      masks.push(mask);
      continue;
    }
    if (rule.mode === 'set') {
      const allowed = new Set(rule.set);
      for (let i = 0; i < n; i++) {
        const v = arr[i];
        const hit = Number.isFinite(v) && allowed.has(Math.round(v));
        mask[i] = (rule.invert ? !hit : hit) ? 1 : 0;
      }
    } else {
      const lo = Math.min(rule.min, rule.max);
      const hi = Math.max(rule.min, rule.max);
      for (let i = 0; i < n; i++) {
        const v = arr[i];
        const hit = Number.isFinite(v) && v >= lo && v <= hi;
        mask[i] = (rule.invert ? !hit : hit) ? 1 : 0;
      }
    }
    masks.push(mask);
  }

  const out = new Uint32Array(n);
  let k = 0;
  if (logic === 'or') {
    for (let i = 0; i < n; i++) {
      let keep = false;
      for (let m = 0; m < masks.length; m++) {
        if (masks[m][i]) { keep = true; break; }
      }
      if (keep) out[k++] = view.indices[i];
    }
  } else {
    for (let i = 0; i < n; i++) {
      let keep = true;
      for (let m = 0; m < masks.length; m++) {
        if (!masks[m][i]) { keep = false; break; }
      }
      if (keep) out[k++] = view.indices[i];
    }
  }
  return out.subarray(0, k);
}

export function describeRule(rule: FilterRule, unit = ''): string {
  const name = rule.kind === 'axis' ? `${AXIS_LABELS[rule.field] ?? rule.field}${t('filter.axisCoord')}` : rule.field;
  const u = unit ? ` ${unit}` : '';
  const act = rule.invert ? t('filter.exclude') : t('filter.keep');
  if (rule.mode === 'set') {
    const list = rule.set.length ? rule.set.join(', ') : '∅';
    return t('filter.ruleSet', { act, name, set: list });
  }
  const lo = fmt(rule.min);
  const hi = fmt(rule.max);
  return t('filter.ruleRange', { act, name, lo: `${lo}${u}`, hi: `${hi}${u}` });
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e6)) return v.toExponential(2);
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(Math.min(4, Math.max(1, 4 - Math.floor(Math.log10(a + 1e-12)))));
}

/** Quick preset: the value band that contains the `lo`…`hi` quantile range. */
export function quantileRange(
  view: CloudView,
  field: string,
  lo = 0.01,
  hi = 0.99
): [number, number] {
  const st = view.stats(field);
  if (!st) return [0, 1];
  return [quantileOf(st, lo), quantileOf(st, hi)];
}
