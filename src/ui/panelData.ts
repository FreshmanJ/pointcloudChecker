/** Bottom dock — global statistics, attribute table, compliance report,
 *  the profile chart and live hover / selection readouts. */

import type { App } from '../app';
import type { AttributeStats } from '../core/cloud';
import { LUT_SIZE } from '../core/colormap';
import type { Issue } from '../core/validate';
import type { ProfileMethod } from '../core/profile';
import { ProfileChart, type ChartHover } from './chart';
import { t } from '../i18n';
import { fmtInt, fmtNum, h, icon } from './dom';
import { emptyState, hint, numberInput, section, buttonRow, select, slider } from './controls';
import { rgbBytesToHex } from '../core/colormap';

interface DockPage {
  el: HTMLElement;
  sync(): void;
}

export function createDataPanel(app: App, host: HTMLElement, tabsHost: HTMLElement): () => void {
  const TAB_DEFS = [
    { id: 'stats', label: t('dock.tab.stats'), icon: 'bars' as const },
    { id: 'attrs', label: t('dock.tab.attrs'), icon: 'table' as const },
    { id: 'report', label: t('dock.tab.report'), icon: 'checkCircle' as const },
    { id: 'profile', label: t('dock.tab.profile'), icon: 'chart' as const },
    { id: 'hover', label: t('dock.tab.hover'), icon: 'target' as const },
  ];
  const pages = new Map<string, DockPage>();

  const show = (id: string): void => {
    for (const [k, p] of pages) p.el.hidden = k !== id;
    tabsHost.querySelectorAll<HTMLElement>('.tab').forEach((t) => {
      t.classList.toggle('is-on', t.dataset.tab === id);
    });
    if (id === 'profile') pages.get('profile')?.sync();
    if (id === 'attrs') pages.get('attrs')?.sync();
  };

  tabsHost.innerHTML = '';
  for (const t of TAB_DEFS) {
    const b = h('button', { class: 'tab', type: 'button', 'data-tab': t.id }, [
      icon(t.icon, 13),
      h('span', { text: t.label }),
    ]);
    b.addEventListener('click', () => {
      app.state.ui.dockTab = t.id;
      show(t.id);
    });
    tabsHost.appendChild(b);
  }

  pages.set('stats', buildStatsPage(app));
  pages.set('attrs', buildAttrsPage(app));
  pages.set('report', buildReportPage(app));
  pages.set('profile', buildProfilePage(app));
  pages.set('hover', buildHoverPage(app));

  for (const t of TAB_DEFS) host.appendChild(pages.get(t.id)!.el);
  show(app.state.ui.dockTab);

  const sync = (events: Set<string>): void => {
    if (events.has('ui')) {
      const id = app.state.ui.dockTab;
      if (pages.has(id)) show(id);
    }
    if (events.has('cloud') || events.has('render') || events.has('range') || events.has('filters') || events.has('meta')) {
      pages.get('stats')?.sync();
      pages.get('attrs')?.sync();
      pages.get('report')?.sync();
    }
    if (events.has('profile') || events.has('measure')) pages.get('profile')?.sync();
    if (events.has('hover') || events.has('cloud')) pages.get('hover')?.sync();
  };

  const off = app.store.on(sync);
  sync(new Set(['cloud', 'render', 'range', 'filters', 'profile', 'hover', 'meta', 'ui']));
  return off;
}

/* ══════════════════════════════════════════════════════════════
   Statistics
   ══════════════════════════════════════════════════════════════ */

