/**
 * 图像导出对话框 (Image export).
 *
 * A modal where the user configures the PNG export — title (text / font /
 * size, draggable), colour-bar (position / height / scale / label / unit,
 * draggable), output size, resolution and background (incl. transparent) —
 * with a live thumbnail preview on the right that is re-rendered from the
 * WebGL scene on every change.
 *
 * The preview and the final export share `drawExportImage`, so what the
 * thumbnail shows is exactly what gets written to the file. Title and
 * colour-bar positions are stored as normalised centres (`Vec2`), which makes
 * dragging resolution-independent.
 */

import { denormalize } from '../core/state';
import { paintLUT } from '../core/colormap';
import { downloadDataURL } from '../io/export';
import { fmtNum, h, icon, toast } from './dom';
import { check, colorInput, numberInput, segmented, select, slider } from './controls';
import type { Viewer } from '../render/Viewer';

export type BarPosition = 'left' | 'right' | 'bottom';
export type TitleFont = 'sans' | 'serif' | 'hei' | 'kai' | 'mono';
export type TextColorMode = 'auto' | 'dark' | 'light';

/** Normalised centre of a draggable overlay (0..1 of image width/height). */
export interface Vec2 {
  x: number;
  y: number;
}

export interface ImageExportConfig {
  showTitle: boolean;
  title: string;
  titleSize: number;
  titleFont: TitleFont;
  titleBold: boolean;
  /** `null` = automatic (top-centre). */
  titlePos: Vec2 | null;
  showBar: boolean;
  barPosition: BarPosition;
  /** Colour-bar length in logical px (vertical bar height / bottom bar width). */
  barHeight: number;
  barTicks: number;
  /** Scale factor for bar width + tick/caption fonts (not the length). */
  barScale: number;
  barLabel: string;
  barUnit: string;
  /** `null` = automatic (edge-anchored from `barPosition`). */
  barPos: Vec2 | null;
  /** Logical output size in px (the PNG is this × `scale`). */
  width: number;
  height: number;
  /** Resolution multiplier (device-pixel style supersampling). */
  scale: number;
  /** `null` = transparent background. */
  background: string | null;
  textColor: TextColorMode;
  /** Overlay margin in logical px. */
  margin: number;
}

/** Session context the dialog needs but cannot derive on its own. */
export interface ExportContext {
  viewer: Viewer;
  baseName: string;
  /** LUT currently uploaded to the shader. */
  lut: Uint8Array;
  /** Effective colour range + log flag (for tick values). */
  lo: number;
  hi: number;
  log: boolean;
  /** Whether the in-app legend is currently visible (default for 色卡). */
  legendVisible: boolean;
  legendLabel: string;
  legendUnit: string;
  /** Current viewport background colour (default for the export background). */
  background: string;
}

interface BarInfo {
  lut: Uint8Array;
  lo: number;
  hi: number;
  log: boolean;
}

const LS_EXPORT = 'pci.exportImage.v2';

/** Layout preferences kept across sessions (session-derived fields are not). */
interface PersistedConfig {
  showTitle: boolean;
  titleSize: number;
  titleFont: TitleFont;
  titleBold: boolean;
  titlePos: Vec2 | null;
  showBar: boolean;
  barPosition: BarPosition;
  barHeight: number;
  barTicks: number;
  barScale: number;
  barPos: Vec2 | null;
  scale: number;
  transparent: boolean;
  textColor: TextColorMode;
}

const FONT_STACKS: Record<TitleFont, string> = {
  sans: `system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif`,
  serif: `Georgia, 'Times New Roman', 'Songti SC', SimSun, serif`,
  hei: `'PingFang SC', 'Microsoft YaHei', 'Heiti SC', sans-serif`,
  kai: `KaiTi, 'Kaiti SC', STKaiti, serif`,
  mono: `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`,
};
const MONO = FONT_STACKS.mono;

const MIN_DIM = 64;
const MAX_DIM = 8192;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/* ────────── colour helpers ────────── */

function luminance(hex: string): number {
  const c = hex.trim().replace('#', '');
  const v = parseInt(c.length === 3 ? c.split('').map((ch) => ch + ch).join('') : c, 16);
  if (!Number.isFinite(v)) return 0.1;
  const r = (v >> 16) & 255;
  const g = (v >> 8) & 255;
  const b = v & 255;
  return (r * 0.299 + g * 0.587 + b * 0.114) / 255;
}

interface TextPalette {
  fg: string;
  frame: string;
  shadow: string;
}

