/** Canvas line chart for section profiles. */

import type { ProfileResult } from '../core/profile';
import { fmtNum } from './dom';

export interface ChartTheme {
  bg: string;
  grid: string;
  axis: string;
  text: string;
  line: string;
  band: string;
  scatter: string;
  accent: string;
}

const DARK_THEME: ChartTheme = {
  bg: '#0e1218',
  grid: '#1c2431',
  axis: '#2c3646',
  text: '#8a97a8',
  line: '#4dd2ff',
  band: 'rgba(77, 210, 255, 0.16)',
  scatter: 'rgba(160, 178, 200, 0.30)',
  accent: '#ffd54a',
};

const LIGHT_THEME: ChartTheme = {
  bg: '#ffffff',
  grid: '#e8ecf1',
  axis: '#c5cdd8',
  text: '#5a6577',
  line: '#0891b2',
  band: 'rgba(8, 145, 178, 0.10)',
  scatter: 'rgba(90, 110, 140, 0.22)',
  accent: '#d97706',
};

function currentTheme(): ChartTheme {
  return document.documentElement.getAttribute('data-theme') === 'light'
    ? LIGHT_THEME : DARK_THEME;
}

export interface ChartHover {
  distance: number;
  value: number;
  bin: number;
}

export class ProfileChart {
  readonly el: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private res: ProfileResult | null = null;
  private unit = '';
  private fieldLabel = '';
  private hover: ChartHover | null = null;
  private dpr = 1;
  private pad = { l: 54, r: 14, t: 14, b: 26 };
  onHover?: (h: ChartHover | null) => void;

  constructor() {
    this.el = document.createElement('canvas');
    this.el.style.display = 'block';
    this.el.style.width = '100%';
    this.el.style.height = '100%';
    this.ctx = this.el.getContext('2d')!;

    this.el.addEventListener('mousemove', (e) => this.handleMove(e));
    this.el.addEventListener('mouseleave', () => {
      this.hover = null;
      this.onHover?.(null);
      this.draw();
    });

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(this.el);

    // Re-draw when the colour scheme changes (dark ↔ light).
    new MutationObserver(() => this.draw())
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  private resize(): void {
    const w = Math.max(1, this.el.clientWidth);
    const h = Math.max(1, this.el.clientHeight);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.el.width = Math.round(w * this.dpr);
    this.el.height = Math.round(h * this.dpr);
    this.draw();
  }

  setData(res: ProfileResult | null, fieldLabel: string, unit: string): void {
    this.res = res;
    this.fieldLabel = fieldLabel;
    this.unit = unit;
    this.hover = null;
    this.resize();
  }

  private handleMove(e: MouseEvent): void {
    if (!this.res) return;
    const rect = this.el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const plotW = rect.width - this.pad.l - this.pad.r;
    const t = Math.max(0, Math.min(1, (x - this.pad.l) / plotW));
    const bin = Math.min(this.res.t.length - 1, Math.max(0, Math.round(t * (this.res.t.length - 1))));
    this.hover = { distance: this.res.t[bin], value: this.res.v[bin], bin };
    this.onHover?.(this.hover);
    this.draw();
  }

  draw(): void {
    const ctx = this.ctx;
    const W = this.el.width;
    const H = this.el.height;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const w = W / this.dpr;
    const h = H / this.dpr;
    const theme = currentTheme();
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, w, h);

    if (!this.res || this.res.t.length === 0) {
      ctx.fillStyle = theme.text;
      ctx.font = '12px var(--font-ui)';
      ctx.textAlign = 'center';
      ctx.fillText('在「剖面分析」中选择起点与终点后，这里会显示沿程曲线', w / 2, h / 2);
      return;
    }

    const res = this.res;
    const x0 = this.pad.l;
    const y0 = this.pad.t;
    const pw = Math.max(10, w - this.pad.l - this.pad.r);
    const ph = Math.max(10, h - this.pad.t - this.pad.b);

    // value domain
    let vmin = Infinity;
    let vmax = -Infinity;
    for (let i = 0; i < res.v.length; i++) {
      const a = res.v[i] - res.sd[i];
      const b = res.v[i] + res.sd[i];
      if (Number.isFinite(a)) vmin = Math.min(vmin, a);
      if (Number.isFinite(b)) vmax = Math.max(vmax, b);
    }
    if (!Number.isFinite(vmin) || !Number.isFinite(vmax) || vmax === vmin) {
      vmin = Number.isFinite(vmin) ? vmin - 1 : 0;
      vmax = vmin + 1;
    }
    const padV = (vmax - vmin) * 0.08;
    vmin -= padV;
    vmax += padV;

    const sx = (t: number) => x0 + (res.length ? (t / res.length) * pw : 0);
    const sy = (v: number) => y0 + ph - ((v - vmin) / (vmax - vmin)) * ph;

    // grid
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1;
    ctx.font = '10px var(--font-mono)';
    ctx.fillStyle = theme.text;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const v = vmin + ((vmax - vmin) * i) / 4;
      const y = Math.round(sy(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x0 + pw, y);
      ctx.stroke();
      ctx.fillText(fmtNum(v), x0 - 7, y);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i <= 4; i++) {
      const t = (res.length * i) / 4;
      const x = Math.round(sx(t)) + 0.5;
      ctx.strokeStyle = theme.grid;
      ctx.beginPath();
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y0 + ph);
      ctx.stroke();
      ctx.fillText(fmtNum(t), x, y0 + ph + 6);
    }