function buildStatsPage(app: App): DockPage {
  const el = h('div', { class: 'dock-page' });
  const grid = h('div', { class: 'stat-grid' });
  const rangeBox = h('div', { style: 'margin-top:12px' });
  el.append(grid, rangeBox);

  const sync = (): void => {
    const st = app.state;
    const view = st.view;
    grid.innerHTML = '';
    rangeBox.innerHTML = '';

    if (!view || view.count === 0) {
      el.appendChild(emptyState(t('stats.empty'), 'bars'));
      return;
    }

    const b = view.bounds;
    const sx = b.max[0] - b.min[0];
    const sy = b.max[1] - b.min[1];
    const sz = b.max[2] - b.min[2];
    const vol = Math.max(sx * sy * sz, 1e-12);
    const diag = view.diagonal;
    const v = st.validation;

    const cards: [string, string, string?][] = [
      [t('stats.srcCount'), fmtInt(st.source?.sourceCount ?? 0)],
      [t('stats.viewCount'), fmtInt(view.count), st.source?.downsampled ? t('stats.downsampled') : undefined],
      [t('stats.bboxX'), fmtNum(sx)],
      [t('stats.bboxY'), fmtNum(sy)],
      [t('stats.bboxZ'), fmtNum(sz)],
      [t('stats.diag'), fmtNum(diag)],
      [t('stats.density'), `${fmtNum(view.count / vol)}${t('stats.densityUnit')}`],
      [t('stats.spacing'), fmtNum(Math.cbrt(vol / Math.max(1, view.count)))],
      [t('stats.invalid'), fmtInt(v?.invalidPoints ?? 0)],
      [t('stats.dupRatio'), `${(((v?.duplicateRatio) ?? 0) * 100).toFixed(1)} %`],
      [t('stats.attrCount'), String(st.source?.scalarOrder.length ?? 0)],
      [t('stats.mem'), `${(( (st.source?.count ?? 0) * (12 + 3 + (st.source?.scalarOrder.length ?? 0) * 4) ) / 1048576).toFixed(1)}${t('stats.mb')}`],
    ];
    for (const [k, val, sub] of cards) grid.appendChild(statCard(k, val, sub));

    rangeBox.appendChild(
      h('div', { class: 'table-wrap' }, [
        dataTable(
          [t('stats.tableAxis'), t('stats.tableMin'), t('stats.tableMax'), t('stats.tableCenter'), t('stats.tableSpan')],
          (['X', 'Y', 'Z'] as const).map((axis, i) => [
            axis,
            fmtNum(b.min[i]),
            fmtNum(b.max[i]),
            fmtNum((b.min[i] + b.max[i]) / 2),
            fmtNum([sx, sy, sz][i]),
          ])
        ),
      ])
    );
  };

  return { el, sync };
}

function statCard(k: string, v: string, sub?: string): HTMLElement {
  return h('div', { class: 'stat-card' }, [
    h('div', { class: 'stat-card-k', text: k }),
    h('div', { class: 'stat-card-v', text: v }),
    sub ? h('div', { class: 'stat-card-sub', text: sub }) : null,
  ]);
}

function dataTable(head: string[], rows: string[][]): HTMLTableElement {
  const thead = h('thead', {}, [
    h('tr', {}, head.map((c, i) => h('th', { class: i === 0 ? '' : 'num-col', text: c }))),
  ]);
  const tbody = h('tbody', {}, rows.map((r) =>
    h('tr', {}, r.map((c, i) => h('td', { class: i === 0 ? 'name-col' : 'num-col', text: c })))
  ));
  return h('table', { class: 'data' }, [thead, tbody]);
}

/* ══════════════════════════════════════════════════════════════
   Attributes
   ══════════════════════════════════════════════════════════════ */

function buildAttrsPage(app: App): DockPage {
  const el = h('div', { class: 'dock-page' });
  const tableBox = h('div', { class: 'table-wrap' });
  const histBox = h('div', { class: 'col', style: 'gap:8px;margin-top:12px' });
  el.append(tableBox, histBox);

  const sync = (): void => {
    const st = app.state;
    const view = st.view;
    const src = st.source;
    tableBox.innerHTML = '';
    histBox.innerHTML = '';

    if (!view || !src || src.scalarOrder.length === 0) {
      el.appendChild(emptyState(t('attrs.empty'), 'table'));
      return;
    }

    const rows: string[][] = [];
    const active = st.render.colorMode === 'attribute' ? st.render.attribute : '';
    for (const name of src.scalarOrder) {
      const s = view.stats(name);
      if (!s) continue;
      rows.push([
        name,
        src.units.get(name) ?? '—',
        fmtNum(s.min),
        fmtNum(s.max),
        fmtNum(s.mean),
        fmtNum(s.p50),
        fmtNum(s.std),
        fmtNum(s.p01),
        fmtNum(s.p99),
        fmtInt(s.valid),
        fmtInt(s.invalid),
      ]);
    }
    const table = dataTable(
      [t('attrs.tableAttr'), t('attrs.tableUnit'), t('attrs.tableMin'), t('attrs.tableMax'), t('attrs.tableMean'), t('attrs.tableMedian'), t('attrs.tableStd'), t('attrs.tableP01'), t('attrs.tableP99'), t('attrs.tableValid'), t('attrs.tableInvalid')],
      rows
    );
    Array.from(table.querySelectorAll<HTMLElement>('tbody tr')).forEach((tr, i) => {
      const name = src.scalarOrder[i];
      if (!name) return;
      if (name === active) tr.classList.add('is-active');
      tr.style.cursor = 'pointer';
      tr.title = t('attrs.useAttr', { name });
      tr.addEventListener('click', () => {
        app.setRender({ colorMode: 'attribute', attribute: name });
        app.setMeasureField(name);
      });
    });
    tableBox.appendChild(table);

    histBox.appendChild(h('div', { class: 'label', text: t('attrs.hist') }));
    for (const name of src.scalarOrder) {
      const s = view.stats(name);
      if (!s) continue;
      const cv = h('canvas', { class: 'hist-canvas' }) as HTMLCanvasElement;
      const isActive = name === active;
      const lo = isActive ? app.effRange.lo : undefined;
      const hi = isActive ? app.effRange.hi : undefined;
      histBox.appendChild(
        h('div', { class: 'hist-row' }, [
          h('div', { class: 'hist-name', text: name, title: `${name}${src.units.get(name) ?? ''}` }),
          cv,
        ])
      );
      requestAnimationFrame(() => paintHist(cv, s, app.lut, lo, hi));
    }
    histBox.appendChild(hint(t('attrs.histHint')));
  };

  return { el, sync };
}