function textPalette(cfg: ImageExportConfig): TextPalette {
  let lightText: boolean;
  if (cfg.textColor === 'light') lightText = true;
  else if (cfg.textColor === 'dark') lightText = false;
  // 自动：透明底默认浅色字（通常叠在深色背景上），否则按背景亮度决定。
  else lightText = cfg.background === null || luminance(cfg.background) < 0.5;
  return lightText
    ? { fg: '#f2f5f9', frame: 'rgba(255,255,255,0.35)', shadow: 'rgba(0,0,0,0.55)' }
    : { fg: '#14181e', frame: 'rgba(0,0,0,0.45)', shadow: 'rgba(255,255,255,0.75)' };
}

/* ────────── config defaults / persistence ────────── */

function defaultConfig(ctx: ExportContext): ImageExportConfig {
  const vw = ctx.viewer.canvas.clientWidth || 1280;
  const vh = ctx.viewer.canvas.clientHeight || 720;
  return {
    showTitle: true,
    title: ctx.baseName || '点云图像',
    titleSize: 22,
    titleFont: 'sans',
    titleBold: true,
    titlePos: null,
    showBar: ctx.legendVisible,
    barPosition: 'right',
    barHeight: Math.round(Math.min(320, Math.max(140, vh * 0.4))),
    barTicks: 5,
    barScale: 1,
    barLabel: ctx.legendLabel || '',
    barUnit: ctx.legendUnit || '',
    barPos: null,
    width: Math.max(MIN_DIM, vw),
    height: Math.max(MIN_DIM, vh),
    scale: 2,
    background: ctx.background,
    textColor: 'auto',
    margin: 20,
  };
}

function loadPersisted(): Partial<PersistedConfig> {
  try {
    const raw = localStorage.getItem(LS_EXPORT);
    return raw ? (JSON.parse(raw) as Partial<PersistedConfig>) : {};
  } catch {
    return {};
  }
}

function persist(cfg: ImageExportConfig): void {
  const p: PersistedConfig = {
    showTitle: cfg.showTitle,
    titleSize: cfg.titleSize,
    titleFont: cfg.titleFont,
    titleBold: cfg.titleBold,
    titlePos: cfg.titlePos,
    showBar: cfg.showBar,
    barPosition: cfg.barPosition,
    barHeight: cfg.barHeight,
    barTicks: cfg.barTicks,
    barScale: cfg.barScale,
    barPos: cfg.barPos,
    scale: cfg.scale,
    transparent: cfg.background === null,
    textColor: cfg.textColor,
  };
  try {
    localStorage.setItem(LS_EXPORT, JSON.stringify(p));
  } catch {
    /* storage may be unavailable */
  }
}

/* ══════════════════════════════════════════════════════════════
   Overlay layout — shared by drawing and hit-testing
   ══════════════════════════════════════════════════════════════ */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface TitleLayout {
  cx: number;
  cy: number;
  font: string;
  bbox: Rect;
}

function titleFontString(cfg: ImageExportConfig, px: number): string {
  const size = Math.max(8, cfg.titleSize) * px;
  return `${cfg.titleBold ? 700 : 500} ${size}px ${FONT_STACKS[cfg.titleFont] ?? FONT_STACKS.sans}`;
}

function layoutTitle(
  dst: CanvasRenderingContext2D,
  cfg: ImageExportConfig,
  W: number,
  H: number,
  px: number
): TitleLayout | null {
  if (!cfg.showTitle || !cfg.title.trim()) return null;
  const size = Math.max(8, cfg.titleSize) * px;
  const font = titleFontString(cfg, px);
  dst.font = font;
  const w = dst.measureText(cfg.title).width;
  const hgt = size * 1.15;
  const cx = cfg.titlePos ? cfg.titlePos.x * W : W / 2;
  const cy = cfg.titlePos ? cfg.titlePos.y * H : 0.55 * size + hgt / 2;
  return { cx, cy, font, bbox: { x: cx - w / 2, y: cy - hgt / 2, w, h: hgt } };
}

interface BarTick {
  value: string;
  /** Tick mark segment. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Label anchor. */
  tx: number;
  ty: number;
  align: CanvasTextAlign;
  baseline: CanvasTextBaseline;
}

interface BarLayout {
  orientation: 'v' | 'h';
  /** Bar gradient rect (absolute). */
  bx: number;
  by: number;
  bw: number;
  bl: number;
  ticks: BarTick[];
  caption: { text: string; x: number; y: number; font: string } | null;
  tickFont: string;
  /** Bounding box of the whole colour-bar block (for dragging). */
  bbox: Rect;
}

/** Approximate line height for a canvas font string like `500 12px family`. */
function fontLineHeight(font: string): number {
  const mm = /(\d+(?:\.\d+)?)px/.exec(font);
  return mm ? Number(mm[1]) * 1.25 : 14;
}

