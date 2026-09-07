/**
 * Application orchestrator.
 *
 * Owns the state store, the WebGL viewer and every interaction; the panels in
 * `src/ui/*` are pure views over `App` + `App.store`.
 */

import {
  CloudView, computeStats, uid,
  type AttributeStats, type PointCloudData,
} from './core/cloud';
import {
  buildLUT, customColormaps, getColormap, guessColormapFor, guessUnitFor, registerColormap,
  type ColorStop, type ColormapDef,
} from './core/colormap';
import { downsampleIndices, type DownsampleOptions } from './core/downsample';
import { applyFilters, createRule, type FilterLogic, type FilterRule } from './core/filters';
import { sampleProfile, type ProfileMethod } from './core/profile';
import { createDemoCloud } from './core/demo';
import { sanitizeCloud, validateCloud } from './core/validate';
import {
  Store, effectiveRange,
  type EffectiveRange, type InteractMode, type MeasureRecord,
  type RangeMapping, type RenderState, type StoreEvent, type Vec3,
} from './core/state';
import { SUPPORTED_FORMATS, formatBytes, isTextColumnFormat, loadPointCloud, extOf } from './io';
import { yieldUI } from './io/common';
import { previewTextColumns } from './io/text';
import type { ColumnSelection } from './io/common';
import { askColumnSelection } from './ui/columnDialog';
import { openImageExportDialog } from './ui/exportDialog';
import {
  downloadText, profileCSV, serializePreset, copyText,
  viewToCSV, viewToPCD, viewToPLY,
} from './io/export';
import { Viewer, type PickResult } from './render/Viewer';
import { AxisGizmo, HoverCard, InfoHud, Legend, type HoverEntry } from './ui/legend';
import { createDataPanel } from './ui/panelData';
import { createFunctionsPanel } from './ui/panelFunctions';
import { createSettingsPanel } from './ui/panelSettings';
import { fmtInt, fmtNum, h, icon, toast } from './ui/dom';
import type { Option } from './ui/controls';
import {
  t, setLang, getLang, onLangChange, initLang, applyPageI18n, type Lang,
} from './i18n';

const LS_COLORMAPS = 'pci.colormaps.v1';
const LS_THEME = 'pci.theme';

/** Default 3D viewport background per UI theme (the user can override it). */
const THEME_BG: Record<'dark' | 'light', string> = { dark: '#0a0d12', light: '#e9eef5' };

interface DomRefs {
  app: HTMLElement;
  workspace: HTMLElement;
  viewport: HTMLElement;
  canvas: HTMLCanvasElement;
  leftTabs: HTMLElement;
  leftBody: HTMLElement;
  rightTabs: HTMLElement;
  rightBody: HTMLElement;
  dock: HTMLElement;
  dockTabs: HTMLElement;
  dockBody: HTMLElement;
  topbarActions: HTMLElement;
  modeSwitch: HTMLElement;
  statusbar: HTMLElement;
  vpTopLeft: HTMLElement;
  vpTopRight: HTMLElement;
  vpBottomLeft: HTMLElement;
  welcome: HTMLElement;
  welcomeFormats: HTMLElement;
  loadingVeil: HTMLElement;
  loadingLabel: HTMLElement;
  loadingBar: HTMLElement;
  dropzone: HTMLElement;
  measureHint: HTMLElement;
  fileInput: HTMLInputElement;
  lutInput: HTMLInputElement;
}

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(t('error.domNode', { id }));
  return node as T;
}

function grabDom(): DomRefs {
  return {
    app: el('app'),
    workspace: el('viewport').parentElement as HTMLElement,
    viewport: el('viewport'),
    canvas: el<HTMLCanvasElement>('gl'),
    leftTabs: el('leftTabs'),
    leftBody: el('leftBody'),
    rightTabs: el('rightTabs'),
    rightBody: el('rightBody'),
    dock: el('dock'),
    dockTabs: el('dockTabs'),
    dockBody: el('dockBody'),
    topbarActions: el('topbarActions'),
    modeSwitch: el('modeSwitch'),
    statusbar: el('statusbar'),
    vpTopLeft: el('vpTopLeft'),
    vpTopRight: el('vpTopRight'),
    vpBottomLeft: el('vpBottomLeft'),
    welcome: el('welcome'),
    welcomeFormats: el('welcomeFormats'),
    loadingVeil: el('loadingVeil'),
    loadingLabel: el('loadingLabel'),
    loadingBar: el('loadingBar'),
    dropzone: el('dropzone'),
    measureHint: el('measureHint'),
    fileInput: el<HTMLInputElement>('fileInput'),
    lutInput: el<HTMLInputElement>('lutInput'),
  };
}

export class App {
  readonly store = new Store();
  readonly viewer: Viewer;

  /** Currently effective colour range (kept in sync for panels / legend). */
  effRange: EffectiveRange = { lo: 0, hi: 1, dataMin: 0, dataMax: 1, clipped: false };
  /** Ray-picking tolerance multiplier. */
  pickScale = 1.4;
  pixelRatioCap = 2;
  /** Baked LUT currently uploaded to the shader. */
  lut: Uint8Array;

  /** Pinned point (set by clicking in browse mode). */
  selected: PickResult | null = null;
  /** Point under the cursor. */
  hovered: PickResult | null = null;

  private dom: DomRefs;
  private legend = new Legend();
  private gizmo = new AxisGizmo();
  private hud!: InfoHud;
  private hoverCard: HoverCard;
  private hoverCardEl: HTMLElement;

  private previewStops: ColorStop[] | null = null;
  private zStats: AttributeStats | null = null;
  private zFor: CloudView | null = null;
  /** Current legend annotation (label / unit / visibility) — feeds the image-export dialog defaults. */
  private legendInfo = { label: '', unit: '', visible: false };

  private pointer = { x: 0, y: 0, inside: false };
  private pickQueued = false;
  private down = { x: 0, y: 0, moved: false };
  private filterTimer = 0;
  private measureTimer = 0;
  private lastRecordKey = '';
  private statusItems = new Map<string, HTMLElement>();
  /** Unsubscribe handles for the three panels, so we can tear them down on a language rebuild. */
  private panelDisposers: Array<() => void> = [];

  /** Active colour scheme; mirrors <html data-theme>. */
  private theme: 'dark' | 'light' = 'dark';
  private themeBtn: HTMLButtonElement | null = null;
  /** Whether the 3D background still tracks the theme default (vs user override). */
  private bgThemeLinked = true;

  constructor() {
    this.dom = grabDom();
    this.viewer = new Viewer(this.dom.canvas);
    this.lut = buildLUT(getColormap('turbo')?.stops ?? []);
    this.hoverCardEl = el('hoverCard');
    this.hoverCard = new HoverCard(this.hoverCardEl, this.dom.viewport);
  }

  get state() {
    return this.store.state;
  }

  /* ════════════════════════════════════════════════════════════
     Boot
     ════════════════════════════════════════════════════════════ */

  start(): void {
    initLang();
    this.initTheme();
    this.loadCustomColormaps();
    this.mountWelcomeButtons(); // static buttons, bound once

    // App reacts first so panels always read up-to-date derived values.
    this.store.on((events) => this.sync(events));

    // Visual mounts — re-run on language change via rebuildUI().
    this.mountTopbar();
    this.mountModeSwitch();
    this.mountViewportLayers();
    this.mountWelcome();
    this.buildStatusbar();
    this.mountPanels();

    this.mountDropzone();
    this.mountFileInputs();
    this.mountPointer();
    this.mountKeys();
    this.mountResizers();
    this.mountResize();

    this.viewer.controls.addEventListener('change', () => this.updateGizmo());
    this.viewer.onFrame = (fps) => {
      this.hud.set('fps', `${fps.toFixed(0)} fps`);
    };

    onLangChange(() => this.rebuildUI());
    applyPageI18n();

    this.applyLayout();
    this.updateGizmo();
    this.pushAll();
  }