function paintHist(
  cv: HTMLCanvasElement,
  s: AttributeStats,
  lut: Uint8Array,
  clipLo?: number,
  clipHi?: number
): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, cv.clientWidth || 200);
  const hgt = Math.max(1, cv.clientHeight || 46);
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(hgt * dpr);
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, hgt);

  const hist = s.histogram;
  let peak = 0;
  for (let i = 0; i < hist.length; i++) if (hist[i] > peak) peak = hist[i];
  if (peak <= 0) return;

  const span = s.max - s.min || 1;
  const cLo = clipLo !== undefined ? (clipLo - s.min) / span : 0;
  const cHi = clipHi !== undefined ? (clipHi - s.min) / span : 1;
  const bw = w / hist.length;

  for (let i = 0; i < hist.length; i++) {
    const bh = (hist[i] / peak) * (hgt - 2);
    const t = i / (hist.length - 1);
    const k = Math.round(t * (LUT_SIZE - 1)) * 3;
    const inRange = t >= cLo && t <= cHi;
    ctx.fillStyle = inRange
      ? rgbBytesToHex(lut[k] ?? 90, lut[k + 1] ?? 120, lut[k + 2] ?? 160)
      : 'rgba(120,132,150,0.22)';
    ctx.fillRect(i * bw, hgt - bh, Math.max(1, bw - 0.4), bh);
  }
}

/* ══════════════════════════════════════════════════════════════
   Compliance report
   ══════════════════════════════════════════════════════════════ */

function buildReportPage(app: App): DockPage {
  const el = h('div', { class: 'dock-page' });
  const list = h('div', { class: 'report-list' });
  el.appendChild(list);

  const sync = (): void => {
    const v = app.state.validation;
    list.innerHTML = '';
    if (!v) {
      el.appendChild(emptyState(t('report.empty'), 'checkCircle'));
      return;
    }
    if (v.issues.length === 0) {
      el.appendChild(emptyState(t('report.clean'), 'checkCircle'));
      return;
    }
    for (const issue of v.issues) list.appendChild(reportItem(issue));
  };

  return { el, sync };
}

function reportItem(issue: Issue): HTMLElement {
  const name: 'checkCircle' | 'alert' | 'info' = issue.level === 'ok'
    ? 'checkCircle'
    : issue.level === 'err' || issue.level === 'warn'
      ? 'alert'
      : 'info';
  return h('div', { class: `report-item ${issue.level}` }, [
    icon(name, 15),
    h('div', { class: 'report-item-body' }, [
      h('div', { class: 'report-item-title', text: issue.title }),
      issue.desc ? h('div', { class: 'report-item-desc', text: issue.desc }) : null,
    ]),
  ]);
}

/* ══════════════════════════════════════════════════════════════
   Profile chart
   ══════════════════════════════════════════════════════════════ */

