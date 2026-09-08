/** Colour bar legend, hover card and the orientation gizmo. */

import type { AttributeStats } from '../core/cloud';
import { LUT_SIZE, paintLUT, sampleLUT } from '../core/colormap';
import { denormalize } from '../core/state';
import { fmtNum, h } from './dom';
import { t } from '../i18n';

export class Legend {
  readonly el: HTMLElement;
  private track: HTMLCanvasElement;
  private scaleEl: HTMLElement;
  private footEl: HTMLElement;
  private handleLo: HTMLElement;
  private handleHi: HTMLElement;
  private hoverEl: HTMLElement;
  private lut: Uint8Array = new Uint8Array(LUT_SIZE * 3);
  private lo = 0;
  private hi = 1;
  private log = false;

  constructor() {
    this.track = h('canvas', { width: '15', height: '132' }) as HTMLCanvasElement;
    this.scaleEl = h('div', { class: 'legend-scale' });
    this.footEl = h('div', { class: 'legend-foot' });
    this.handleLo = h('div', { class: 'legend-handle' });
    this.handleHi = h('div', { class: 'legend-handle hi' });
    this.hoverEl = h('div', {
      style:
        'position:absolute;left:-4px;right:-4px;height:0;pointer-events:none;display:none;',
    });
    this.hoverEl.innerHTML =
      '<div style="position:absolute;left:0;right:0;top:-1px;height:2px;background:var(--overlay-handle);box-shadow:var(--overlay-handle-shadow)"></div>';

    const trackWrap = h('div', { class: 'legend-track' }, [this.track, this.handleLo, this.handleHi, this.hoverEl]);
    this.el = h('div', { class: 'hud legend' }, [
      h('div', { class: 'hud-title' }, [h('span', { text: t('legend.title') })]),
      h('div', { class: 'legend-body' }, [trackWrap, this.scaleEl]),
      this.footEl,
    ]);
    this.el.style.display = 'none';
    requestAnimationFrame(() => this.paint());
  }

  private paint(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = 15;
    const hh = 132;
    this.track.width = Math.round(w * dpr);
    this.track.height = Math.round(hh * dpr);
    const ctx = this.track.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paintLUT(ctx, this.lut, 0, 0, w, hh, true);
  }

  update(opts: {
    lut: Uint8Array;
    lo: number;
    hi: number;
    log: boolean;
    label: string;
    unit: string;
    stats: AttributeStats | null;
    visible: boolean;
  }): void {
    this.lut = opts.lut;
    this.lo = opts.lo;
    this.hi = opts.hi;
    this.log = opts.log;
    this.el.style.display = opts.visible ? '' : 'none';
    if (!opts.visible) return;

    this.paint();
    this.scaleEl.innerHTML = '';
    const ticks = 5;
    for (let i = 0; i < ticks; i++) {
      const t = 1 - i / (ticks - 1);
      const v = denormalize(t, this.lo, this.hi, this.log);
      this.scaleEl.appendChild(
        h('div', { class: 'legend-tick', style: `top:${(i / (ticks - 1)) * 100}%` }, [
          h('span', { text: fmtNum(v) }),
        ])
      );
    }

    this.footEl.innerHTML = '';
    this.footEl.appendChild(
      h('span', { class: 'truncate', title: opts.label, text: opts.label })
    );
    if (opts.unit) {
      this.footEl.appendChild(h('span', { class: 'mono dim', text: opts.unit }));
    }
    if (opts.stats) {
      this.footEl.appendChild(
        h('span', {
          class: 'mono dim',
          style: 'width:100%',
          title: t('legend.effectivePoints'),
          text: `${opts.stats.valid.toLocaleString()} pts`,
        })
      );
    }
  }

  setHoverValue(v: number | null): void {
    if (v === null || !Number.isFinite(v)) {
      this.hoverEl.style.display = 'none';
      return;
    }
    const t = (v - this.lo) / (this.hi - this.lo || 1);
    const pct = Math.max(0, Math.min(1, t)) * 100;
    this.hoverEl.style.display = '';
    this.hoverEl.style.top = `${100 - pct}%`;
  }

  setClipMarkers(loPct: number, hiPct: number): void {
    this.handleLo.style.top = `${100 - loPct * 100}%`;
    this.handleHi.style.top = `${100 - hiPct * 100}%`;
  }

  get visible(): boolean {
    return this.el.style.display !== 'none';
  }
}

/* ══════════════════════════════════════════════════════════════
   Hover card
   ══════════════════════════════════════════════════════════════ */

export interface HoverEntry {
  key: string;
  value: string;
  swatch?: string;
  strong?: boolean;
}

export class HoverCard {
  readonly el: HTMLElement;
  private container: HTMLElement;

  /** `el` is the card element (already in the DOM, e.g. #hoverCard); `container`
   *  is the element used as the bounds reference for keeping the card on-screen. */
  constructor(el: HTMLElement, container: HTMLElement) {
    this.el = el;
    this.container = container;
    this.el.hidden = true;
  }

  hide(): void {
    this.el.hidden = true;
  }

  show(x: number, y: number, title: string, entries: HoverEntry[]): void {
    this.el.innerHTML = '';
    this.el.appendChild(
      h('div', { class: 'hover-idx' }, [
        h('span', { text: title }),
        h('span', { class: 'mono', text: `#${entries.length}` }),
      ])
    );
    for (const e of entries) {
      this.el.appendChild(
        h('div', { class: 'hover-row' }, [
          h('span', { class: 'k', text: e.key }),
          h('span', { class: 'v' }, [
            e.swatch
              ? h('span', { class: 'hover-swatch', style: `background:${e.swatch}` })
              : null,
            h('span', { text: e.value }),
          ]),
        ])
      );
    }
    this.el.hidden = false;
    // Keep the card inside the viewport.
    const cw = this.container.clientWidth;
    const ch = this.container.clientHeight;
    const w = this.el.offsetWidth;
    const hh = this.el.offsetHeight;
    let left = x + 14;
    let top = y + 14;
    if (left + w > cw - 8) left = x - w - 14;
    if (top + hh > ch - 8) top = y - hh - 14;
    this.el.style.transform = 'none';
    this.el.style.left = `${Math.max(4, left)}px`;
    this.el.style.top = `${Math.max(4, top)}px`;
  }
}

