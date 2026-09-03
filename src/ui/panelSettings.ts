/** Left panel — appearance, colour mapping, scene and the colormap editor. */

import type { App } from '../app';
import {
  allColormaps, buildLUT, customColormaps, getColormap, LUT_SIZE, paintLUT,
  type ColorStop,
} from '../core/colormap';
import { h, icon, toast } from './dom';
import {
  colorInput, emptyState, numberInput, prop, section, segmented, select, slider, toggle,
  type Control, type Option,
} from './controls';

interface SettingsControls {
  mode: Control<string>;
  attr: Control<string> & { setOptions(list: Option<string>[], keepValue?: boolean): void };
  uniform: Control<string>;
  gain: Control<number>;
  size: Control<number>;
  sizeMode: Control<string>;
  shape: Control<string>;
  opacity: Control<number>;
  reverse: Control<boolean>;
  steps: Control<number>;
  autoRange: Control<boolean>;
  minInput: Control<number>;
  maxInput: Control<number>;
  clipLow: Control<number>;
  clipHigh: Control<number>;
  log: Control<boolean>;
  sym: Control<boolean>;
  bg: Control<string>;
  grid: Control<string>;
  box: Control<boolean>;
  axes: Control<boolean>;
  turntable: Control<boolean>;
}

const TAB_DEFS = [
  { id: 'display', label: '外观', icon: 'sliders' as const },
  { id: 'color', label: '色彩', icon: 'palette' as const },
  { id: 'scene', label: '场景', icon: 'cube' as const },
  { id: 'lut', label: '色卡库', icon: 'layers' as const },
];