function buildProfilePage(app: App): DockPage {
  const el = h('div', { class: 'chart-page', style: 'padding:12px 14px' });
  const chart = new ProfileChart();
  const box = h('div', { class: 'chart-canvas-box' }, [chart.el]);

  // ── sampling settings ──
  const secSample = section(t('profile.sampleTitle'), { icon: 'sliders' });

  const samples = numberInput({
    label: t('profile.samples'),
    value: app.state.measure.bins,
    step: 1,
    min: 2,
    max: 2000,
    onInput: (v) => app.setMeasureOption({ bins: clampSamples(v) }),
  });

  const method = select<ProfileMethod>({
    label: t('profile.method'),
    options: [
      { value: 'idw', label: t('profile.methodIdw') },
      { value: 'mean', label: t('profile.methodMean') },
      { value: 'nearest', label: t('profile.methodNearest') },
    ],
    value: app.state.measure.method,
    onChange: (v) => app.setMeasureOption({ method: v }),
  });

  const radius = slider({
    label: t('profile.radius'),
    min: 0,
    max: 100,
    step: 0.5,
    value: radiusTFromValue(app, app.state.measure.radius),
    format: (v) => (v <= 0 ? t('profile.radiusAuto') : fmtNum(radiusFromT(app, v))),
    onInput: (v) => app.setMeasureOption({ radius: v <= 0 ? 0 : radiusFromT(app, v) }),
  });

  secSample.body.appendChild(samples.el);
  secSample.body.appendChild(method.el);
  secSample.body.appendChild(radius.el);
  secSample.body.appendChild(hint(t('profile.methodHint')));

  // ── stats ──
  const statsGrid = h('div', { class: 'chart-stats' });
  const readoutMain = h('div', { class: 'mono dim', style: 'font-size:11px', text: t('profile.hoverReadout') });
  const readoutXyz = h('div', { class: 'mono dim', style: 'font-size:11px;opacity:.75' });
  const readout = h('div', { class: 'chart-readout' }, [readoutMain, readoutXyz]);

  // ── data actions ──
  const copyBtn = h('button', { class: 'btn btn-sm', type: 'button' }, [
    icon('copy', 13),
    h('span', { text: t('profile.copyData') }),
  ]);
  copyBtn.addEventListener('click', () => void app.copyProfileData());

  const csvBtn = h('button', { class: 'btn btn-sm', type: 'button' }, [
    icon('download', 13),
    h('span', { text: t('profile.exportTable') }),
  ]);
  csvBtn.addEventListener('click', () => app.exportProfileCSV());

  const actions = h('div', { class: 'col', style: 'gap:6px' }, [
    buttonRow([copyBtn, csvBtn]),
    hint(t('profile.exportHint')),
  ]);

  const side = h('div', { class: 'chart-side' }, [secSample.root, statsGrid, readout, actions]);
  el.appendChild(h('div', { class: 'chart-wrap' }, [box, side]));

  chart.onHover = (hv: ChartHover | null) => {
    readoutMain.textContent = hv
      ? t('profile.hoverFmt', { d: fmtNum(hv.distance), v: fmtNum(hv.value), u: unitOf(app) })
      : t('profile.hoverReadout');
    readoutXyz.textContent = hv
      ? `${fmtNum(hv.x)}, ${fmtNum(hv.y)}, ${fmtNum(hv.z)}`
      : '';
  };

  let lastSig = '';

  const sync = (): void => {
    const st = app.state;
    const res = st.profile;
    const has = !!res && res.sampled > 0;

    samples.set(st.measure.bins);
    method.set(st.measure.method);
    radius.set(radiusTFromValue(app, st.measure.radius));
    copyBtn.toggleAttribute('disabled', !has);
    csvBtn.toggleAttribute('disabled', !has);

    const sig = res
      ? `${res.field}|${res.length}|${res.sampled}|${res.method}|${res.radius}|${res.t.length}|${st.measure.field}`
      : 'none';
    if (sig !== lastSig) {
      lastSig = sig;
      const label = res?.field ? (res.field === 'z' ? t('field.elevation') : res.field) : '';
      chart.setData(res, label, unitOf(app));
    }

    statsGrid.innerHTML = '';
    if (!res || res.sampled === 0) {
      statsGrid.style.gridColumn = '1 / -1';
      statsGrid.appendChild(emptyState(t('profile.chartEmpty'), 'chart'));
      return;
    }
    statsGrid.style.gridColumn = '';
    const s = res.stats;
    const u = unitOf(app);
    const items: [string, string][] = [
      [t('profile.length'), fmtNum(res.length)],
      [t('profile.sampled'), fmtInt(res.sampled)],
      [t('profile.start'), `${fmtNum(s.start)}${u}`],
      [t('profile.end'), `${fmtNum(s.end)}${u}`],
      [t('profile.minmax'), `${fmtNum(s.min)} / ${fmtNum(s.max)}`],
      [t('profile.meanSigma'), `${fmtNum(s.mean)} ± ${fmtNum(s.std)}`],
      [t('profile.peakAt'), fmtNum(s.maxAt)],
      [t('profile.trend'), `${fmtNum(s.trend)}${u}/${t('profile.perUnit')}`],
    ];
    for (const [k, v] of items) {
      statsGrid.appendChild(
        h('div', { class: 'mini-stat' }, [
          h('div', { class: 'mini-stat-k', text: k }),
          h('div', { class: 'mini-stat-v', text: v }),
        ])
      );
    }
  };

  return { el, sync };
}

