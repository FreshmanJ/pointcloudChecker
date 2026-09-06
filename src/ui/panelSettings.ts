/** Left panel — appearance, colour mapping, scene and the colormap editor. */

import type { App } from '../app';
import { t } from '../i18n';
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

export function createSettingsPanel(app: App, host: HTMLElement, tabsHost: HTMLElement): () => void {
  const TAB_DEFS = [
    { id: 'display', label: t('settings.tab.display'), icon: 'sliders' as const },
    { id: 'color', label: t('settings.tab.color'), icon: 'palette' as const },
    { id: 'scene', label: t('settings.tab.scene'), icon: 'cube' as const },
    { id: 'lut', label: t('settings.tab.lut'), icon: 'layers' as const },
  ];
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

    const sec1 = section(t('settings.coloring'), { icon: 'palette' });
    const mode = segmented<'uniform' | 'attribute' | 'rgb' | 'elevation'>({
      options: [
        { value: 'attribute', label: t('mode.attribute'), title: t('mode.attributeTitle') },
        { value: 'rgb', label: t('mode.rgb'), title: t('mode.rgbTitle') },
        { value: 'elevation', label: t('mode.elevation'), title: t('mode.elevationTitle') },
        { value: 'uniform', label: t('field.uniform'), title: t('mode.uniformTitle') },
      ],
      value: R.colorMode,
      onChange: (v) => app.setRender({ colorMode: v }),
    });
    const attr = select<string>({
      label: t('ctrl.attribute'),
      options: app.fieldOptions(),
      value: R.attribute,
      onChange: (v) => app.setRender({ attribute: v }),
    }) as Control<string> & { setOptions(list: Option<string>[], keepValue?: boolean): void };
    const uniform = colorInput({
      label: t('ctrl.uniform'),
      value: R.uniformColor,
      onChange: (v) => app.setRender({ uniformColor: v }),
    });
    const gain = slider({
      label: t('ctrl.gain'),
      min: 0.3, max: 2, step: 0.01,
      value: R.colorGain,
      format: (v) => `${v.toFixed(2)}×`,
      onInput: (v) => app.setRender({ colorGain: v }),
    });
    sec1.body.appendChild(prop(t('ctrl.method'), mode.el));
    sec1.body.appendChild(attr.el);
    sec1.body.appendChild(uniform.el);
    sec1.body.appendChild(gain.el);
    p.appendChild(sec1.root);

    const sec2 = section(t('settings.pointRender'), { icon: 'dots' });
    const size = slider({
      label: t('ctrl.pointSize'),
      min: 0.5, max: 12, step: 0.1,
      value: R.pointSize,
      format: (v) => v.toFixed(1),
      onInput: (v) => app.setRender({ pointSize: v }),
    });
    const sizeMode = segmented<'fixed' | 'world'>({
      label: t('ctrl.sizeMode'),
      options: [
        { value: 'fixed', label: t('size.screen'), title: t('size.screenTitle') },
        { value: 'world', label: t('size.world'), title: t('size.worldTitle') },
      ],
      value: R.sizeMode,
      onChange: (v) => app.setRender({ sizeMode: v }),
    });
    const shape = segmented<'circle' | 'square'>({
      label: t('ctrl.shape'),
      options: [
        { value: 'circle', label: t('shape.circle') },
        { value: 'square', label: t('shape.square') },
      ],
      value: R.shape,
      onChange: (v) => app.setRender({ shape: v }),
    });
    const opacity = slider({
      label: t('ctrl.opacity'),
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
        text: t('hint.opacity'),
      })
    );
    p.appendChild(sec2.root);

    const sec3 = section(t('settings.hotkeys'), { icon: 'info', collapsed: true });
    const keys: [string, string][] = [
      ['Ctrl/⌘ + O', t('keys.open')],
      ['1 / 2 / 3 / 4', t('keys.colorModes')],
      ['F', t('keys.frame')],
      ['M', t('keys.measure')],
      ['Esc', t('keys.clear')],
      ['Ctrl + 1/2/3', t('keys.collapse')],
      [t('keys.space'), t('keys.rotate')],
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
    const sec = section(t('settings.rangeMap'), { icon: 'chart' });
    const autoRange = toggle({
      label: t('ctrl.autoRange'),
      value: R.range.auto,
      onChange: (v) => app.setRange({ auto: v }),
    });
    const clipLow = slider({
      label: t('ctrl.clipLow'),
      min: 0, max: 20, step: 0.1,
      value: R.range.clipLow,
      format: (v) => `${v.toFixed(1)}%`,
      onInput: (v) => app.setRange({ clipLow: v }),
    });
    const clipHigh = slider({
      label: t('ctrl.clipHigh'),
      min: 0, max: 20, step: 0.1,
      value: R.range.clipHigh,
      format: (v) => `${v.toFixed(1)}%`,
      onInput: (v) => app.setRange({ clipHigh: v }),
    });
    const minInput = numberInput({
      label: t('ctrl.min'),
      value: R.range.min,
      onInput: (v) => app.setRange({ min: v }),
    });
    const maxInput = numberInput({
      label: t('ctrl.max'),
      value: R.range.max,
      onInput: (v) => app.setRange({ max: v }),
    });
    const log = toggle({
      label: t('ctrl.log'),
      value: R.range.log,
      onChange: (v) => app.setRange({ log: v }),
    });
    const sym = toggle({
      label: t('ctrl.symmetric'),
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

    const sec2 = section(t('settings.barAdjust'), { icon: 'palette' });
    const reverse = toggle({
      label: t('ctrl.reverse'),
      value: R.reverse,
      onChange: (v) => app.setRender({ reverse: v }),
    });
    const steps = slider({
      label: t('ctrl.steps'),
      min: 0, max: 32, step: 1,
      value: R.steps,
      format: (v) => (v < 2 ? t('steps.continuous') : t('steps.levels', { n: v })),
      onInput: (v) => app.setRender({ steps: v }),
    });
    sec2.body.appendChild(reverse.el);
    sec2.body.appendChild(steps.el);
    sec2.body.appendChild(
      h('div', { class: 'field-hint', text: t('hint.steps') })
    );
    p.appendChild(sec2.root);

    Object.assign(controls, { reverse, steps, autoRange, minInput, maxInput, clipLow, clipHigh, log, sym });
  }

  /* ══════════ 场景 ══════════ */
  {
    const p = page('scene');
    const sec = section(t('settings.sceneEnv'), { icon: 'cube' });
    const bg = colorInput({ label: t('ctrl.bg'), value: R.background, onChange: (v) => app.setRender({ background: v }) });
    const grid = select<'none' | 'xy' | 'xz' | 'yz'>({
      label: t('ctrl.grid'),
      options: [
        { value: 'none', label: t('grid.none') },
        { value: 'xy', label: t('grid.xy') },
        { value: 'xz', label: t('grid.xz') },
        { value: 'yz', label: t('grid.yz') },
      ],
      value: R.grid,
      onChange: (v) => app.setRender({ grid: v }),
    });
    const boxT = toggle({ label: t('ctrl.showBox'), value: R.showBox, onChange: (v) => app.setRender({ showBox: v }) });
    const axes = toggle({ label: t('ctrl.showAxes'), value: R.showAxes, onChange: (v) => app.setRender({ showAxes: v }) });
    const turntable = toggle({ label: t('ctrl.turntable'), value: R.turntable, onChange: (v) => app.setRender({ turntable: v }) });
    sec.body.appendChild(bg.el);
    sec.body.appendChild(grid.el);
    sec.body.appendChild(boxT.el);
    sec.body.appendChild(axes.el);
    sec.body.appendChild(turntable.el);
    p.appendChild(sec.root);

    const sec2 = section(t('settings.view'), { icon: 'camera' });
    const views: [string, string][] = [
      ['iso', t('view.iso')], ['x', 'X+'], ['-x', 'X−'],
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
      text: t('hint.view'),
    }));

    // Rotate within a coordinate plane: XY→about Z, YZ→about X, XZ→about Y
    const rotLabel = h('div', { class: 'field-hint', text: t('rot.label') });
    sec2.body.appendChild(rotLabel);
    const planes: ['xy' | 'yz' | 'xz', string][] = [
      ['xy', t('grid.xy')], ['yz', t('grid.yz')], ['xz', t('grid.xz')],
    ];
    for (const [plane, plabel] of planes) {
      const row = h('div', { class: 'rot-row' });
      row.appendChild(h('span', { class: 'rot-plane', text: plabel }));
      for (const [sign, arrow, title] of [[-1, '↺', t('rot.ccw')], [1, '↻', t('rot.cw')]] as [number, string, string][]) {
        const b = h('button', { class: 'btn btn-sm', type: 'button', text: arrow, title });
        b.addEventListener('click', () => app.viewer.rotateInPlane(plane, sign * 15));
        row.appendChild(b);
      }
      sec2.body.appendChild(row);
    }

    const fit = h('button', { class: 'btn btn-sm btn-block', type: 'button' }, [
      icon('frame', 13), h('span', { text: t('btn.frameAll') }),
    ]);
    fit.addEventListener('click', () => app.frameAll());
    sec2.body.appendChild(fit);
    p.appendChild(sec2.root);

    const sec3 = section(t('settings.perf'), { icon: 'sliders', collapsed: true });
    const pickScale = slider({
      label: t('ctrl.pickTol'),
      min: 0.4, max: 6, step: 0.1,
      value: app.pickScale,
      format: (v) => `${v.toFixed(1)}×`,
      onInput: (v) => { app.pickScale = v; },
    });
    const pixelRatio = slider({
      label: t('ctrl.pixelRatio'),
      min: 0.5, max: 2, step: 0.25,
      value: app.pixelRatioCap,
      format: (v) => `${v.toFixed(2)}×`,
      onInput: (v) => app.setPixelRatioCap(v),
    });
    sec3.body.appendChild(pickScale.el);
    sec3.body.appendChild(pixelRatio.el);
    sec3.body.appendChild(
      h('div', { class: 'field-hint', text: t('hint.perf') })
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

  return app.store.on(sync);
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

    const secLib = section(t('lut.lib'), { icon: 'layers' });
    this.itemsEl = h('div', { class: 'cm-list' });
    secLib.body.appendChild(this.itemsEl);

    const secEdit = section(t('lut.editor'), { icon: 'wand' });
    this.preview = h('canvas', { class: 'cm-preview', style: 'height:22px' }) as HTMLCanvasElement;
    secEdit.body.appendChild(this.preview);

    this.nameInput = h('input', { class: 'input', placeholder: t('lut.namePlaceholder') }) as HTMLInputElement;
    this.nameInput.addEventListener('input', () => {
      if (this.editing) this.editing.name = this.nameInput.value;
    });
    secEdit.body.appendChild(prop(t('lut.name'), this.nameInput));

    this.stopsEl = h('div', { class: 'cm-stops' });
    secEdit.body.appendChild(this.stopsEl);

    const actions = h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' }, [
      miniButton('plus', t('lut.add'), () => this.addStop()),
      miniButton('copy', t('lut.duplicate'), () => this.duplicate()),
      miniButton('save', t('lut.save'), () => this.save(), true),
    ]);
    secEdit.body.appendChild(actions);

    const io = h('div', { class: 'row', style: 'gap:6px' }, [
      miniButton('download', t('lut.export'), () => this.exportJson()),
      miniButton('upload', t('lut.import'), () => {
        (document.getElementById('lutInput') as HTMLInputElement | null)?.click();
      }),
    ]);
    secEdit.body.appendChild(io);
    secEdit.body.appendChild(
      h('div', {
        class: 'field-hint',
        text: t('lut.hint'),
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
      name: cm.builtin ? `${cm.name}${t('lut.copySuffix')}` : cm.name,
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
      name: this.nameInput.value || t('lut.customName'),
      stops: this.editing.stops.map((s) => ({ ...s })),
    };
    this.renderStops();
    toast('info', t('lut.copied'), t('lut.copiedDesc'));
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

      const del = h('button', { class: 'icon-btn icon-btn-sm', type: 'button', title: t('lut.deleteStop') }, [
        icon('trash', 12),
      ]);
      del.addEventListener('click', () => {
        if (!this.editing) return;
        if (this.editing.stops.length <= 2) {
          toast('warn', t('lut.needTwo'));
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
      this.stopsEl.appendChild(emptyState(t('lut.emptyStops')));
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
    const name = this.nameInput.value.trim() || t('lut.customName');
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
      toast('warn', t('lut.noCustom'), t('lut.noCustomDesc'));
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