  /** Build the three panels, collecting their store unsubscribers. */
  private mountPanels(): void {
    this.panelDisposers.push(createSettingsPanel(this, this.dom.leftBody, this.dom.leftTabs));
    this.panelDisposers.push(createFunctionsPanel(this, this.dom.rightBody, this.dom.rightTabs));
    this.panelDisposers.push(createDataPanel(this, this.dom.dockBody, this.dom.dockTabs));
  }

  /**
   * Tear down and rebuild every runtime-built UI element so all strings are
   * re-translated for the newly selected language.
   */
  private rebuildUI(): void {
    for (const d of this.panelDisposers) d();
    this.panelDisposers = [];

    this.dom.topbarActions.innerHTML = '';
    this.dom.modeSwitch.innerHTML = '';
    this.dom.vpTopLeft.innerHTML = '';
    this.dom.vpTopRight.innerHTML = '';
    this.dom.vpBottomLeft.innerHTML = '';
    this.dom.welcomeFormats.innerHTML = '';
    this.dom.statusbar.innerHTML = '';
    this.dom.leftTabs.innerHTML = '';
    this.dom.leftBody.innerHTML = '';
    this.dom.rightTabs.innerHTML = '';
    this.dom.rightBody.innerHTML = '';
    this.dom.dockTabs.innerHTML = '';
    this.dom.dockBody.innerHTML = '';

    this.mountTopbar();
    this.mountModeSwitch();
    this.mountViewportLayers();
    this.mountWelcome();
    this.buildStatusbar();
    this.mountPanels();
    applyPageI18n();

    this.applyLayout();
    this.pushAll();
  }

  /** Bind the static welcome buttons once (their markup lives in index.html). */
  private mountWelcomeButtons(): void {
    document.getElementById('welcomePick')?.addEventListener('click', () => this.dom.fileInput.click());
    document.getElementById('welcomeDemo')?.addEventListener('click', () => void this.loadDemo());
  }

  /* ────────── top bar ────────── */