    // axis frame
    ctx.strokeStyle = theme.axis;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, pw, ph);

    // scatter
    if (res.rawT.length) {
      ctx.fillStyle = theme.scatter;
      const step = Math.max(1, Math.floor(res.rawT.length / 6000));
      for (let i = 0; i < res.rawT.length; i += step) {
        const px = sx(res.rawT[i]);
        const py = sy(res.rawV[i]);
        ctx.fillRect(px - 0.6, py - 0.6, 1.2, 1.2);
      }
    }

    // ±1σ band
    ctx.beginPath();
    for (let i = 0; i < res.v.length; i++) {
      const px = sx(res.t[i]);
      const py = sy(res.v[i] + res.sd[i]);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    for (let i = res.v.length - 1; i >= 0; i--) {
      ctx.lineTo(sx(res.t[i]), sy(res.v[i] - res.sd[i]));
    }
    ctx.closePath();
    ctx.fillStyle = theme.band;
    ctx.fill();

    // mean line
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < res.v.length; i++) {
      if (!Number.isFinite(res.v[i])) continue;
      const px = sx(res.t[i]);
      const py = sy(res.v[i]);
      if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = theme.line;
    ctx.lineWidth = 1.8;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // extremes
    const st = res.stats;
    if (Number.isFinite(st.minAt)) {
      this.marker(ctx, sx(st.minAt), sy(st.min), '#7fd3ff', `min ${fmtNum(st.min)}`);
    }
    if (Number.isFinite(st.maxAt)) {
      this.marker(ctx, sx(st.maxAt), sy(st.max), '#ff8f6b', `max ${fmtNum(st.max)}`);
    }

    // crosshair
    if (this.hover) {
      const px = sx(this.hover.distance);
      const py = sy(this.hover.value);
      ctx.strokeStyle = theme === DARK_THEME ? 'rgba(255,255,255,.28)' : 'rgba(0,0,0,.15)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(px, y0);
      ctx.lineTo(px, y0 + ph);
      ctx.moveTo(x0, py);
      ctx.lineTo(x0 + pw, py);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.beginPath();
      ctx.arc(px, py, 3.4, 0, Math.PI * 2);
      ctx.fillStyle = theme.accent;
      ctx.fill();

      const label = `${fmtNum(this.hover.distance)} → ${fmtNum(this.hover.value)}${this.unit}`;
      ctx.font = '11px var(--font-mono)';
      const tw = ctx.measureText(label).width + 12;
      let bx = px + 10;
      if (bx + tw > x0 + pw) bx = px - tw - 10;
      const by = Math.max(y0 + 2, py - 22);
      ctx.fillStyle = theme === DARK_THEME ? 'rgba(8,11,16,.9)' : 'rgba(255,255,255,.92)';
      ctx.strokeStyle = theme === DARK_THEME ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.10)';
      ctx.beginPath();
      ctx.rect(bx, by, tw, 17);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = theme === DARK_THEME ? '#e9eef6' : '#1a1f26';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, bx + 6, by + 9);
    }

    // axis captions
    ctx.fillStyle = theme.text;
    ctx.font = '10px var(--font-ui)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`${this.fieldLabel}${this.unit ? ` (${this.unit})` : ''}`, 6, 4);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText('沿线距离', w - 6, h - 4);
  }

  private marker(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, label: string): void {
    ctx.beginPath();
    ctx.arc(x, y, 3.6, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.6)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.font = '9px var(--font-mono)';
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(label, x, y - 6);
  }
}