function layoutBar(
  dst: CanvasRenderingContext2D,
  cfg: ImageExportConfig,
  bar: BarInfo,
  W: number,
  H: number,
  px: number
): BarLayout | null {
  if (!cfg.showBar || bar.lut.length === 0) return null;
  const m = Math.max(4, cfg.margin) * px;
  const s = Math.max(0.3, cfg.barScale);
  const n = clamp(Math.round(cfg.barTicks), 2, 11);
  const tickLen = 5 * s * px;
  const tickFont = `${11 * s * px}px ${MONO}`;
  const captionFont = `500 ${12 * s * px}px ${FONT_STACKS.sans}`;
  const caption = captionText(cfg);

  if (cfg.barPosition !== 'bottom') {
    /* vertical bar hugging the left / right edge */
    const bw = clamp(cfg.barHeight * 0.075, 10, 26) * s * px;
    const len = Math.min(cfg.barHeight * px, H - 2 * m);

    dst.font = tickFont;
    const ticks: BarTick[] = [];
    let tickMaxW = 0;
    for (let i = 0; i < n; i++) {
      const t = 1 - i / (n - 1);
      const v = denormalize(t, bar.lo, bar.hi, bar.log);
      const value = fmtNum(v);
      tickMaxW = Math.max(tickMaxW, dst.measureText(value).width);
      ticks.push({ value, x0: 0, y0: 0, x1: 0, y1: 0, tx: 0, ty: 0, align: 'left', baseline: 'middle' });
    }
    dst.font = captionFont;
    const captionW = caption ? dst.measureText(caption).width : 0;
    const captionBlockH = caption ? 6 * s * px + fontLineHeight(captionFont) : 0;

    const rightSide = cfg.barPosition === 'right';
    const contentW = bw + tickLen + 3 * px + tickMaxW;
    // Group must be wide enough for the caption centred under the bar.
    const gw = Math.max(contentW, captionW + bw);
    const gh = len + captionBlockH;

    let gx: number;
    let gy: number;
    if (cfg.barPos) {
      gx = cfg.barPos.x * W - gw / 2;
      gy = cfg.barPos.y * H - gh / 2;
    } else {
      gx = rightSide ? W - m - gw : m;
      gy = (H - gh) / 2;
    }

    const barX = rightSide ? gx + gw - bw : gx;
    const barY = gy;
    for (let i = 0; i < n; i++) {
      const tk = ticks[i];
      const ty = barY + (i / (n - 1)) * len;
      if (rightSide) {
        tk.x0 = barX;
        tk.x1 = barX - tickLen;
        tk.tx = barX - tickLen - 3 * px;
        tk.align = 'right';
      } else {
        tk.x0 = barX + bw;
        tk.x1 = barX + bw + tickLen;
        tk.tx = barX + bw + tickLen + 3 * px;
        tk.align = 'left';
      }
      tk.y0 = tk.y1 = tk.ty = ty;
    }
    return {
      orientation: 'v',
      bx: barX,
      by: barY,
      bw,
      bl: len,
      ticks,
      caption: caption
        ? { text: caption, x: barX + bw / 2, y: barY + len + 6 * s * px, font: captionFont }
        : null,
      tickFont,
      bbox: { x: gx, y: gy, w: gw, h: gh },
    };
  }

  /* horizontal bar near the bottom edge */
  const len = Math.min(cfg.barHeight * px, W - 2 * m);
  const bh = clamp(cfg.barHeight * 0.05, 8, 18) * s * px;

  dst.font = tickFont;
  const ticks: BarTick[] = [];
  let endHalf = 0;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const v = denormalize(t, bar.lo, bar.hi, bar.log);
    const value = fmtNum(v);
    const w = dst.measureText(value).width;
    if (i === 0 || i === n - 1) endHalf = Math.max(endHalf, w / 2);
    ticks.push({ value, x0: 0, y0: 0, x1: 0, y1: 0, tx: 0, ty: 0, align: 'center', baseline: 'top' });
  }
  dst.font = captionFont;
  const captionW = caption ? dst.measureText(caption).width : 0;
  const captionBlockH = caption ? fontLineHeight(captionFont) + 5 * s * px : 0;

  const gw = Math.max(len + 2 * endHalf + 4 * px, captionW);
  const gh = captionBlockH + bh + tickLen + 2 * px + fontLineHeight(tickFont);

  let gx: number;
  let gy: number;
  if (cfg.barPos) {
    gx = cfg.barPos.x * W - gw / 2;
    gy = cfg.barPos.y * H - gh / 2;
  } else {
    gx = (W - gw) / 2;
    gy = H - m - gh;
  }

  const barX = gx + (gw - len) / 2;
  const barY = gy + captionBlockH;
  for (let i = 0; i < n; i++) {
    const tk = ticks[i];
    const tx = barX + (i / (n - 1)) * len;
    tk.x0 = tk.x1 = tk.tx = tx;
    tk.y0 = barY + bh;
    tk.y1 = barY + bh + tickLen;
    tk.ty = barY + bh + tickLen + 2 * px;
  }
  return {
    orientation: 'h',
    bx: barX,
    by: barY,
    bw: len,
    bl: bh,
    ticks,
    caption: caption ? { text: caption, x: gx + gw / 2, y: barY - 5 * s * px, font: captionFont } : null,
    tickFont,
    bbox: { x: gx, y: gy, w: gw, h: gh },
  };
}