function clampSamples(v: number): number {
  return Math.max(2, Math.min(2000, Math.round(Number.isFinite(v) ? v : 120)));
}

function unitOf(app: App): string {
  const st = app.state;
  const field = st.profile?.field || st.measure.field;
  if (!field) return '';
  const u = st.source?.units.get(field);
  return u ? ` ${u}` : '';
}

function clampNum(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function radiusFromT(app: App, t: number): number {
  const diag = app.state.view?.diagonal ?? 1;
  return (t / 100) * diag * 0.05;
}

function radiusTFromValue(app: App, v: number): number {
  const diag = app.state.view?.diagonal ?? 1;
  return clampNum((v / (diag * 0.05)) * 100, 0, 100);
}

/* ══════════════════════════════════════════════════════════════
   Hover / selection
   ══════════════════════════════════════════════════════════════ */

function buildHoverPage(app: App): DockPage {
  const el = h('div', { class: 'dock-page' });
  const wrap = h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:14px' });
  const hoverBox = h('div', { class: 'col', style: 'gap:6px' });
  const selBox = h('div', { class: 'col', style: 'gap:6px' });
  wrap.append(hoverBox, selBox);
  el.appendChild(wrap);

  const sync = (): void => {
    hoverBox.innerHTML = '';
    selBox.innerHTML = '';

    hoverBox.appendChild(h('div', { class: 'label', text: t('hover.live') }));
    const hv = app.hovered;
    if (!hv || !app.state.view) {
      hoverBox.appendChild(emptyState(t('hover.empty'), 'target'));
    } else {
      hoverBox.appendChild(entryTable(app, hv.viewIndex, hv.sourceIndex));
    }

    selBox.appendChild(h('div', { class: 'label', text: t('hover.selected') }));
    const sel = app.selected;
    if (!sel || !app.state.view) {
      selBox.appendChild(emptyState(t('hover.selectedEmpty'), 'target'));
    } else {
      selBox.appendChild(entryTable(app, sel.viewIndex, sel.sourceIndex));
      const clear = h('button', { class: 'btn btn-sm', type: 'button' }, [
        icon('close', 12),
        h('span', { text: t('hover.deselect') }),
      ]);
      clear.addEventListener('click', () => {
        app.selected = null;
        app.store.emit('hover');
      });
      selBox.appendChild(clear);
    }
  };

  return { el, sync };
}

function entryTable(app: App, viewIndex: number, sourceIndex: number): HTMLElement {
  const rows = app.hoverEntries(viewIndex).map((e) => [
    e.key,
    e.value,
    e.swatch ? rgbBytesToHex(...hexToBytes(e.swatch)) : '',
  ]);
  const table = dataTable([t('hover.item'), t('hover.value')], rows.map((r) => [r[0], r[1]]));
  const body = table.querySelector('tbody');
  if (body) {
    Array.from(body.children).forEach((tr, i) => {
      const sw = rows[i][2];
      if (!sw) return;
      const first = tr.firstElementChild as HTMLElement | null;
      if (first) {
        first.innerHTML = '';
        first.appendChild(h('span', { class: 'attr-swatch', style: `background:${sw}` }));
        first.appendChild(document.createTextNode(rows[i][0]));
      }
    });
  }
  return h('div', {}, [
    h('div', { class: 'field-hint', text: t('hover.index', { src: sourceIndex, view: viewIndex }) }),
    h('div', { class: 'table-wrap', style: 'margin-top:6px' }, [table]),
  ]);
}

function hexToBytes(css: string): [number, number, number] {
  const m = css.match(/(\d+)\D+(\d+)\D+(\d+)/);
  if (!m) return [120, 132, 150];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