export function createSettingsPanel(app: App, host: HTMLElement, tabsHost: HTMLElement): void {
  const st = app.store.state;
  const R = st.render;
  const pages = new Map<string, HTMLElement>();
  let controls: SettingsControls;

  const page = (id: string): HTMLElement => {
    let el = pages.get(id);
    if (!el) {
      el = h('div');
      pages.set(id, el);
    }
    return el;
  };

  const show = (id: string): void => {
    for (const [k, v] of pages) v.hidden = k !== id;
    tabsHost.querySelectorAll<HTMLElement>('.tab').forEach((t) => {
      t.classList.toggle('is-on', t.dataset.tab === id);
    });
  };

  /* ────────── tabs ────────── */
  tabsHost.innerHTML = '';
  for (const t of TAB_DEFS) {
    const b = h('button', { class: 'tab', type: 'button', 'data-tab': t.id }, [
      icon(t.icon, 13),
      h('span', { text: t.label }),
    ]);
    b.addEventListener('click', () => {
      app.store.state.ui.leftTab = t.id;
      show(t.id);
    });
    tabsHost.appendChild(b);
  }

  /* ══════════ 外观 ══════════ */
  {
    const p = page('display');

    const sec1 = section('着色', { icon: 'palette' });
    const mode = segmented<'uniform' | 'attribute' | 'rgb' | 'elevation'>({
      options: [
        { value: 'attribute', label: '属性', title: '按点上的数值属性着色' },
        { value: 'rgb', label: '原色', title: '使用文件自带的 RGB 颜色' },
        { value: 'elevation', label: '高程', title: '按 Z 坐标着色' },
        { value: 'uniform', label: '单色', title: '统一颜色' },
      ],
      value: R.colorMode,
      onChange: (v) => app.setRender({ colorMode: v }),
    });
    const attr = select<string>({
      label: '属性',
      options: app.fieldOptions(),
      value: R.attribute,
      onChange: (v) => app.setRender({ attribute: v }),
    }) as Control<string> & { setOptions(list: Option<string>[], keepValue?: boolean): void };
    const uniform = colorInput({
      label: '单色',
      value: R.uniformColor,
      onChange: (v) => app.setRender({ uniformColor: v }),
    });
    const gain = slider({
      label: '亮度',
      min: 0.3, max: 2, step: 0.01,
      value: R.colorGain,
      format: (v) => `${v.toFixed(2)}×`,
      onInput: (v) => app.setRender({ colorGain: v }),
    });
    sec1.body.appendChild(prop('方式', mode.el));
    sec1.body.appendChild(attr.el);
    sec1.body.appendChild(uniform.el);
    sec1.body.appendChild(gain.el);
    p.appendChild(sec1.root);

    const sec2 = section('点渲染', { icon: 'dots' });
    const size = slider({
      label: '点大小',
      min: 0.5, max: 12, step: 0.1,
      value: R.pointSize,
      format: (v) => v.toFixed(1),
      onInput: (v) => app.setRender({ pointSize: v }),
    });
    const sizeMode = segmented<'fixed' | 'world'>({
      label: '尺寸基准',
      options: [
        { value: 'fixed', label: '屏幕像素', title: '点大小固定为屏幕像素' },
        { value: 'world', label: '世界单位', title: '点大小随距离透视缩放' },
      ],
      value: R.sizeMode,
      onChange: (v) => app.setRender({ sizeMode: v }),
    });
    const shape = segmented<'circle' | 'square'>({
      label: '点形状',
      options: [
        { value: 'circle', label: '圆形' },
        { value: 'square', label: '方形' },
      ],
      value: R.shape,
      onChange: (v) => app.setRender({ shape: v }),
    });
    const opacity = slider({
      label: '不透明度',
      min: 0.1, max: 1, step: 0.01,
      value: R.opacity,
      format: (v) => `${Math.round(v * 100)}%`,
      onInput: (v) => app.setRender({ opacity: v }),
    });
    sec2.body.appendChild(size.el);
    sec2.body.appendChild(sizeMode.el);
    sec2.body.appendChild(shape.el);
    sec2.body.appendChild(opacity.el);
    sec2.body.appendChild(
      h('div', {
        class: 'field-hint',
        text: '提示：点太多导致卡顿可增大点大小并降低不透明度，或在「功能 → 降采样」中抽稀。',
      })
    );
    p.appendChild(sec2.root);

    const sec3 = section('快捷键', { icon: 'info', collapsed: true });
    const keys: [string, string][] = [
      ['Ctrl/⌘ + O', '打开文件'],
      ['1 / 2 / 3 / 4', '属性 / 原色 / 高程 / 单色'],
      ['F', '视角归位'],
      ['M', '测量模式'],
      ['Esc', '清除测量'],
      ['Ctrl + 1/2/3', '折叠左 / 右 / 底部面板'],
      ['空格', '自动旋转'],
    ];
    const box = h('div', { class: 'col', style: 'gap:5px' });
    for (const [k, v] of keys) {
      box.appendChild(
        h('div', { class: 'row', style: 'justify-content:space-between' }, [
          h('span', { class: 'kbd', text: k }),
          h('span', { class: 'field-hint', text: v }),
        ])
      );
    }
    sec3.body.appendChild(box);
    p.appendChild(sec3.root);

    controls = {
      mode: mode as unknown as Control<string>,
      attr,
      uniform,
      gain,
      size,
      sizeMode: sizeMode as unknown as Control<string>,
      shape: shape as unknown as Control<string>,
      opacity,
    } as SettingsControls;
  }

  /* ══════════ 色彩 ══════════ */
  {
    const p = page('color');
    const sec = section('值域映射', { icon: 'chart' });
    const autoRange = toggle({
      label: '自动值域（按分位数裁剪）',
      value: R.range.auto,
      onChange: (v) => app.setRange({ auto: v }),
    });
    const clipLow = slider({
      label: '低端裁剪',
      min: 0, max: 20, step: 0.1,
      value: R.range.clipLow,
      format: (v) => `${v.toFixed(1)}%`,
      onInput: (v) => app.setRange({ clipLow: v }),
    });
    const clipHigh = slider({
      label: '高端裁剪',
      min: 0, max: 20, step: 0.1,
      value: R.range.clipHigh,
      format: (v) => `${v.toFixed(1)}%`,
      onInput: (v) => app.setRange({ clipHigh: v }),
    });
    const minInput = numberInput({
      label: '最小值',
      value: R.range.min,
      onInput: (v) => app.setRange({ min: v }),
    });
    const maxInput = numberInput({
      label: '最大值',
      value: R.range.max,
      onInput: (v) => app.setRange({ max: v }),
    });
    const log = toggle({
      label: '对数映射',
      value: R.range.log,
      onChange: (v) => app.setRange({ log: v }),
    });
    const sym = toggle({
      label: '零值对称（发散色卡）',
      value: R.range.symmetric,
      onChange: (v) => app.setRange({ symmetric: v }),
    });
    sec.body.appendChild(autoRange.el);
    sec.body.appendChild(clipLow.el);
    sec.body.appendChild(clipHigh.el);
    sec.body.appendChild(minInput.el);
    sec.body.appendChild(maxInput.el);
    sec.body.appendChild(log.el);
    sec.body.appendChild(sym.el);
    p.appendChild(sec.root);

    const sec2 = section('色带调整', { icon: 'palette' });
    const reverse = toggle({
      label: '反转色带',
      value: R.reverse,
      onChange: (v) => app.setRender({ reverse: v }),
    });
    const steps = slider({
      label: '离散分级',
      min: 0, max: 32, step: 1,
      value: R.steps,
      format: (v) => (v < 2 ? '连续' : `${v} 级`),
      onInput: (v) => app.setRender({ steps: v }),
    });
    sec2.body.appendChild(reverse.el);
    sec2.body.appendChild(steps.el);
    sec2.body.appendChild(
      h('div', { class: 'field-hint', text: '离散分级会把连续色带切成 N 个色阶，便于读数与出图。' })
    );
    p.appendChild(sec2.root);

    Object.assign(controls, { reverse, steps, autoRange, minInput, maxInput, clipLow, clipHigh, log, sym });
  }

  /* ══════════ 场景 ══════════ */
  {
    const p = page('scene');
    const sec = section('环境', { icon: 'cube' });
    const bg = colorInput({ label: '背景色', value: R.background, onChange: (v) => app.setRender({ background: v }) });
    const grid = select<'none' | 'xy' | 'xz' | 'yz'>({
      label: '网格平面',
      options: [
        { value: 'none', label: '不显示' },
        { value: 'xy', label: 'XY 平面' },
        { value: 'xz', label: 'XZ 平面（水平）' },
        { value: 'yz', label: 'YZ 平面' },
      ],
      value: R.grid,
      onChange: (v) => app.setRender({ grid: v }),
    });
    const boxT = toggle({ label: '显示包围盒', value: R.showBox, onChange: (v) => app.setRender({ showBox: v }) });
    const axes = toggle({ label: '显示坐标轴', value: R.showAxes, onChange: (v) => app.setRender({ showAxes: v }) });
    const turntable = toggle({ label: '自动旋转', value: R.turntable, onChange: (v) => app.setRender({ turntable: v }) });
    sec.body.appendChild(bg.el);
    sec.body.appendChild(grid.el);
    sec.body.appendChild(boxT.el);
    sec.body.appendChild(axes.el);
    sec.body.appendChild(turntable.el);
    p.appendChild(sec.root);

    const sec2 = section('视角', { icon: 'camera' });
    const views: [string, string][] = [
      ['iso', '等轴'], ['x', 'X+'], ['-x', 'X−'],
      ['y', 'Y+'], ['-y', 'Y−'], ['z', 'Z+'], ['-z', 'Z−'],
    ];
    const grid2 = h('div', { class: 'grid-3' });
    for (const [k, label] of views) {
      const b = h('button', { class: 'btn btn-sm', type: 'button', text: label });
      b.addEventListener('click', () => app.viewer.setViewAxis(k as 'iso'));
      grid2.appendChild(b);
    }
    sec2.body.appendChild(grid2);
    sec2.body.appendChild(h('div', {
      class: 'field-hint',
      text: '鼠标可任意方向翻滚，无角度限制；点上方预设视图可重新对齐水平。',
    }));

    // Rotate within a coordinate plane: XY→about Z, YZ→about X, XZ→about Y
    const rotLabel = h('div', { class: 'field-hint', text: '平面旋转（每步 15°）' });
    sec2.body.appendChild(rotLabel);
    const planes: ['xy' | 'yz' | 'xz', string][] = [
      ['xy', 'XY 平面'], ['yz', 'YZ 平面'], ['xz', 'XZ 平面'],
    ];
    for (const [plane, plabel] of planes) {
      const row = h('div', { class: 'rot-row' });
      row.appendChild(h('span', { class: 'rot-plane', text: plabel }));
      for (const [sign, arrow, title] of [[-1, '↺', `${plabel} 逆时针`], [1, '↻', `${plabel} 顺时针`]] as [number, string, string][]) {
        const b = h('button', { class: 'btn btn-sm', type: 'button', text: arrow, title });
        b.addEventListener('click', () => app.viewer.rotateInPlane(plane, sign * 15));
        row.appendChild(b);
      }
      sec2.body.appendChild(row);
    }

    const fit = h('button', { class: 'btn btn-sm btn-block', type: 'button' }, [
      icon('frame', 13), h('span', { text: '缩放至全部 (F)' }),
    ]);
    fit.addEventListener('click', () => app.frameAll());
    sec2.body.appendChild(fit);
    p.appendChild(sec2.root);

    const sec3 = section('性能与拾取', { icon: 'sliders', collapsed: true });
    const pickScale = slider({
      label: '拾取容差',
      min: 0.4, max: 6, step: 0.1,
      value: app.pickScale,
      format: (v) => `${v.toFixed(1)}×`,
      onInput: (v) => { app.pickScale = v; },
    });
    const pixelRatio = slider({
      label: '渲染倍率',
      min: 0.5, max: 2, step: 0.25,
      value: app.pixelRatioCap,
      format: (v) => `${v.toFixed(2)}×`,
      onInput: (v) => app.setPixelRatioCap(v),
    });
    sec3.body.appendChild(pickScale.el);
    sec3.body.appendChild(pixelRatio.el);
    sec3.body.appendChild(
      h('div', { class: 'field-hint', text: '降低渲染倍率可显著提升大点云的帧率；拾取容差越大越容易选中点。' })
    );
    p.appendChild(sec3.root);

    Object.assign(controls, {
      bg,
      grid: grid as unknown as Control<string>,
      box: boxT,
      axes,
      turntable,
    });
  }

  /* ══════════ 色卡库 ══════════ */
  const editor = new ColormapEditor(app);
  page('lut').appendChild(editor.el);

  for (const id of TAB_DEFS.map((t) => t.id)) host.appendChild(page(id));
  show(st.ui.leftTab);

  /* ────────── reactive sync ────────── */
  const sync = (events: Set<string>): void => {
    if (events.has('cloud')) {
      controls.attr.setOptions(app.fieldOptions());
      editor.refresh();
    }
    const r = app.store.state.render;
    controls.mode.set(r.colorMode);
    controls.attr.set(r.attribute);
    controls.uniform.set(r.uniformColor);
    controls.gain.set(r.colorGain);
    controls.size.set(r.pointSize);
    controls.sizeMode.set(r.sizeMode);
    controls.shape.set(r.shape);
    controls.opacity.set(r.opacity);
    controls.reverse.set(r.reverse);
    controls.steps.set(r.steps);
    controls.autoRange.set(r.range.auto);
    controls.clipLow.set(r.range.clipLow);
    controls.clipHigh.set(r.range.clipHigh);
    controls.log.set(r.range.log);
    controls.sym.set(r.range.symmetric);
    controls.bg.set(r.background);
    controls.grid.set(r.grid);
    controls.box.set(r.showBox);
    controls.axes.set(r.showAxes);
    controls.turntable.set(r.turntable);

    // Only show the readouts that are actually in effect.
    const manual = !r.range.auto;
    controls.minInput.el.hidden = !manual;
    controls.maxInput.el.hidden = !manual;
    controls.clipLow.el.hidden = manual;
    controls.clipHigh.el.hidden = manual;
    if (manual) {
      controls.minInput.set(r.range.min);
      controls.maxInput.set(r.range.max);
    } else {
      controls.minInput.set(app.effRange.lo);
      controls.maxInput.set(app.effRange.hi);
    }
    controls.attr.el.hidden = r.colorMode !== 'attribute';
    controls.uniform.el.hidden = r.colorMode !== 'uniform';
    editor.syncSelection();
  };

  app.store.on(sync);
  sync(new Set(['cloud']));
}