  private mountTopbar(): void {
    const host = this.dom.topbarActions;
    const open = h('button', { class: 'btn btn-primary btn-sm', type: 'button' }, [
      icon('upload', 13),
      h('span', { text: t('topbar.open') }),
    ]);
    open.addEventListener('click', () => this.dom.fileInput.click());

    const demo = h('button', { class: 'btn btn-sm', type: 'button' }, [
      icon('cube', 13),
      h('span', { text: t('topbar.demo') }),
    ]);
    demo.addEventListener('click', () => void this.loadDemo());

    const shot = h('button', { class: 'btn btn-sm', type: 'button', title: t('topbar.exportTitle') }, [
      icon('camera', 13),
      h('span', { text: t('topbar.export') }),
    ]);
    shot.addEventListener('click', () => this.openImageExport());

    const fit = h('button', { class: 'btn btn-sm', type: 'button', title: t('topbar.frame') }, [
      icon('frame', 13),
    ]);
    fit.addEventListener('click', () => this.frameAll());

    const full = h('button', { class: 'btn btn-sm', type: 'button', title: t('topbar.fullscreen') }, [
      icon('grid', 13),
    ]);
    full.addEventListener('click', () => {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void this.dom.app.requestFullscreen().catch(() => undefined);
    });

    const themeBtn = h('button', {
      class: 'btn btn-sm', type: 'button', id: 'themeToggle',
      title: t('topbar.themeTitle'),
    }) as HTMLButtonElement;
    themeBtn.addEventListener('click', () => this.toggleTheme());
    this.themeBtn = themeBtn;
    this.updateThemeButton();

    // ── Custom language selector (replaces the native <select>) ──
    // A button + popup menu so we control the look fully and stay theme-aware
    // instead of falling back to the OS-native select chrome.
    const LANGS: { value: Lang; label: string }[] = [
      { value: 'zh', label: '中文' },
      { value: 'en', label: 'English' },
    ];
    const langRoot = h('div', { class: 'lang' });
    const langLabel = h('span', { class: 'lang-label' });
    const globe = icon('globe', 14);
    const caret = icon('chevron', 12);
    caret.setAttribute('class', 'lang-caret');
    const langBtn = h('button', {
      class: 'lang-btn', type: 'button',
      title: t('app.lang'), 'aria-label': t('app.lang'),
      'aria-haspopup': 'listbox', 'aria-expanded': 'false',
    }, [globe, langLabel, caret]) as HTMLButtonElement;

    const menu = h('div', { class: 'lang-menu', role: 'listbox' });
    const optEls = new Map<Lang, HTMLButtonElement>();
    for (const o of LANGS) {
      const check = icon('check', 13);
      check.setAttribute('class', 'lang-check');
      const opt = h('button', {
        class: 'lang-opt', type: 'button', role: 'option',
        'data-lang': o.value, title: o.label,
      }, [check, h('span', { text: o.label })]) as HTMLButtonElement;
      opt.addEventListener('click', () => {
        closeMenu();
        if (getLang() !== o.value) setLang(o.value);
      });
      optEls.set(o.value, opt);
      menu.appendChild(opt);
    }
    langRoot.append(langBtn, menu);

    const syncLang = (): void => {
      const cur = getLang();
      langLabel.textContent = LANGS.find((l) => l.value === cur)?.label ?? cur;
      for (const [v, el] of optEls) el.classList.toggle('is-on', v === cur);
    };
    syncLang();

    let langOpen = false;
    const onDocClick = (e: MouseEvent): void => {
      if (!langRoot.contains(e.target as Node)) closeMenu();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { closeMenu(); langBtn.focus(); return; }
      if (!langOpen) return;
      const opts = LANGS.map((l) => optEls.get(l.value)!);
      let idx = opts.findIndex((o) => o === document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); idx = (idx + 1) % opts.length; opts[idx].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); idx = (idx - 1 + opts.length) % opts.length; opts[idx].focus(); }
    };
    const openMenu = (): void => {
      if (langOpen) return;
      langOpen = true;
      langRoot.classList.add('is-open');
      langBtn.setAttribute('aria-expanded', 'true');
      const first = LANGS[0] ? optEls.get(LANGS[0].value) : undefined;
      (optEls.get(getLang()) ?? first)?.focus();
      document.addEventListener('click', onDocClick, true);
      document.addEventListener('keydown', onKey, true);
    };
    const closeMenu = (): void => {
      if (!langOpen) return;
      langOpen = false;
      langRoot.classList.remove('is-open');
      langBtn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('click', onDocClick, true);
      document.removeEventListener('keydown', onKey, true);
    };
    const toggleMenu = (): void => (langOpen ? closeMenu() : openMenu());
    langBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });

    host.append(open, demo, h('div', { class: 'sep' }), shot, fit, full, themeBtn, langRoot);
  }

  /* ────────── theme ────────── */

  private initTheme(): void {
    const stored = localStorage.getItem(LS_THEME);
    const theme: 'dark' | 'light' =
      stored === 'light' || stored === 'dark' ? stored : 'light';
    this.applyTheme(theme, true);
  }

  private toggleTheme(): void {
    this.applyTheme(this.theme === 'dark' ? 'light' : 'dark', true);
  }

  private applyTheme(theme: 'dark' | 'light', persist: boolean): void {
    this.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.setAttribute('content', theme);
    if (persist) {
      try { localStorage.setItem(LS_THEME, theme); } catch { /* ignore */ }
    }
    // Keep the 3D viewport background in sync with the theme until the user
    // picks a custom colour.
    if (this.bgThemeLinked) {
      this.state.render.background = THEME_BG[theme];
      this.store.emit('render');
    }
    this.updateThemeButton();
  }

  private updateThemeButton(): void {
    if (!this.themeBtn) return;
    const dark = this.theme === 'dark';
    this.themeBtn.innerHTML = '';
    this.themeBtn.appendChild(icon(dark ? 'sun' : 'moon', 14));
    this.themeBtn.title = dark ? t('topbar.themeToLight') : t('topbar.themeToDark');
    this.themeBtn.setAttribute('aria-label', this.themeBtn.title);
  }

  private mountModeSwitch(): void {
    const host = this.dom.modeSwitch;
    const modes: { id: InteractMode; label: string; icon: 'hand' | 'crosshair' }[] = [
      { id: 'orbit', label: t('mode.orbit'), icon: 'hand' },
      { id: 'measure', label: t('mode.measure'), icon: 'crosshair' },
    ];
    for (const m of modes) {
      const b = h('button', { class: 'mode-btn', type: 'button', title: t('mode.title') }, [
        icon(m.icon, 14),
        h('span', { text: m.label }),
      ]);
      b.addEventListener('click', () => this.setMode(m.id));
      b.dataset.mode = m.id;
      host.appendChild(b);
    }
  }

  private mountViewportLayers(): void {
    this.hud = new InfoHud(t('hud.title'), [
      { key: 'points', label: t('hud.points') },
      { key: 'fps', label: t('hud.fps') },
      { key: 'bbox', label: t('hud.bbox') },
      { key: 'camdist', label: t('hud.camdist') },
    ]);
    this.dom.vpTopLeft.appendChild(this.hud.el);
    this.dom.vpTopRight.appendChild(this.gizmo.el);
    this.dom.vpBottomLeft.appendChild(this.legend.el);

    const hint = this.dom.measureHint;
    hint.innerHTML = '';
    hint.appendChild(
      h('div', {}, [
        h('b', { text: t('hint.measureTitle') }),
        h('div', { class: 'dim', text: t('hint.measureBody') }),
      ])
    );
  }

  private mountWelcome(): void {
    const host = this.dom.welcomeFormats;
    for (const f of SUPPORTED_FORMATS) {
      host.appendChild(
        h('span', { class: 'chip', title: t(`fmt.${f.ext}`), text: f.label })
      );
    }
  }

  /* ────────── file inputs ────────── */

  private mountFileInputs(): void {
    const fi = this.dom.fileInput;
    fi.accept = SUPPORTED_FORMATS.map((f) => `.${f.ext}`).join(',');
    fi.addEventListener('change', () => {
      const files = Array.from(fi.files ?? []);
      fi.value = '';
      if (files.length) void this.loadFile(files[0]);
      if (files.length > 1) {
        toast('info', t('toast.singleFile'), t('toast.singleFileDesc', { name: files[0].name, n: files.length - 1 }));
      }
    });

    this.dom.lutInput.addEventListener('change', () => {
      const f = this.dom.lutInput.files?.[0];
      this.dom.lutInput.value = '';
      if (f) void this.importColormaps(f);
    });
  }

  /* ────────── drag & drop ────────── */

  private mountDropzone(): void {
    let depth = 0;
    const show = (on: boolean) => {
      this.dom.dropzone.hidden = !on;
    };
    window.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      depth++;
      show(true);
    });
    window.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
    });
    window.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) show(false);
    });
    window.addEventListener('drop', (e) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      depth = 0;
      show(false);
      const f = e.dataTransfer.files[0];
      void this.loadFile(f);
    });
  }

  /* ────────── pointer interaction ────────── */

  private mountPointer(): void {
    const c = this.dom.canvas;
    c.addEventListener('pointermove', (e) => {
      const rect = c.getBoundingClientRect();
      this.pointer.x = e.clientX - rect.left;
      this.pointer.y = e.clientY - rect.top;
      this.pointer.inside = true;
      if (this.down.moved) return;
      this.queuePick();
    });
    c.addEventListener('pointerleave', () => {
      this.pointer.inside = false;
      this.setHovered(null);
    });
    c.addEventListener('pointerdown', (e) => {
      this.down.x = e.clientX;
      this.down.y = e.clientY;
      this.down.moved = false;
    });
    c.addEventListener('pointermove', (e) => {
      if (Math.abs(e.clientX - this.down.x) > 4 || Math.abs(e.clientY - this.down.y) > 4) {
        this.down.moved = true;
      }
    });
    c.addEventListener('pointerup', (e) => {
      if (e.button !== 0 || this.down.moved) return;
      const rect = c.getBoundingClientRect();
      const p = this.viewer.pick(e.clientX - rect.left, e.clientY - rect.top, this.pickScale * 1.5);
      if (!p) return;
      if (this.state.ui.mode === 'measure') this.pushEndpoint(p.position);
      else {
        this.selected = p;
        this.store.emit('hover');
      }
    });
  }

  private queuePick(): void {
    if (this.pickQueued) return;
    this.pickQueued = true;
    requestAnimationFrame(() => {
      this.pickQueued = false;
      if (!this.pointer.inside) return;
      if (this.state.stage !== 'ready') return;
      this.setHovered(this.viewer.pick(this.pointer.x, this.pointer.y, this.pickScale));
    });
  }

  private setHovered(p: PickResult | null): void {
    this.hovered = p;
    this.viewer.setHover(p);
    this.state.hoverIndex = p ? p.viewIndex : null;

    if (!p) {
      this.hoverCard.hide();
      this.legend.setHoverValue(null);
    } else {
      this.hoverCard.show(
        this.pointer.x, this.pointer.y,
        t('hover.point', { n: p.sourceIndex.toLocaleString() }),
        this.hoverEntries(p.viewIndex)
      );
      const r = this.state.render;
      if (r.colorMode === 'attribute' && r.attribute) {
        this.legend.setHoverValue(this.state.view?.valueAt(r.attribute, p.viewIndex) ?? null);
      } else if (r.colorMode === 'elevation') {
        this.legend.setHoverValue(p.position[2]);
      } else {
        this.legend.setHoverValue(null);
      }
    }
    this.store.emit('hover');
  }

  /** Full data rows for a view index (coordinates + every scalar). */
  hoverEntries(viewIndex: number): HoverEntry[] {
    const view = this.state.view;
    const src = this.state.source;
    if (!view || !src) return [];
    const pos = view.positionAt(viewIndex);
    const out: HoverEntry[] = [
      { key: 'X', value: fmtNum(pos[0], 4) },
      { key: 'Y', value: fmtNum(pos[1], 4) },
      { key: 'Z', value: fmtNum(pos[2], 4) },
    ];
    const r = this.state.render;
    const { lo, hi } = this.effRange;
    for (const name of src.scalarOrder) {
      const v = view.valueAt(name, viewIndex);
      const entry: HoverEntry = {
        key: name + (src.units.get(name) ? ` (${src.units.get(name)})` : ''),
        value: Number.isFinite(v) ? fmtNum(v) : '—',
      };
      if (r.colorMode === 'attribute' && r.attribute === name && Number.isFinite(v)) {
        const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo || 1)));
        const i = Math.round(t * 255) * 3;
        entry.swatch = `rgb(${this.lut[i]},${this.lut[i + 1]},${this.lut[i + 2]})`;
        entry.strong = true;
      }
      out.push(entry);
    }
    const colors = view.colors;
    if (colors) {
      const r0 = colors[viewIndex * 3];
      const g0 = colors[viewIndex * 3 + 1];
      const b0 = colors[viewIndex * 3 + 2];
      out.push({ key: 'RGB', value: `${r0}, ${g0}, ${b0}`, swatch: `rgb(${r0},${g0},${b0})` });
    }
    return out;
  }

  /* ────────── keyboard ────────── */

  private mountKeys(): void {
    window.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      const meta = e.ctrlKey || e.metaKey;

      if (meta && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        this.dom.fileInput.click();
        return;
      }
      if (meta && ['1', '2', '3'].includes(e.key)) {
        e.preventDefault();
        this.togglePanel(e.key === '1' ? 'left' : e.key === '2' ? 'right' : 'dock');
        return;
      }
      if (meta) return;

      switch (e.key) {
        case '1':
          if (this.state.source?.scalarOrder.length) this.setRender({ colorMode: 'attribute' });
          break;
        case '2':
          if (this.state.source?.colors) this.setRender({ colorMode: 'rgb' });
          break;
        case '3':
          this.setRender({ colorMode: 'elevation' });
          break;
        case '4':
          this.setRender({ colorMode: 'uniform' });
          break;
        case 'f':
        case 'F':
          this.frameAll();
          break;
        case 'm':
        case 'M':
          this.setMode(this.state.ui.mode === 'measure' ? 'orbit' : 'measure');
          break;
        case 'Escape':
          if (this.state.ui.mode === 'measure') this.clearMeasure();
          else if (this.selected) {
            this.selected = null;
            this.store.emit('hover');
          }
          break;
        case ' ':
          e.preventDefault();
          this.setRender({ turntable: !this.state.render.turntable });
          break;
        default:
          break;
      }
    });
  }

  /* ────────── layout ────────── */

  private togglePanel(which: 'left' | 'right' | 'dock'): void {
    const ui = this.state.ui;
    if (which === 'left') ui.leftOpen = !ui.leftOpen;
    else if (which === 'right') ui.rightOpen = !ui.rightOpen;
    else ui.dockOpen = !ui.dockOpen;
    this.applyLayout();
    this.store.emit('ui');
    requestAnimationFrame(() => this.viewer.resize());
  }

  private applyLayout(): void {
    const ui = this.state.ui;
    this.dom.workspace.classList.toggle('no-left', !ui.leftOpen);
    this.dom.workspace.classList.toggle('no-right', !ui.rightOpen);
    this.dom.dock.classList.toggle('collapsed', !ui.dockOpen);
    this.dom.modeSwitch.querySelectorAll<HTMLElement>('.mode-btn').forEach((b) => {
      b.classList.toggle('is-on', b.dataset.mode === ui.mode);
    });
    this.dom.measureHint.hidden = ui.mode !== 'measure';
    this.dom.viewport.classList.toggle('picking', ui.mode === 'measure');
  }

  private mountResizers(): void {
    const root = document.documentElement;
    for (const handle of Array.from(document.querySelectorAll<HTMLElement>('[data-resize]'))) {
      const kind = handle.dataset.resize;
      handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        handle.classList.add('dragging');
        const startX = e.clientX;
        const startY = e.clientY;
        const startW = kind === 'left'
          ? parseFloat(getComputedStyle(root).getPropertyValue('--panel-l-w'))
          : parseFloat(getComputedStyle(root).getPropertyValue('--panel-r-w'));
        const startH = parseFloat(getComputedStyle(root).getPropertyValue('--dock-h'));

        const move = (ev: PointerEvent) => {
          if (kind === 'left') {
            root.style.setProperty('--panel-l-w', `${clamp(startW + ev.clientX - startX, 220, 520)}px`);
          } else if (kind === 'right') {
            root.style.setProperty('--panel-r-w', `${clamp(startW - (ev.clientX - startX), 220, 520)}px`);
          } else {
            root.style.setProperty('--dock-h', `${clamp(startH - (ev.clientY - startY), 120, 620)}px`);
          }
          this.viewer.resize();
        };
        const up = () => {
          handle.classList.remove('dragging');
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', up);
          this.viewer.resize();
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
      });
    }

    document.getElementById('leftCollapse')?.addEventListener('click', () => this.togglePanel('left'));
    document.getElementById('rightCollapse')?.addEventListener('click', () => this.togglePanel('right'));
    document.getElementById('dockToggle')?.addEventListener('click', () => this.togglePanel('dock'));
    // Expand tabs (visible only when panel is collapsed)
    document.getElementById('leftExpand')?.addEventListener('click', () => this.togglePanel('left'));
    document.getElementById('rightExpand')?.addEventListener('click', () => this.togglePanel('right'));
  }

  private mountResize(): void {
    const ro = new ResizeObserver(() => this.viewer.resize());
    ro.observe(this.dom.viewport);
    window.addEventListener('resize', () => this.viewer.resize());
  }

  /* ════════════════════════════════════════════════════════════
     Loading
     ════════════════════════════════════════════════════════════ */

  private setLoading(on: boolean, label?: string, ratio?: number): void {
    this.dom.loadingVeil.hidden = !on;
    if (label) this.dom.loadingLabel.textContent = label;
    if (ratio !== undefined) {
      this.dom.loadingBar.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
    }
  }

  async loadFile(file: File): Promise<void> {
    const st = this.state;
    const ext = extOf(file.name);

    // Delimited-text formats don't guarantee that the first three columns are
    // X / Y / Z, so we ask the user to pick the coordinate layout up front.
    let selection: ColumnSelection | null = null;
    if (isTextColumnFormat(ext)) {
      try {
        const preview = await previewTextColumns(file);
        selection = await askColumnSelection(preview);
      } catch (err) {
        this.setLoading(false);
        const msg = err instanceof Error ? err.message : String(err);
        toast('err', t('toast.colRead'), msg);
        return;
      }
      if (!selection) {
        // User dismissed the dialog — abort the load.
        this.setLoading(false);
        return;
      }
    }

    st.stage = 'loading';
    this.setLoading(true, t('loading.parse', { name: file.name }), 0.02);
    await yieldUI();
    const t0 = performance.now();
    try {
      const outcome = await loadPointCloud(
        file,
        (ratio, label) => {
          this.setLoading(true, label, 0.05 + ratio * 0.8);
        },
        selection
      );
      this.setLoading(true, t('loading.validate'), 0.9);
      await yieldUI();

      const cleaned = sanitizeCloud(outcome.data);
      const data = cleaned.data;
      const warnings = [...outcome.warnings, ...data.warnings];
      if (cleaned.removed > 0) warnings.push(t('toast.removedInvalid', { n: cleaned.removed.toLocaleString() }));

      const validation = validateCloud(data);
      if (data.count === 0) {
        this.setLoading(false);
        st.stage = st.source ? 'ready' : 'empty';
        st.validation = validation;
        this.store.emit('meta');
        toast('err', t('toast.noUsablePoints'), t('toast.noUsablePointsDesc'));
        return;
      }

      st.source = data;
      st.fileInfo = {
        name: file.name,
        size: file.size,
        format: data.format,
        parseMs: performance.now() - t0,
      };
      st.validation = validation;
      st.filters = { rules: [], logic: 'and' };
      this.resetMeasureKeepField();

      if (st.autoDownsample && validation.needsDownsample) {
        st.downsample = {
          ...st.downsample,
          method: 'voxel',
          target: validation.suggestedTarget,
          voxelSize: 0,
        };
      }

      this.pickDefaultAttribute(data);
      this.rebuild();
      st.stage = 'ready';
      this.frameAll();
      this.store.emit('cloud', 'render', 'filters', 'meta');

      const errs = validation.issues.filter((i) => i.level === 'err');
      if (errs.length) toast('err', errs[0].title, errs[0].desc);
      else if (validation.needsDownsample) {
        toast('warn', t('toast.autoDs'),
          t('toast.autoDsDesc', { src: fmtInt(data.sourceCount), view: fmtInt(st.view?.count ?? 0) }));
      } else {
        toast('ok', t('toast.loaded', { name: file.name }),
          t('toast.loadedDesc', { count: fmtInt(data.count), size: formatBytes(file.size), sec: ((performance.now() - t0) / 1000).toFixed(2) }));
      }
      for (const w of warnings.slice(0, 3)) toast('info', t('toast.parseHint'), w);
    } catch (err) {
      this.setLoading(false);
      st.stage = st.source ? 'ready' : 'empty';
      this.store.emit('meta');
      const msg = err instanceof Error ? err.message : String(err);
      toast('err', t('toast.parseFail'), msg);
    } finally {
      this.setLoading(false);
    }
  }

  async loadDemo(): Promise<void> {
    const st = this.state;
    st.stage = 'loading';
    this.setLoading(true, t('loading.demo'), 0.15);
    await yieldUI();
    const t0 = performance.now();
    const data = createDemoCloud();
    this.setLoading(true, t('loading.check'), 0.8);
    await yieldUI();

    st.source = data;
    st.fileInfo = {
      name: 'demo_motor_winding',
      size: data.count * 32,
      format: 'DEMO',
      parseMs: performance.now() - t0,
    };
    st.validation = validateCloud(data);
    st.filters = { rules: [], logic: 'and' };
    this.resetMeasureKeepField();
    this.pickDefaultAttribute(data);
    this.rebuild();
    st.stage = 'ready';
    this.frameAll();
    this.store.emit('cloud', 'render', 'filters', 'meta');
    this.setLoading(false);
    toast('ok', t('toast.demoLoaded'), t('toast.demoLoadedDesc'));
  }

  closeCloud(): void {
    const st = this.state;
    st.source = null;
    st.baseView?.dispose();
    st.view?.dispose();
    st.baseView = null;
    st.view = null;
    st.fileInfo = null;
    st.validation = null;
    st.profile = null;
    st.filters = { rules: [], logic: 'and' };
    st.hoverIndex = null;
    st.stage = 'empty';
    this.selected = null;
    this.hovered = null;
    this.hoverCard.hide();
    this.zFor = null;
    this.zStats = null;
    this.resetMeasureKeepField();
    this.viewer.setView(null);
    this.store.emit('cloud', 'render', 'filters', 'measure', 'profile', 'hover', 'meta');
  }

  /* ════════════════════════════════════════════════════════════
     Pipeline
     ════════════════════════════════════════════════════════════ */

  /** Rebuild baseView (downsample) and view (filter) from the source cloud. */
  rebuild(): void {
    const st = this.state;
    const src = st.source;
    if (!src) return;

    st.baseView?.dispose();
    st.view?.dispose();

    const full = CloudView.full(src);
    const dsIdx = downsampleIndices(full, st.downsample);
    const baseView = new CloudView(src, dsIdx);
    const filtIdx = applyFilters(baseView, st.filters.rules, st.filters.logic);
    const view = new CloudView(src, filtIdx);

    st.baseView = baseView;
    st.view = view;
    src.downsampled = dsIdx.length < src.count;
    this.zFor = null;
    this.zStats = null;
    this.selected = null;
    this.hovered = null;
    this.hoverCard.hide();
    this.viewer.setView(view);
    this.viewer.setEndpoints(st.measure.a, st.measure.b);
    if (st.measure.a && st.measure.b) this.runProfile(false);
  }

  private pickDefaultAttribute(data: PointCloudData): void {
    const r = this.state.render;
    const names = data.scalarOrder;
    r.range = { ...r.range, auto: true, clipLow: 1, clipHigh: 1, log: false, symmetric: false };
    if (names.length > 0) {
      if (!names.includes(r.attribute)) r.attribute = names[0];
      r.colorMode = 'attribute';
      r.colormapId = guessColormapFor(r.attribute);
      this.state.measure.field = names[0];
    } else if (data.colors) {
      r.colorMode = 'rgb';
      r.attribute = '';
      this.state.measure.field = 'z';
    } else {
      r.colorMode = 'elevation';
      r.attribute = '';
      r.colormapId = 'terrain';
      this.state.measure.field = 'z';
    }
    this.state.measure.radius = 0;
    this.previewStops = null;
  }

  private resetMeasureKeepField(): void {
    const m = this.state.measure;
    m.a = null;
    m.b = null;
    m.aLabel = '';
    m.bLabel = '';
    m.history = [];
    m.activeId = null;
    this.lastRecordKey = '';
    this.state.profile = null;
  }

  /* ────────── downsampling ────────── */

  applyDownsample(patch: Partial<DownsampleOptions>): void {
    const st = this.state;
    st.downsample = { ...st.downsample, ...patch };
    this.rebuild();
    this.store.emit('cloud', 'render', 'meta');
    toast('info', t('toast.dsApplied'), t('toast.dsAppliedDesc', { n: fmtInt(st.view?.count ?? 0) }));
  }

  resetDownsample(): void {
    const st = this.state;
    st.downsample = { ...st.downsample, method: 'none' };
    this.rebuild();
    this.store.emit('cloud', 'render', 'meta');
    toast('ok', t('toast.dsReset'), t('toast.dsResetDesc', { n: fmtInt(st.view?.count ?? 0) }));
  }

  setAutoDownsample(on: boolean): void {
    this.state.autoDownsample = on;
    this.store.emit('meta');
  }

  /* ────────── filters ────────── */

  addFilterRule(target: string): void {
    const st = this.state;
    const view = st.baseView ?? st.view;
    if (!view) return;
    const isAxis = target.startsWith('axis:');
    const field = isAxis ? target.slice(5) : target;
    let lo = 0;
    let hi = 1;
    if (isAxis) {
      const b = view.bounds;
      const axis = field === 'x' ? 0 : field === 'y' ? 1 : 2;
      lo = b.min[axis];
      hi = b.max[axis];
    } else {
      const s = view.stats(field);
      if (s) { lo = s.p01; hi = s.p99; }
    }
    const rule = createRule(isAxis ? 'axis' : 'attr', field, lo, hi);
    st.filters.rules = [...st.filters.rules, rule];
    this.store.emit('filters');
    this.scheduleFilterApply(0);
  }

  removeFilterRule(id: string): void {
    const st = this.state;
    st.filters.rules = st.filters.rules.filter((r) => r.id !== id);
    this.store.emit('filters');
    this.scheduleFilterApply(0);
  }

  updateFilterRule(id: string, patch: Partial<FilterRule>): void {
    const st = this.state;
    st.filters.rules = st.filters.rules.map((r) => (r.id === id ? { ...r, ...patch } : r));
    this.store.emit('filters');
    this.scheduleFilterApply();
  }

  setFilterLogic(logic: FilterLogic): void {
    this.state.filters.logic = logic;
    this.store.emit('filters');
    this.scheduleFilterApply(0);
  }

  clearFilters(): void {
    this.state.filters = { rules: [], logic: this.state.filters.logic };
    this.store.emit('filters');
    this.scheduleFilterApply(0);
  }

  scheduleFilterApply(delay = 280): void {
    window.clearTimeout(this.filterTimer);
    this.filterTimer = window.setTimeout(() => this.applyFiltersNow(), delay);
  }

  applyFiltersNow(): void {
    window.clearTimeout(this.filterTimer);
    if (!this.state.source) return;
    this.rebuild();
    this.store.emit('cloud', 'render', 'meta');
  }

  /* ════════════════════════════════════════════════════════════
     Appearance
     ════════════════════════════════════════════════════════════ */

  setRender(patch: Partial<RenderState>): void {
    Object.assign(this.state.render, patch);
    if (patch.background !== undefined) this.bgThemeLinked = false;
    if (patch.turntable !== undefined) this.viewer.setTurntable(patch.turntable);
    this.store.emit('render');
  }

  setRange(patch: Partial<RangeMapping>): void {
    const r = this.state.render;
    if (patch.auto === false && r.range.auto) {
      // Seed manual bounds from whatever is currently on screen.
      r.range.min = this.effRange.lo;
      r.range.max = this.effRange.hi;
    }
    Object.assign(r.range, patch);
    this.store.emit('range');
  }

  setColormap(id: string): void {
    this.previewStops = null;
    this.state.render.colormapId = id;
    this.store.emit('render');
  }

  previewColormap(stops: ColorStop[]): void {
    this.previewStops = stops.map((s) => ({ ...s }));
    this.store.emit('render');
  }

  saveCustomColormap(id: string, name: string, stops: ColorStop[]): void {
    const def: ColormapDef = { id, name, stops: stops.map((s) => ({ ...s })), builtin: false };
    registerColormap(def);
    this.previewStops = null;
    this.state.render.colormapId = id;
    this.persistCustomColormaps();
    this.store.emit('render');
    toast('ok', t('toast.lutSaved', { name }), t('toast.lutSavedDesc'));
  }

  exportColormaps(list: ColormapDef[]): void {
    downloadText(
      JSON.stringify({ app: 'pointcloud-inspector', version: 1, colormaps: list }, null, 2),
      'colormaps.json',
      'application/json'
    );
  }

  async importColormaps(file: File): Promise<void> {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as { colormaps?: ColormapDef[] };
      const list = parsed.colormaps ?? [];
      if (!Array.isArray(list) || list.length === 0) throw new Error(t('error.noLutDef'));
      for (const cm of list) {
        if (!cm?.stops?.length) continue;
        registerColormap({
          id: cm.id || `custom_${Date.now().toString(36)}`,
          name: cm.name || cm.id || t('lut.importedName'),
          stops: cm.stops,
          builtin: false,
        });
      }
      this.persistCustomColormaps();
      this.store.emit('cloud', 'render');
      toast('ok', t('toast.lutImported', { n: list.length }));
    } catch (err) {
      toast('err', t('toast.lutImportFail'), err instanceof Error ? err.message : String(err));
    }
  }

  private loadCustomColormaps(): void {
    try {
      const raw = localStorage.getItem(LS_COLORMAPS);
      if (!raw) return;
      const list = JSON.parse(raw) as ColormapDef[];
      for (const cm of list) {
        if (cm?.id && cm.stops?.length) registerColormap({ ...cm, builtin: false });
      }
    } catch {
      /* ignore corrupt storage */
    }
  }

  private persistCustomColormaps(): void {
    try {
      localStorage.setItem(LS_COLORMAPS, JSON.stringify(customColormaps()));
    } catch {
      /* storage may be unavailable */
    }
  }

  /** Options for the "colour by" dropdown. */
  fieldOptions(): Option<string>[] {
    const src = this.state.source;
    if (!src || src.scalarOrder.length === 0) return [{ value: '', label: t('field.none') }];
    return src.scalarOrder.map((n) => {
      const u = src.units.get(n);
      return { value: n, label: u ? `${n} (${u})` : n };
    });
  }

  /** Options for filter / profile targets, axes included. */
  targetOptions(): Option<string>[] {
    const axes: Option<string>[] = [
      { value: 'axis:x', label: t('axis.x'), group: t('group.coords') },
      { value: 'axis:y', label: t('axis.y'), group: t('group.coords') },
      { value: 'axis:z', label: t('axis.z'), group: t('group.coords') },
    ];
    const attrs = this.fieldOptions().map((o) => ({ ...o, group: t('group.attrs') }));
    if (attrs.length === 1 && attrs[0].value === '') return axes;
    return [...axes, ...attrs];
  }

  /** Options for the profile field (axes + scalars). */
  profileFieldOptions(): Option<string>[] {
    return this.targetOptions();
  }

  frameAll(): void {
    const v = this.state.view;
    if (!v || v.count === 0) return;
    this.viewer.frameBounds(v.bounds, true);
  }

  setPixelRatioCap(v: number): void {
    this.pixelRatioCap = v;
    this.viewer.setPixelRatioCap(v);
    this.store.emit('ui');
  }

  setMode(mode: InteractMode): void {
    this.state.ui.mode = mode;
    if (mode === 'orbit') this.setHovered(null);
    this.applyLayout();
    this.store.emit('ui', 'measure');
  }

  /* ════════════════════════════════════════════════════════════
     Measurement / profile
     ════════════════════════════════════════════════════════════ */

  private pushEndpoint(pos: Vec3): void {
    const m = this.state.measure;
    if (!m.a || m.b) {
      m.a = [pos[0], pos[1], pos[2]];
      m.b = null;
      m.aLabel = `(${fmtNum(pos[0])}, ${fmtNum(pos[1])}, ${fmtNum(pos[2])})`;
      this.state.profile = null;
      this.store.emit('measure', 'profile');
      toast('info', t('measure.startSet'), t('measure.startHint'), 2000);
    } else {
      m.b = [pos[0], pos[1], pos[2]];
      m.bLabel = `(${fmtNum(pos[0])}, ${fmtNum(pos[1])}, ${fmtNum(pos[2])})`;
      this.store.emit('measure');
      this.runProfile(true);
    }
  }

  setMeasureField(field: string): void {
    this.state.measure.field = field;
    this.store.emit('measure');
    if (this.state.measure.a && this.state.measure.b) this.runProfile(true);
  }

  setMeasureOption(patch: {
    radius?: number;
    bins?: number;
    smooth?: number;
    method?: ProfileMethod;
  }): void {
    Object.assign(this.state.measure, patch);
    this.store.emit('measure');
    if (this.state.measure.a && this.state.measure.b) {
      window.clearTimeout(this.measureTimer);
      this.measureTimer = window.setTimeout(() => this.runProfile(false), 200);
    }
  }

  clearMeasure(): void {
    this.resetMeasureKeepField();
    this.viewer.setEndpoints(null, null);
    this.store.emit('measure', 'profile');
  }

  loadMeasureRecord(id: string): void {
    const rec = this.state.measure.history.find((r) => r.id === id);
    if (!rec) return;
    const m = this.state.measure;
    m.a = [rec.a[0], rec.a[1], rec.a[2]];
    m.b = [rec.b[0], rec.b[1], rec.b[2]];
    m.aLabel = `(${fmtNum(rec.a[0])}, ${fmtNum(rec.a[1])}, ${fmtNum(rec.a[2])})`;
    m.bLabel = `(${fmtNum(rec.b[0])}, ${fmtNum(rec.b[1])}, ${fmtNum(rec.b[2])})`;
    m.field = rec.field;
    m.activeId = rec.id;
    this.lastRecordKey = `${m.a[0]},${m.a[1]},${m.a[2]}|${m.b[0]},${m.b[1]},${m.b[2]}|${rec.field}`;
    this.store.emit('measure');
    this.runProfile(false);
  }

  runProfile(record = true): void {
    const st = this.state;
    const m = st.measure;
    const view = st.view;
    if (!view || !m.a || !m.b) {
      st.profile = null;
      this.store.emit('profile');
      return;
    }
    const field = m.field || (st.render.colorMode === 'attribute' ? st.render.attribute : 'z');
    const res = sampleProfile(view, m.a, m.b, {
      radius: m.radius,
      bins: m.bins,
      smooth: m.smooth,
      field,
      maxRaw: 6000,
      method: m.method,
    });
    st.profile = res;
    if (record && res && res.sampled > 0) {
      const key = `${m.a[0]},${m.a[1]},${m.a[2]}|${m.b[0]},${m.b[1]},${m.b[2]}|${field}`;
      if (key !== this.lastRecordKey) {
        this.lastRecordKey = key;
        const rec: MeasureRecord = {
          id: uid('m'),
          a: [m.a[0], m.a[1], m.a[2]],
          b: [m.b[0], m.b[1], m.b[2]],
          field,
          length: res.length,
          sampled: res.sampled,
          at: Date.now(),
        };
        m.history = [rec, ...m.history].slice(0, 30);
        m.activeId = rec.id;
      }
    }
    this.store.emit('profile', 'measure');
    if (res && res.sampled === 0) {
      toast('warn', t('toast.noProfileSamples'), t('toast.noProfileSamplesDesc'));
    }
  }

  /* ════════════════════════════════════════════════════════════
     Export
     ════════════════════════════════════════════════════════════ */

  /** Open the configurable image-export dialog (title / colour bar / size). */
  openImageExport(): void {
    if (!this.state.view || this.state.view.count === 0) {
      toast('warn', t('toast.noCloudExport'));
      return;
    }
    const r = this.state.render;
    openImageExportDialog({
      viewer: this.viewer,
      baseName: this.baseName(),
      lut: this.lut,
      lo: this.effRange.lo,
      hi: this.effRange.hi,
      log: r.range.log,
      legendVisible: this.legendInfo.visible,
      legendLabel: this.legendInfo.label,
      legendUnit: this.legendInfo.unit,
      background: r.background,
    });
  }

  exportPoints(format: 'csv' | 'ply' | 'pcd', scope: 'view' | 'source'): void {
    const st = this.state;
    if (!st.source) return;
    const view = scope === 'source' ? CloudView.full(st.source) : st.view;
    if (!view || view.count === 0) {
      toast('warn', t('toast.noPointsExport'));
      return;
    }
    const fields = st.source.scalarOrder;
    const name = `${this.baseName()}_${scope === 'source' ? 'all' : 'view'}_${fmtInt(view.count).replace(/,/g, '')}`;
    if (view.count > 4_000_000) {
      toast('warn', t('toast.tooManyPoints'), t('toast.tooManyPointsDesc'));
    }
    const text = format === 'csv' ? viewToCSV(view, fields)
      : format === 'ply' ? viewToPLY(view, fields)
      : viewToPCD(view, fields);
    downloadText(text, `${name}.${format}`, format === 'csv' ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8');
    toast('ok', t('toast.cloudExported'), `${name}.${format}`);
  }

  /** The exported/copied table text for the current section. */
  private profileTable(): string | null {
    const res = this.state.profile;
    if (!res) return null;
    const src = this.state.source;
    const unit = res.field && src?.units.get(res.field) ? src.units.get(res.field)! : '';
    return profileCSV(res, unit);
  }

  exportProfileCSV(): void {
    const res = this.state.profile;
    const text = this.profileTable();
    if (!res || text === null) {
      toast('warn', t('toast.noProfile'), t('toast.noProfileDesc'));
      return;
    }
    downloadText(text, `${this.baseName()}_profile_${res.field || 'z'}.csv`, 'text/csv;charset=utf-8');
    toast('ok', t('toast.profileExported'));
  }

  /** Put the sampled curve table (distance + xyz + value) on the clipboard. */
  async copyProfileData(): Promise<void> {
    const text = this.profileTable();
    if (text === null) {
      toast('warn', t('toast.noProfile'), t('toast.noProfileDesc'));
      return;
    }
    const rows = this.state.profile!.t.length;
    const ok = await copyText(text);
    if (ok) {
      toast('ok', t('toast.profileCopied'), t('toast.profileCopiedDesc', { n: rows }));
    } else {
      toast('warn', t('toast.profileCopyFailed'), t('toast.profileCopyFailedDesc'));
    }
  }

  exportPreset(): void {
    const st = this.state;
    downloadText(
      serializePreset({
        render: st.render,
        downsample: st.downsample,
        filters: st.filters,
      }),
      `${this.baseName()}_preset.json`,
      'application/json'
    );
  }

  /* ════════════════════════════════════════════════════════════
     Reactive plumbing
     ════════════════════════════════════════════════════════════ */

  private sync(events: Set<StoreEvent>): void {
    if (events.has('cloud')) this.onCloudChanged();
    if (events.has('cloud') || events.has('render') || events.has('range')) this.pushRender();
    if (events.has('measure')) this.pushMeasureOverlay();
    this.pushStatus();
  }

  private onCloudChanged(): void {
    const st = this.state;
    this.dom.welcome.hidden = st.stage === 'ready';
    this.zFor = null;
    this.zStats = null;
  }

  private pushMeasureOverlay(): void {
    const m = this.state.measure;
    this.viewer.setEndpoints(m.a, m.b);
  }

  private elevationStats(): AttributeStats | null {
    const view = this.state.view;
    if (!view) return null;
    if (this.zFor !== view) {
      const p = view.positions;
      const n = view.count;
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = p[i * 3 + 2];
      this.zFor = view;
      this.zStats = computeStats('z', out);
    }
    return this.zStats;
  }

  private pushRender(): void {
    const st = this.state;
    const view = st.view;
    const r = st.render;

    const stops = this.previewStops ?? getColormap(r.colormapId)?.stops ?? getColormap('turbo')?.stops ?? [];
    this.lut = buildLUT(stops, { reverse: r.reverse, steps: r.steps });

    if (!view || view.count === 0) {
      this.effRange = { lo: 0, hi: 1, dataMin: 0, dataMax: 1, clipped: false };
      this.viewer.applySettings({
        colorMode: r.colorMode,
        uniformColor: r.uniformColor,
        pointSize: r.pointSize,
        sizeMode: r.sizeMode,
        shape: r.shape,
        opacity: r.opacity,
        lut: this.lut,
        min: 0,
        max: 1,
        background: r.background,
        showGrid: 'none',
        showBox: false,
        showAxes: false,
        colorGain: r.colorGain,
      });
      this.viewer.setHelpers(null, { grid: 'none', box: false, axes: false });
      this.legendInfo = { label: '', unit: '', visible: false };
      this.legend.update({
        lut: this.lut, lo: 0, hi: 1, log: false, label: '', unit: '', stats: null, visible: false,
      });
      this.hud.set('points', '0');
      this.hud.set('bbox', '—');
      return;
    }

    let label = '';
    let unit = '';
    let stats: AttributeStats | null = null;
    let values: Float32Array | null = null;

    if (r.colorMode === 'attribute' && r.attribute) {
      values = view.values(r.attribute);
      stats = view.stats(r.attribute);
      label = r.attribute;
      unit = st.source?.units.get(r.attribute) ?? guessUnitFor(r.attribute);
      this.effRange = effectiveRange(r.range, stats);
    } else if (r.colorMode === 'elevation') {
      stats = this.elevationStats();
      label = t('field.elevation');
      this.effRange = effectiveRange(r.range, stats);
    } else {
      this.effRange = { lo: 0, hi: 1, dataMin: 0, dataMax: 1, clipped: false };
    }

    this.viewer.setValueAttribute(r.colorMode === 'attribute' ? values : null);
    this.viewer.applySettings({
      colorMode: r.colorMode,
      uniformColor: r.uniformColor,
      pointSize: r.pointSize,
      sizeMode: r.sizeMode,
      shape: r.shape,
      opacity: r.opacity,
      lut: this.lut,
      min: this.effRange.lo,
      max: this.effRange.hi,
      background: r.background,
      showGrid: r.grid,
      showBox: r.showBox,
      showAxes: r.showAxes,
      colorGain: r.colorGain,
    });
    this.viewer.setHelpers(view.bounds, { grid: r.grid, box: r.showBox, axes: r.showAxes });

    const visible = r.colorMode === 'attribute' || r.colorMode === 'elevation';
    this.legendInfo = {
      label: label || (r.colorMode === 'rgb' ? t('field.rgb') : t('field.uniform')),
      unit,
      visible,
    };
    this.legend.update({
      lut: this.lut,
      lo: this.effRange.lo,
      hi: this.effRange.hi,
      log: r.range.log,
      label: this.legendInfo.label,
      unit,
      stats,
      visible,
    });
    if (visible && r.range.auto) {
      const span = this.effRange.dataMax - this.effRange.dataMin || 1;
      this.legend.setClipMarkers(
        clamp((this.effRange.lo - this.effRange.dataMin) / span, 0, 1),
        clamp((this.effRange.hi - this.effRange.dataMin) / span, 0, 1)
      );
    }

    const b = view.bounds;
    this.hud.set('points', fmtInt(view.count));
    this.hud.set(
      'bbox',
      `${fmtNum(b.max[0] - b.min[0])} × ${fmtNum(b.max[1] - b.min[1])} × ${fmtNum(b.max[2] - b.min[2])}`
    );
  }

  private buildStatusbar(): void {
    const host = this.dom.statusbar;
    host.innerHTML = '';
    const defs: [string, boolean][] = [
      ['state', true],
      ['file', false],
      ['points', false],
      ['field', false],
      ['mode', false],
      ['hover', false],
      ['fps', false],
    ];
    for (const [key, dot] of defs) {
      const value = h('span', { class: 'mono', text: '—' });
      if (dot) {
        const dotEl = h('span', { class: 'status-dot' });
        const item = h('div', { class: 'status-item' }, [dotEl, value]);
        host.appendChild(item);
        this.statusItems.set(`${key}:dot`, dotEl);
        this.statusItems.set(key, value);
      } else {
        const item = h('div', { class: 'status-item' }, [
          h('span', { class: 'dim', text: statusLabels()[key] ?? key }),
          value,
        ]);
        host.appendChild(item);
        this.statusItems.set(key, value);
      }
    }
    host.appendChild(h('div', { class: 'topbar-spacer' }));
    const tipEl = h('div', { class: 'status-item' }, [
      h('span', { class: 'dim', text: t('status.tip') }),
      h('span', { class: 'mono', text: t('status.tipText') }),
    ]);
    host.appendChild(tipEl);
  }

  private pushStatus(): void {
    const st = this.state;
    const set = (k: string, v: string) => {
      const node = this.statusItems.get(k);
      if (node) node.textContent = v;
    };
    const dot = this.statusItems.get('state:dot');

    const v = st.validation;
    const verdict = !st.source ? ['', t('status.notLoaded')]
      : v && !v.ok ? ['err', t('status.invalid')]
      : v && v.needsDownsample ? ['warn', t('status.downsampled')]
      : ['ok', t('status.ok')];
    set('state', verdict[1]);
    if (dot) dot.className = `status-dot${verdict[0] ? ` ${verdict[0]}` : ''}`;

    const fi = st.fileInfo;
    set('file', fi ? `${fi.name} · ${fi.format} · ${formatBytes(fi.size)}` : '—');
    const srcCount = st.source?.sourceCount ?? 0;
    const viewCount = st.view?.count ?? 0;
    set(
      'points',
      st.source
        ? viewCount === srcCount
          ? t('status.pointsOne', { n: fmtInt(viewCount) })
          : t('status.pointsRatio', { view: fmtInt(viewCount), src: fmtInt(srcCount), pct: ((viewCount / Math.max(1, srcCount)) * 100).toFixed(1) })
        : '—'
    );

    const r = st.render;
    const fieldText = r.colorMode === 'attribute'
      ? `${t('status.fieldAttr', { name: r.attribute })}${st.source?.units.get(r.attribute) ? ` ${st.source.units.get(r.attribute)}` : ''}`
      : r.colorMode === 'elevation' ? t('field.elevation')
      : r.colorMode === 'rgb' ? t('field.rgb')
      : t('field.uniform');
    set('field', st.source ? `${fieldText} · ${this.effRangeSummary()}` : '—');
    set('mode', st.ui.mode === 'measure' ? t('mode.measure') : t('mode.orbit'));

    const hv = this.hovered;
    set('hover', hv ? `#${hv.sourceIndex} → ${fmtNum(hv.position[0])}, ${fmtNum(hv.position[1])}, ${fmtNum(hv.position[2])}` : '—');
    set('fps', st.source ? `${this.viewer.fps.toFixed(0)} fps` : '—');
    this.hud.set('camdist', fmtNum(this.viewer.camera.position.distanceTo(this.viewer.controls.target)));
  }

  private effRangeSummary(): string {
    const { lo, hi } = this.effRange;
    return `${fmtNum(lo)} → ${fmtNum(hi)}`;
  }

  private updateGizmo(): void {
    this.gizmo.update(this.viewer.camera.matrixWorldInverse.elements as unknown as number[]);
  }

  private baseName(): string {
    const n = this.state.fileInfo?.name ?? 'pointcloud';
    const i = n.lastIndexOf('.');
    return i > 0 ? n.slice(0, i) : n;
  }

  /** Called once after boot to bring every panel in sync. */
  pushAll(): void {
    this.onCloudChanged();
    this.pushRender();
    this.pushMeasureOverlay();
    this.pushStatus();
  }
}

function statusLabels(): Record<string, string> {
  return {
    state: t('status.state'),
    file: t('status.file'),
    points: t('status.points'),
    field: t('status.field'),
    mode: t('status.mode'),
    hover: t('status.hover'),
    fps: t('status.fps'),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