/* ══════════════════════════════════════════════════════════════
   Orientation gizmo
   ══════════════════════════════════════════════════════════════ */

const AXES_DEF = [
  { key: 'X', dir: [1, 0, 0], color: '#f4575f' },
  // Source coordinates render as world XZY: Z is vertical, X/Y are horizontal.
  { key: 'Y', dir: [0, 0, 1], color: '#33cf85' },
  { key: 'Z', dir: [0, 1, 0], color: '#4d9bff' },
] as const;

export class AxisGizmo {
  readonly el: HTMLElement;
  private svg: SVGSVGElement;
  private nodes: { g: SVGGElement; line: SVGLineElement; dot: SVGCircleElement; text: SVGTextElement }[] = [];

  constructor() {
    const ns = 'http://www.w3.org/2000/svg';
    this.svg = document.createElementNS(ns, 'svg');
    this.svg.setAttribute('viewBox', '0 0 74 74');
    this.svg.setAttribute('class', 'gizmo');
    const size = 74;
    const cx = size / 2;
    const cy = size / 2;

    for (const a of AXES_DEF) {
      const g = document.createElementNS(ns, 'g');
      const line = document.createElementNS(ns, 'line');
      line.setAttribute('stroke', a.color);
      line.setAttribute('stroke-width', '1.8');
      line.setAttribute('stroke-linecap', 'round');
      const dot = document.createElementNS(ns, 'circle');
      dot.setAttribute('r', '8.5');
      dot.setAttribute('fill', a.color);
      dot.setAttribute('fill-opacity', '0.16');
      dot.setAttribute('stroke', a.color);
      dot.setAttribute('stroke-width', '1.4');
      const text = document.createElementNS(ns, 'text');
      text.textContent = a.key;
      text.setAttribute('fill', a.color);
      text.setAttribute('font-size', '9');
      text.setAttribute('font-weight', '700');
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('dominant-baseline', 'central');
      text.setAttribute('font-family', 'var(--font-mono)');
      g.appendChild(line);
      g.appendChild(dot);
      g.appendChild(text);
      this.svg.appendChild(g);
      this.nodes.push({ g, line, dot, text });
    }
    void cx;
    void cy;

    this.el = h('div', { class: 'hud', style: 'padding:2px' }, [this.svg]);
  }

  /** `basis` maps world axes to view space (camera.matrixWorldInverse rotation). */
  update(basis: number[]): void {
    const size = 74;
    const cx = size / 2;
    const cy = size / 2;
    const r = 26;
    const items = AXES_DEF.map((a, i) => {
      const [x, y, z] = a.dir;
      const vx = basis[0] * x + basis[4] * y + basis[8] * z;
      const vy = basis[1] * x + basis[5] * y + basis[9] * z;
      const vz = basis[2] * x + basis[6] * y + basis[10] * z;
      return { i, x: cx + vx * r, y: cy - vy * r, z: vz };
    }).sort((p, q) => p.z - q.z);

    items.forEach((it, order) => {
      const n = this.nodes[it.i];
      n.line.setAttribute('x1', String(cx));
      n.line.setAttribute('y1', String(cy));
      n.line.setAttribute('x2', String(it.x));
      n.line.setAttribute('y2', String(it.y));
      n.dot.setAttribute('cx', String(it.x));
      n.dot.setAttribute('cy', String(it.y));
      n.text.setAttribute('x', String(it.x));
      n.text.setAttribute('y', String(it.y));
      const fade = it.z < 0 ? 0.42 : 1;
      n.g.setAttribute('opacity', String(fade));
      n.g.parentNode?.appendChild(n.g); // re-append for paint order
      void order;
    });
  }
}

/* ══════════════════════════════════════════════════════════════
   Small viewport HUD
   ══════════════════════════════════════════════════════════════ */

export interface HudRow {
  /** Stable key used by `set()` — independent of the displayed language. */
  key: string;
  /** Translated label shown on the left of the row. */
  label: string;
}

export class InfoHud {
  readonly el: HTMLElement;
  private titleEl: HTMLElement;
  private rows = new Map<string, HTMLElement>();

  constructor(title: string, rows: HudRow[]) {
    this.titleEl = h('span', { text: title });
    const body = h('div', { class: 'hud-body' });
    for (const r of rows) {
      const row = h('div', { class: 'row', style: 'gap:8px;justify-content:space-between' }, [
        h('span', { class: 'dim', text: r.label }),
        h('span', { class: 'mono', text: '—' }),
      ]);
      this.rows.set(r.key, row.lastElementChild as HTMLElement);
      body.appendChild(row);
    }
    this.el = h('div', { class: 'hud' }, [
      h('div', { class: 'hud-title' }, [this.titleEl]),
      body,
    ]);
  }

  setTitle(title: string): void {
    this.titleEl.textContent = title;
  }

  set(key: string, value: string): void {
    const el = this.rows.get(key);
    if (el) el.textContent = value;
  }
}

/** Build a small colour chip string for a LUT sample. */
export function lutSwatch(lut: Uint8Array, t: number): string {
  const [r, g, b] = sampleLUT(lut, t);
  return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
}