function captionText(cfg: ImageExportConfig): string {
  const label = cfg.barLabel.trim();
  const unit = cfg.barUnit.trim();
  if (label && unit) return `${label} (${unit})`;
  return label || unit;
}

/* ══════════════════════════════════════════════════════════════
   Compositing — shared by the live preview and the final export
   ══════════════════════════════════════════════════════════════ */

export interface ExportHitRects {
  title: Rect | null;
  bar: Rect | null;
}

/**
 * Draw the full export image into `dst` (a 2D context whose canvas is already
 * sized `cfg.width × px` by `cfg.height × px`): the 3D frame from `src`
 * (drawn full-bleed, 1:1), then the title and the annotated colour bar on
 * top. Returns the overlay bounding boxes so the preview can hit-test them
 * for dragging.
 */
export function drawExportImage(
  dst: CanvasRenderingContext2D,
  src: CanvasImageSource,
  cfg: ImageExportConfig,
  bar: BarInfo,
  px: number
): ExportHitRects {
  const W = dst.canvas.width;
  const H = dst.canvas.height;
  dst.save();
  dst.clearRect(0, 0, W, H);
  dst.imageSmoothingEnabled = true;
  dst.imageSmoothingQuality = 'high';
  dst.drawImage(src, 0, 0, W, H);

  const pal = textPalette(cfg);
  const textShadow = () => {
    dst.shadowColor = pal.shadow;
    dst.shadowBlur = 3 * px;
  };
  const clearShadow = () => {
    dst.shadowColor = 'transparent';
    dst.shadowBlur = 0;
  };

  /* ── title ── */
  const tl = layoutTitle(dst, cfg, W, H, px);
  if (tl) {
    dst.font = tl.font;
    dst.fillStyle = pal.fg;
    dst.textAlign = 'center';
    dst.textBaseline = 'middle';
    textShadow();
    dst.fillText(cfg.title, tl.cx, tl.cy);
    clearShadow();
  }

  /* ── colour bar ── */
  const bl = layoutBar(dst, cfg, bar, W, H, px);
  if (bl) {
    paintLUT(dst, bar.lut, bl.bx, bl.by, bl.bw, bl.bl, bl.orientation === 'v');
    dst.strokeStyle = pal.frame;
    dst.lineWidth = px;
    dst.strokeRect(bl.bx - px / 2, bl.by - px / 2, bl.bw + px, bl.bl + px);

    dst.font = bl.tickFont;
    dst.fillStyle = pal.fg;
    for (const tk of bl.ticks) {
      dst.beginPath();
      dst.moveTo(tk.x0, tk.y0);
      dst.lineTo(tk.x1, tk.y1);
      dst.stroke();
      dst.textAlign = tk.align;
      dst.textBaseline = tk.baseline;
      textShadow();
      dst.fillText(tk.value, tk.tx, tk.ty);
      clearShadow();
    }

    if (bl.caption) {
      dst.font = bl.caption.font;
      dst.fillStyle = pal.fg;
      dst.textAlign = 'center';
      dst.textBaseline = bl.orientation === 'v' ? 'top' : 'bottom';
      textShadow();
      dst.fillText(bl.caption.text, bl.caption.x, bl.caption.y);
      clearShadow();
    }
  }

  dst.restore();
  return { title: tl ? tl.bbox : null, bar: bl ? bl.bbox : null };
}

/* ══════════════════════════════════════════════════════════════
   Dialog
   ══════════════════════════════════════════════════════════════ */