/* ══════════════════════════════════════════════════════════════
   Colormap library + stop editor
   ══════════════════════════════════════════════════════════════ */

class ColormapEditor {
  readonly el: HTMLElement;
  private itemsEl: HTMLElement;
  private preview: HTMLCanvasElement;
  private stopsEl: HTMLElement;
  private nameInput: HTMLInputElement;
  private editing: { id: string; name: string; stops: ColorStop[] } | null = null;
  private app: App;

  constructor(app: App) {
    this.app = app;

    const secLib = section('色卡库', { icon: 'layers' });
    this.itemsEl = h('div', { class: 'cm-list' });
    secLib.body.appendChild(this.itemsEl);

    const secEdit = section('色标编辑器', { icon: 'wand' });
    this.preview = h('canvas', { class: 'cm-preview', style: 'height:22px' }) as HTMLCanvasElement;
    secEdit.body.appendChild(this.preview);

    this.nameInput = h('input', { class: 'input', placeholder: '自定义色卡名称' }) as HTMLInputElement;
    this.nameInput.addEventListener('input', () => {
      if (this.editing) this.editing.name = this.nameInput.value;
    });
    secEdit.body.appendChild(prop('名称', this.nameInput));

    this.stopsEl = h('div', { class: 'cm-stops' });
    secEdit.body.appendChild(this.stopsEl);

    const actions = h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' }, [
      miniButton('plus', '添加色标', () => this.addStop()),
      miniButton('copy', '从此复制', () => this.duplicate()),
      miniButton('save', '保存为自定义', () => this.save(), true),
    ]);
    secEdit.body.appendChild(actions);

    const io = h('div', { class: 'row', style: 'gap:6px' }, [
      miniButton('download', '导出色卡', () => this.exportJson()),
      miniButton('upload', '导入色卡', () => {
        (document.getElementById('lutInput') as HTMLInputElement | null)?.click();
      }),
    ]);
    secEdit.body.appendChild(io);
    secEdit.body.appendChild(
      h('div', {
        class: 'field-hint',
        text: '色标位置 t ∈ [0,1]。自定义色卡保存在浏览器本地，可导出为 JSON 迁移。',
      })
    );

    this.el = h('div', {}, [secLib.root, secEdit.root]);
    this.refresh();
    this.loadFromCurrent();
  }

  refresh(): void {
    this.itemsEl.innerHTML = '';
    const current = this.app.store.state.render.colormapId;
    for (const cm of allColormaps()) {
      const cv = h('canvas') as HTMLCanvasElement;
      cv.width = LUT_SIZE;
      cv.height = 16;
      const ctx = cv.getContext('2d');
      if (ctx) paintLUT(ctx, buildLUT(cm.stops), 0, 0, LUT_SIZE, 16);
      const item = h('div', { class: 'cm-item', title: cm.name }, [
        cv,
        h('div', { class: 'cm-item-name', text: cm.name }),
      ]);
      if (cm.id === current) item.classList.add('is-on');
      item.addEventListener('click', () => {
        this.app.setColormap(cm.id);
        this.loadFromCurrent();
      });
      this.itemsEl.appendChild(item);
    }
  }

  syncSelection(): void {
    const cur = this.app.store.state.render.colormapId;
    const list = allColormaps();
    let found = false;
    this.itemsEl.querySelectorAll<HTMLElement>('.cm-item').forEach((el, i) => {
      const on = list[i]?.id === cur;
      if (on) found = true;
      el.classList.toggle('is-on', on);
    });
    if (!found) this.refresh();
  }

  private loadFromCurrent(): void {
    const cm = getColormap(this.app.store.state.render.colormapId);
    if (!cm) return;
    this.editing = {
      id: cm.builtin ? '' : cm.id,
      name: cm.builtin ? `${cm.name} 副本` : cm.name,
      stops: cm.stops.map((s) => ({ ...s })),
    };
    this.nameInput.value = this.editing.name;
    this.renderStops();
    this.paintPreview();
  }

  private duplicate(): void {
    if (!this.editing) return;
    this.editing = {
      id: '',
      name: this.nameInput.value || '自定义色卡',
      stops: this.editing.stops.map((s) => ({ ...s })),
    };
    this.renderStops();
    toast('info', '已复制为可编辑副本', '修改后点击「保存为自定义」。');
  }

  private addStop(): void {
    if (!this.editing) return;
    const stops = this.editing.stops;
    let idx = 0;
    let gap = -1;
    for (let i = 0; i < stops.length - 1; i++) {
      const g = stops[i + 1].t - stops[i].t;
      if (g > gap) { gap = g; idx = i; }
    }
    const a = stops[idx] ?? { r: 1, g: 1, b: 1, t: 0 };
    const b = stops[idx + 1] ?? { ...a, t: 1 };
    stops.splice(idx + 1, 0, {
      t: (a.t + b.t) / 2,
      r: (a.r + b.r) / 2,
      g: (a.g + b.g) / 2,
      b: (a.b + b.b) / 2,
    });
    this.renderStops();
    this.paintPreview();
    this.applyLive();
  }

  private renderStops(): void {
    this.stopsEl.innerHTML = '';
    const stops = this.editing?.stops ?? [];
    stops.forEach((s, i) => {
      const pos = h('input', {
        type: 'range', class: 'slider', min: '0', max: '1', step: '0.005', value: String(s.t),
      }) as HTMLInputElement;
      const label = h('span', { class: 'cm-pos mono', text: s.t.toFixed(3) });
      pos.addEventListener('input', () => {
        s.t = Number(pos.value);
        label.textContent = s.t.toFixed(3);
        this.sortStops();
        this.paintPreview();
        this.applyLive();
      });

      const color = h('input', { type: 'color', value: rgbToHex(s.r, s.g, s.b) }) as HTMLInputElement;
      color.addEventListener('input', () => {
        const [r, g, b] = hexToRgb(color.value);
        s.r = r; s.g = g; s.b = b;
        this.paintPreview();
        this.applyLive();
      });
      const swatch = h('span', { class: 'swatch-btn' }, [color]);

      const del = h('button', { class: 'icon-btn icon-btn-sm', type: 'button', title: '删除色标' }, [
        icon('trash', 12),
      ]);
      del.addEventListener('click', () => {
        if (!this.editing) return;
        if (this.editing.stops.length <= 2) {
          toast('warn', '至少需要 2 个色标');
          return;
        }
        this.editing.stops.splice(i, 1);
        this.renderStops();
        this.paintPreview();
        this.applyLive();
      });

      this.stopsEl.appendChild(
        h('div', { class: 'cm-stop', style: 'grid-template-columns:16px 1fr 40px 26px 20px' }, [
          h('span', { class: 'cm-stop-idx', text: String(i + 1) }),
          pos,
          label,
          swatch,
          del,
        ])
      );
    });
    if (stops.length === 0) {
      this.stopsEl.appendChild(emptyState('没有色标，点击「添加色标」开始。'));
    }
  }

  private sortStops(): void {
    if (!this.editing) return;
    this.editing.stops.sort((a, b) => a.t - b.t);
  }

  private paintPreview(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, this.preview.clientWidth || 240);
    this.preview.width = Math.round(w * dpr);
    this.preview.height = Math.round(22 * dpr);
    const ctx = this.preview.getContext('2d');
    if (!ctx || !this.editing) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const r = this.app.store.state.render;
    paintLUT(ctx, buildLUT(this.editing.stops, { reverse: r.reverse, steps: r.steps }), 0, 0, w, 22);
  }

  private applyLive(): void {
    if (this.editing) this.app.previewColormap(this.editing.stops);
  }

  private save(): void {
    if (!this.editing) return;
    const name = this.nameInput.value.trim() || '自定义色卡';
    const id = this.editing.id || `custom_${Date.now().toString(36)}`;
    this.app.saveCustomColormap(id, name, this.editing.stops.map((s) => ({ ...s })));
    this.editing.id = id;
    this.editing.name = name;
    this.refresh();
    this.syncSelection();
  }

  private exportJson(): void {
    const list = customColormaps();
    if (list.length === 0) {
      toast('warn', '还没有自定义色卡', '先点击「从此复制」再保存。');
      return;
    }
    this.app.exportColormaps(list);
  }
}

function miniButton(name: 'plus' | 'copy' | 'save' | 'download' | 'upload', label: string, onClick: () => void, primary = false): HTMLElement {
  const b = h('button', { class: `btn btn-sm${primary ? ' btn-primary' : ''}`, type: 'button' }, [
    icon(name, 12),
    h('span', { text: label }),
  ]);
  b.addEventListener('click', onClick);
  return b;
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.replace('#', ''), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}