export function openImageExportDialog(ctx: ExportContext): void {
  const persisted = loadPersisted();
  const cfg: ImageExportConfig = { ...defaultConfig(ctx), ...persisted };
  // Session-derived values always win over stale persisted ones.
  cfg.title = ctx.baseName || cfg.title;
  cfg.barLabel = ctx.legendLabel || '';
  cfg.barUnit = ctx.legendUnit || '';
  cfg.background = persisted.transparent ? null : ctx.background;
  if (!FONT_STACKS[cfg.titleFont]) cfg.titleFont = 'sans';
  cfg.width = clamp(Math.round(cfg.width), MIN_DIM, MAX_DIM);
  cfg.height = clamp(Math.round(cfg.height), MIN_DIM, MAX_DIM);
  cfg.barHeight = clamp(Math.round(cfg.barHeight), 80, 640);
  cfg.barScale = clamp(Number(cfg.barScale) || 1, 0.5, 2);
  cfg.titleSize = clamp(Math.round(cfg.titleSize), 10, 72);
  cfg.barTicks = clamp(Math.round(cfg.barTicks), 2, 11);
  cfg.scale = [1, 2, 3, 4].includes(cfg.scale) ? cfg.scale : 2;
  if (cfg.textColor !== 'dark' && cfg.textColor !== 'light') cfg.textColor = 'auto';

  const barInfo: BarInfo = { lut: ctx.lut, lo: ctx.lo, hi: ctx.hi, log: ctx.log };
  let aspect = cfg.width / cfg.height;

  /* ── preview ── */
  const previewCanvas = h('canvas', { class: 'export-canvas' }) as HTMLCanvasElement;
  const previewMeta = h('div', { class: 'export-preview-meta mono' });
  const previewBox = h('div', { class: 'export-preview-box' }, [previewCanvas]);
  const resetPosBtn = h('button', {
    class: 'btn btn-sm btn-ghost', type: 'button', title: '将标题与色卡恢复到默认位置',
  }, [h('span', { text: '重置标注位置' })]);

  /** Overlay hit rects (buffer px) from the last preview render. */
  const hit: ExportHitRects = { title: null, bar: null };
  let drag: { kind: 'title' | 'bar'; dx: number; dy: number; w: number; hgt: number } | null = null;

  let previewQueued = false;
  const schedulePreview = () => {
    if (previewQueued) return;
    previewQueued = true;
    requestAnimationFrame(() => {
      previewQueued = false;
      renderPreview();
    });
  };

  function renderPreview(): void {
    const availW = Math.max(120, previewBox.clientWidth - 16);
    const availH = Math.max(120, previewBox.clientHeight - 16);
    const px = Math.min(availW / cfg.width, availH / cfg.height);
    previewCanvas.width = Math.max(2, Math.round(cfg.width * px));
    previewCanvas.height = Math.max(2, Math.round(cfg.height * px));

    const c2d = previewCanvas.getContext('2d');
    if (!c2d) return;
    try {
      // Render the scene straight into the thumbnail's buffer: same aspect,
      // same camera — a true live preview, not a stretched screenshot.
      ctx.viewer.renderTo(cfg.width, cfg.height, px, cfg.background);
      const r = drawExportImage(c2d, ctx.viewer.canvas, cfg, barInfo, px);
      ctx.viewer.renderRestore();
      hit.title = r.title;
      hit.bar = r.bar;
    } catch {
      /* preview is best-effort */
    }

    const outW = cfg.width * cfg.scale;
    const outH = cfg.height * cfg.scale;
    previewMeta.textContent =
      `输出 ${outW} × ${outH} px · ${cfg.background === null ? '透明背景' : '不透明'} · 缩略 ${px.toFixed(2)}×`;
  }

  /* ── dragging on the preview ── */
  function canvasPoint(e: PointerEvent): { x: number; y: number } {
    const rect = previewCanvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / Math.max(1, rect.width)) * previewCanvas.width,
      y: ((e.clientY - rect.top) / Math.max(1, rect.height)) * previewCanvas.height,
    };
  }
  const inRect = (p: { x: number; y: number }, r: Rect | null, pad: number): boolean =>
    !!r && p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad;

  function hitKind(p: { x: number; y: number }): 'title' | 'bar' | null {
    const pad = 6;
    if (inRect(p, hit.title, pad)) return 'title';
    if (inRect(p, hit.bar, pad)) return 'bar';
    return null;
  }

  previewCanvas.addEventListener('pointerdown', (e) => {
    const kind = hitKind(canvasPoint(e));
    if (!kind) return;
    const r = (kind === 'title' ? hit.title : hit.bar)!;
    const p = canvasPoint(e);
    drag = {
      kind,
      dx: p.x - (r.x + r.w / 2),
      dy: p.y - (r.y + r.h / 2),
      w: previewCanvas.width,
      hgt: previewCanvas.height,
    };
    previewCanvas.setPointerCapture(e.pointerId);
    previewCanvas.style.cursor = 'grabbing';
    e.preventDefault();
  });
  previewCanvas.addEventListener('pointermove', (e) => {
    const p = canvasPoint(e);
    if (!drag) {
      previewCanvas.style.cursor = hitKind(p) ? 'grab' : 'default';
      return;
    }
    const cx = clamp((p.x - drag.dx) / Math.max(1, drag.w), 0.02, 0.98);
    const cy = clamp((p.y - drag.dy) / Math.max(1, drag.hgt), 0.02, 0.98);
    if (drag.kind === 'title') cfg.titlePos = { x: cx, y: cy };
    else cfg.barPos = { x: cx, y: cy };
    schedulePreview();
  });
  const endDrag = (e: PointerEvent) => {
    if (!drag) return;
    drag = null;
    previewCanvas.style.cursor = 'default';
    if (previewCanvas.hasPointerCapture(e.pointerId)) previewCanvas.releasePointerCapture(e.pointerId);
  };
  previewCanvas.addEventListener('pointerup', endDrag);
  previewCanvas.addEventListener('pointercancel', endDrag);

  resetPosBtn.addEventListener('click', () => {
    cfg.titlePos = null;
    cfg.barPos = null;
    schedulePreview();
  });

  /* ── group: 标题 ── */
  const titleText = h('input', { class: 'input', type: 'text', value: cfg.title }) as HTMLInputElement;
  titleText.addEventListener('input', () => {
    cfg.title = titleText.value;
    schedulePreview();
  });

  const titleFontCtl = select<TitleFont>({
    label: '字体',
    value: cfg.titleFont,
    options: [
      { value: 'sans', label: '系统默认' },
      { value: 'hei', label: '黑体' },
      { value: 'serif', label: '衬线（宋体）' },
      { value: 'kai', label: '楷体' },
      { value: 'mono', label: '等宽' },
    ],
    onChange: (v) => {
      cfg.titleFont = v;
      schedulePreview();
    },
  });

  const titleBoldCtl = check({
    label: '粗体',
    value: cfg.titleBold,
    onChange: (v) => {
      cfg.titleBold = v;
      schedulePreview();
    },
  });

  const titleSizeCtl = slider({
    label: '标题字号',
    min: 10,
    max: 72,
    step: 1,
    value: cfg.titleSize,
    format: (v) => `${v} px`,
    onInput: (v) => {
      cfg.titleSize = v;
      schedulePreview();
    },
  });

  const titleGroup = h('div', { class: 'export-group' }, [
    groupTitle('标题', cfg.showTitle, (v) => {
      cfg.showTitle = v;
      paintDisabled();
      schedulePreview();
    }),
    h('div', { class: 'export-group-body' }, [
      titleText,
      h('div', { class: 'export-row' }, [titleFontCtl.el, titleBoldCtl.el]),
      titleSizeCtl.el,
    ]),
  ]);

  /* ── group: 色卡 ── */
  const barPosCtl = select<BarPosition>({
    label: '位置',
    value: cfg.barPosition,
    options: [
      { value: 'right', label: '右侧' },
      { value: 'left', label: '左侧' },
      { value: 'bottom', label: '底部' },
    ],
    onChange: (v) => {
      cfg.barPosition = v;
      cfg.barPos = null; // 方向变了，回到自动锚点；之后可再拖拽微调。
      schedulePreview();
    },
  });

  const barHeightCtl = slider({
    label: '高度（长度）',
    min: 80,
    max: 640,
    step: 2,
    value: cfg.barHeight,
    format: (v) => `${v} px`,
    hint: '竖直色卡的长度；底部色卡时为宽度。',
    onInput: (v) => {
      cfg.barHeight = v;
      schedulePreview();
    },
  });

  const barScaleCtl = slider({
    label: '色卡缩放',
    min: 0.5,
    max: 2,
    step: 0.05,
    value: cfg.barScale,
    format: (v) => `${v.toFixed(2)}×`,
    hint: '缩放色条宽度与刻度 / 标签字号。',
    onInput: (v) => {
      cfg.barScale = v;
      schedulePreview();
    },
  });

  const barTicksCtl = numberInput({
    label: '刻度数',
    value: cfg.barTicks,
    min: 2,
    max: 11,
    step: 1,
    onInput: (v) => {
      cfg.barTicks = clamp(Math.round(v), 2, 11);
      schedulePreview();
    },
  });

  const barLabelInput = h('input', {
    class: 'input', type: 'text', value: cfg.barLabel, placeholder: '色卡标签（如：高程 Z）',
  }) as HTMLInputElement;
  barLabelInput.addEventListener('input', () => {
    cfg.barLabel = barLabelInput.value;
    schedulePreview();
  });

  const barUnitInput = h('input', {
    class: 'input', type: 'text', value: cfg.barUnit, placeholder: '单位（如：m / °C）',
  }) as HTMLInputElement;
  barUnitInput.addEventListener('input', () => {
    cfg.barUnit = barUnitInput.value;
    schedulePreview();
  });

  const barGroup = h('div', { class: 'export-group' }, [
    groupTitle('色卡', cfg.showBar, (v) => {
      cfg.showBar = v;
      paintDisabled();
      schedulePreview();
    }),
    h('div', { class: 'export-group-body' }, [
      barPosCtl.el,
      barHeightCtl.el,
      barScaleCtl.el,
      barTicksCtl.el,
      field('标签', barLabelInput),
      field('单位', barUnitInput),
    ]),
  ]);

  /* ── group: 图像 ── */
  const widthCtl = numberInput({
    label: '宽度',
    value: cfg.width,
    min: MIN_DIM,
    max: MAX_DIM,
    step: 1,
    suffix: 'px',
    onInput: (v) => {
      cfg.width = clamp(Math.round(v), MIN_DIM, MAX_DIM);
      if (lockAspectCtl.get() && cfg.width > 0) {
        cfg.height = clamp(Math.round(cfg.width / aspect), MIN_DIM, MAX_DIM);
        heightCtl.set(cfg.height);
      } else {
        aspect = cfg.width / Math.max(1, cfg.height);
      }
      schedulePreview();
    },
  });

  const heightCtl = numberInput({
    label: '高度',
    value: cfg.height,
    min: MIN_DIM,
    max: MAX_DIM,
    step: 1,
    suffix: 'px',
    onInput: (v) => {
      cfg.height = clamp(Math.round(v), MIN_DIM, MAX_DIM);
      if (lockAspectCtl.get() && cfg.height > 0) {
        cfg.width = clamp(Math.round(cfg.height * aspect), MIN_DIM, MAX_DIM);
        widthCtl.set(cfg.width);
      } else {
        aspect = cfg.width / Math.max(1, cfg.height);
      }
      schedulePreview();
    },
  });

  const lockAspectCtl = check({
    label: '锁定比例',
    value: true,
    onChange: (v) => {
      if (v) aspect = cfg.width / Math.max(1, cfg.height);
    },
  });

  const viewportBtn = h('button', { class: 'btn btn-sm btn-ghost', type: 'button', title: '将宽高设为当前视口尺寸' }, [
    h('span', { text: '视口尺寸' }),
  ]);
  viewportBtn.addEventListener('click', () => {
    cfg.width = clamp(ctx.viewer.canvas.clientWidth || cfg.width, MIN_DIM, MAX_DIM);
    cfg.height = clamp(ctx.viewer.canvas.clientHeight || cfg.height, MIN_DIM, MAX_DIM);
    aspect = cfg.width / cfg.height;
    widthCtl.set(cfg.width);
    heightCtl.set(cfg.height);
    schedulePreview();
  });

  const scaleCtl = segmented({
    label: '分辨率',
    value: String(cfg.scale),
    options: [1, 2, 3, 4].map((s) => ({ value: String(s), label: `${s}×` })),
    onChange: (v) => {
      cfg.scale = Number(v);
      schedulePreview();
    },
  });

  const bgCtl = colorInput({
    label: '背景色',
    value: cfg.background ?? ctx.background,
    onChange: (v) => {
      cfg.background = v;
      transparentCtl.set(false);
      paintDisabled();
      schedulePreview();
    },
  });

  const bgReset = h('button', { class: 'btn btn-sm btn-ghost', type: 'button', title: '恢复为当前视口背景色' }, [
    h('span', { text: '当前' }),
  ]);
  bgReset.addEventListener('click', () => {
    cfg.background = ctx.background;
    bgCtl.set(ctx.background);
    transparentCtl.set(false);
    paintDisabled();
    schedulePreview();
  });

  const transparentCtl = check({
    label: '透明背景',
    value: cfg.background === null,
    onChange: (v) => {
      cfg.background = v ? null : bgCtl.get();
      paintDisabled();
      schedulePreview();
    },
  });

  const textColorCtl = select<TextColorMode>({
    label: '文字颜色',
    value: cfg.textColor,
    options: [
      { value: 'auto', label: '自动' },
      { value: 'light', label: '浅色' },
      { value: 'dark', label: '深色' },
    ],
    onChange: (v) => {
      cfg.textColor = v;
      schedulePreview();
    },
  });

  const imageGroup = h('div', { class: 'export-group' }, [
    groupTitle('图像', true, null),
    h('div', { class: 'export-group-body' }, [
      h('div', { class: 'export-row' }, [widthCtl.el, heightCtl.el]),
      h('div', { class: 'export-row export-row-tight' }, [lockAspectCtl.el, viewportBtn]),
      scaleCtl.el,
      h('div', { class: 'export-row' }, [bgCtl.el, bgReset]),
      h('div', { class: 'export-row export-row-tight' }, [transparentCtl.el, textColorCtl.el]),
    ]),
  ]);

  /* ── enable / disable groups when their master toggle is off ── */
  function paintDisabled(): void {
    titleGroup.classList.toggle('is-off', !cfg.showTitle);
    barGroup.classList.toggle('is-off', !cfg.showBar);
    bgCtl.el.classList.toggle('is-off', cfg.background === null);
  }

  /* ── header / footer ── */
  const head = h('div', { class: 'modal-head' }, [
    h('div', { class: 'modal-head-text' }, [
      h('div', { class: 'modal-title' }, ['图像导出']),
      h('div', { class: 'modal-sub', text: '配置标题、色卡与分辨率，拖拽预览中的标注可调整位置' }),
    ]),
    h('button', { class: 'icon-btn modal-close', type: 'button', title: '取消' }, [icon('close', 15)]),
  ]);

  const form = h('div', { class: 'export-form' }, [titleGroup, barGroup, imageGroup]);
  const preview = h('div', { class: 'export-preview' }, [
    h('div', { class: 'export-preview-label', text: '实时预览' }),
    previewBox,
    previewMeta,
    h('div', { class: 'export-preview-hint', text: '可直接拖拽预览中的标题与色卡调整位置。' }),
    resetPosBtn,
  ]);

  const body = h('div', { class: 'modal-body export-body' }, [
    h('div', { class: 'export-layout' }, [form, preview]),
  ]);

  const cancelBtn = h('button', { class: 'btn btn-ghost', type: 'button', text: '取消' });
  const okBtn = h('button', { class: 'btn btn-primary', type: 'button', text: '导出 PNG' });
  const foot = h('div', { class: 'modal-foot' }, [cancelBtn, okBtn]);

  const card = h('div', { class: 'modal export-modal' }, [head, body, foot]);
  const backdrop = h('div', { class: 'modal-backdrop', role: 'dialog', 'aria-modal': 'true' }, [card]);

  /* ── behaviour ── */

  function cleanup(): void {
    window.removeEventListener('keydown', onKey);
    backdrop.remove();
  }

  function cancel(): void {
    cleanup();
  }

  function doExport(): void {
    const outW = cfg.width * cfg.scale;
    const outH = cfg.height * cfg.scale;
    const cap = ctx.viewer.maxRenderSize;
    if (outW > cap || outH > cap) {
      toast(
        'warn',
        '尺寸超出上限',
        `${outW} × ${outH} 超过渲染上限 ${cap} px，请降低分辨率或缩小尺寸。`
      );
      return;
    }
    const out = document.createElement('canvas');
    out.width = outW;
    out.height = outH;
    const c2d = out.getContext('2d');
    if (!c2d) {
      toast('err', '导出失败', '无法创建画布上下文。');
      return;
    }
    try {
      ctx.viewer.renderTo(cfg.width, cfg.height, cfg.scale, cfg.background);
      drawExportImage(c2d, ctx.viewer.canvas, cfg, barInfo, cfg.scale);
      ctx.viewer.renderRestore();
      const url = out.toDataURL('image/png');
      downloadDataURL(url, `${ctx.baseName || 'pointcloud'}_${outW}x${outH}.png`);
      persist(cfg);
      toast('ok', '图像已导出', `${outW} × ${outH} px PNG${cfg.background === null ? '（透明背景）' : ''}。`);
      cleanup();
    } catch (err) {
      ctx.viewer.renderRestore();
      toast('err', '导出失败', err instanceof Error ? err.message : String(err));
    }
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  };

  (head.querySelector('.modal-close') as HTMLElement).addEventListener('click', cancel);
  cancelBtn.addEventListener('click', cancel);
  okBtn.addEventListener('click', doExport);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) cancel();
  });
  window.addEventListener('keydown', onKey);

  document.body.appendChild(backdrop);
  paintDisabled();
  renderPreview();
  setTimeout(() => titleText.focus(), 0);
}

/* ────────── small DOM helpers local to the dialog ────────── */

function groupTitle(label: string, checked: boolean, onToggle: ((v: boolean) => void) | null): HTMLElement {
  if (!onToggle) {
    return h('div', { class: 'export-group-title' }, [h('span', { text: label })]);
  }
  // A checkbox inline in the group header acts as the master on/off switch;
  // `paintDisabled()` greys the group body out to match.
  const input = h('input', { type: 'checkbox' }) as HTMLInputElement;
  input.checked = checked;
  input.addEventListener('change', () => onToggle(input.checked));
  const tick = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  tick.setAttribute('viewBox', '0 0 24 24');
  tick.innerHTML = '<path d="M20 6 9 17l-5-5"/>';
  const lab = h('label', { class: 'check export-group-check' }, [
    input,
    h('span', { class: 'check-box' }, [tick]),
    h('span', { class: 'check-label', text: label }),
  ]);
  return h('div', { class: 'export-group-title' }, [lab]);
}

function field(label: string, control: HTMLElement): HTMLElement {
  return h('div', { class: 'field' }, [
    h('label', { class: 'field-label' }, [label]),
    control,
  ]);
}
