/** Right panel — file info, downsampling, filters, profile analysis, export. */

import type { App } from '../app';
import type { CloudView } from '../core/cloud';
import type { FilterRule } from '../core/filters';
import { formatBytes } from '../io';
import { t } from '../i18n';
import { fmtInt, fmtNum, h, icon, toast } from './dom';
import {
  buttonRow, check, dualRange, emptyState, hint, numberInput, prop, section, segmented,
  select, slider, toggle,
} from './controls';

export function createFunctionsPanel(app: App, host: HTMLElement, tabsHost: HTMLElement): () => void {
  const TAB_DEFS = [
    { id: 'file', label: t('func.tab.file'), icon: 'file' as const },
    { id: 'sample', label: t('func.tab.sample'), icon: 'grid' as const },
    { id: 'filter', label: t('func.tab.filter'), icon: 'filter' as const },
    { id: 'profile', label: t('func.tab.profile'), icon: 'scissors' as const },
    { id: 'export', label: t('func.tab.export'), icon: 'download' as const },
  ];
  const pages = new Map<string, HTMLElement>();

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

  tabsHost.innerHTML = '';
  for (const t of TAB_DEFS) {
    const b = h('button', { class: 'tab', type: 'button', 'data-tab': t.id }, [
      icon(t.icon, 13),
      h('span', { text: t.label }),
    ]);
    b.addEventListener('click', () => {
      app.state.ui.rightTab = t.id;
      show(t.id);
    });
    tabsHost.appendChild(b);
  }

  const file = buildFilePage(app);
  const sample = buildSamplePage(app);
  const filter = buildFilterPage(app);
  const profile = buildProfilePage(app);
  const exp = buildExportPage(app);

  for (const t of TAB_DEFS) page(t.id);
  page('file').appendChild(file.root);
  page('sample').appendChild(sample.root);
  page('filter').appendChild(filter.root);
  page('profile').appendChild(profile.root);
  page('export').appendChild(exp.root);

  for (const t of TAB_DEFS) host.appendChild(page(t.id));
  show(app.state.ui.rightTab);

  const sync = (events: Set<string>): void => {
    if (events.has('cloud') || events.has('meta') || events.has('filters')) file.sync();
    if (events.has('cloud') || events.has('meta') || events.has('filters')) sample.sync();
    if (events.has('cloud') || events.has('filters')) filter.sync();
    if (events.has('cloud') || events.has('measure') || events.has('profile')) profile.sync();
    if (events.has('cloud') || events.has('profile')) exp.sync();
  };

  const off = app.store.on(sync);
  sync(new Set(['cloud', 'filters', 'measure', 'profile', 'meta']));
  return off;
}

/* ══════════════════════════════════════════════════════════════
   File page
   ══════════════════════════════════════════════════════════════ */

interface PageHandle {
  root: HTMLElement;
  sync(): void;
}

function buildFilePage(app: App): PageHandle {
  const secInfo = section(t('file.info'), { icon: 'file' });
  const infoBody = h('div', { class: 'col', style: 'gap:4px' });
  secInfo.body.appendChild(infoBody);

  const secMeta = section(t('file.meta'), { icon: 'info', collapsed: true });
  const metaBody = h('div', { class: 'col', style: 'gap:4px' });
  secMeta.body.appendChild(metaBody);

  const secCheck = section(t('file.check'), { icon: 'checkCircle' });
  const checkBody = h('div', { class: 'col', style: 'gap:6px' });
  secCheck.body.appendChild(checkBody);

  const secAttr = section(t('file.attr'), { icon: 'layers' });
  const attrBody = h('div', { class: 'col', style: 'gap:4px' });
  secAttr.body.appendChild(attrBody);

  const secOps = section(t('file.ops'), { icon: 'refresh', collapsed: true });
  const closeBtn = h('button', { class: 'btn btn-sm btn-danger btn-block', type: 'button' }, [
    icon('trash', 13),
    h('span', { text: t('file.close') }),
  ]);
  closeBtn.addEventListener('click', () => {
    app.closeCloud();
    toast('info', t('toast.cloudClosed'));
  });
  const demoBtn = h('button', { class: 'btn btn-sm btn-block', type: 'button' }, [
    icon('cube', 13),
    h('span', { text: t('file.loadDemo') }),
  ]);
  demoBtn.addEventListener('click', () => void app.loadDemo());
  secOps.body.appendChild(demoBtn);
  secOps.body.appendChild(closeBtn);

  const root = h('div', {}, [secInfo.root, secCheck.root, secAttr.root, secMeta.root, secOps.root]);

  const sync = (): void => {
    const st = app.state;
    const src = st.source;

    infoBody.innerHTML = '';
    if (!src || !st.fileInfo) {
      infoBody.appendChild(emptyState(t('file.noCloud'), 'file'));
    } else {
      const fi = st.fileInfo;
      const b = st.view?.bounds;
      const rows: [string, string][] = [
        [t('file.name'), fi.name],
        [t('file.format'), `${fi.format} · ${formatBytes(fi.size)}`],
        [t('file.parseMs'), `${(fi.parseMs / 1000).toFixed(2)} s`],
        [t('sample.srcCount'), fmtInt(src.sourceCount)],
        [t('stats.viewCount'), fmtInt(st.view?.count ?? 0)],
        [t('file.downsampled'), src.downsampled ? t('file.yes') : t('file.no')],
        [t('file.bbox'), b ? `${fmtNum(b.max[0] - b.min[0])} × ${fmtNum(b.max[1] - b.min[1])} × ${fmtNum(b.max[2] - b.min[2])}` : '—'],
      ];
      for (const [k, v] of rows) infoBody.appendChild(infoRow(k, v));
    }

    metaBody.innerHTML = '';
    const meta = src?.meta ?? {};
    const keys = Object.keys(meta);
    if (keys.length === 0) metaBody.appendChild(emptyState(t('file.noMeta')));
    for (const k of keys) metaBody.appendChild(infoRow(k, meta[k]));

    checkBody.innerHTML = '';
    const v = st.validation;
    if (!v) {
      checkBody.appendChild(emptyState(t('file.notChecked')));
    } else {
      const errs = v.issues.filter((i) => i.level === 'err').length;
      const warns = v.issues.filter((i) => i.level === 'warn').length;
      secCheck.setBadge(errs ? t('check.errors', { n: errs }) : warns ? t('check.warns', { n: warns }) : t('check.pass'));
      checkBody.appendChild(infoRow(t('file.verdict'), errs ? t('file.invalid') : v.needsDownsample ? t('file.compliantDs') : t('file.compliant')));
      checkBody.appendChild(infoRow(t('file.invalidCoords'), fmtInt(v.invalidPoints)));
      checkBody.appendChild(infoRow(t('file.dupRatio'), `${(v.duplicateRatio * 100).toFixed(1)} %`));
      const reportBtn = h('button', { class: 'btn btn-sm btn-block', type: 'button' }, [
        icon('list', 13),
        h('span', { text: t('file.viewReport') }),
      ]);
      reportBtn.addEventListener('click', () => {
        app.state.ui.dockOpen = true;
        app.state.ui.dockTab = 'report';
        app.store.emit('ui');
      });
      checkBody.appendChild(reportBtn);
    }

    attrBody.innerHTML = '';
    if (!src || src.scalarOrder.length === 0) {
      attrBody.appendChild(emptyState(t('file.noAttr'), 'layers'));
    } else {
      for (const name of src.scalarOrder) {
        const unit = src.units.get(name) ?? '';
        const use = h('button', { class: 'btn btn-sm', type: 'button', title: t('file.useAttr') }, [
          icon('palette', 12),
        ]);
        use.addEventListener('click', () => {
          app.setRender({ colorMode: 'attribute', attribute: name });
          app.setMeasureField(name);
        });
        const row = h('div', { class: 'row', style: 'justify-content:space-between;gap:6px' }, [
          h('span', { class: 'truncate mono', text: name, title: name }),
          h('span', { class: 'row', style: 'gap:6px' }, [
            h('span', { class: 'field-hint', text: unit }),
            use,
          ]),
        ]);
        attrBody.appendChild(row);
      }
    }
  };

  return { root, sync };
}

function infoRow(k: string, v: string): HTMLElement {
  return h('div', { class: 'row', style: 'justify-content:space-between;gap:10px' }, [
    h('span', { class: 'dim truncate', text: k, title: k }),
    h('span', { class: 'mono truncate', text: v, title: v, style: 'text-align:right' }),
  ]);
}

/* ══════════════════════════════════════════════════════════════
   Downsample page
   ══════════════════════════════════════════════════════════════ */

function buildSamplePage(app: App): PageHandle {
  const st = app.state;

  const sec = section(t('sample.title'), { icon: 'grid' });

  const method = segmented<'voxel' | 'random' | 'uniform' | 'none'>({
    options: [
      { value: 'voxel', label: t('sample.voxel'), title: t('sample.voxelTitle') },
      { value: 'random', label: t('sample.random'), title: t('sample.randomTitle') },
      { value: 'uniform', label: t('sample.uniform'), title: t('sample.uniformTitle') },
      { value: 'none', label: t('sample.none'), title: t('sample.noneTitle') },
    ],
    value: st.downsample.method,
    onChange: (v) => app.applyDownsample({ method: v }),
  });

  const target = slider({
    label: t('sample.target'),
    min: 0,
    max: 100,
    step: 0.5,
    value: 50,
    format: () => fmtInt(st.downsample.target),
    onInput: (t) => {
      const max = Math.max(20_000, st.source?.sourceCount ?? 1_500_000);
      const v = targetFromT(t, max);
      st.downsample.target = v;
      targetLabel.textContent = fmtInt(v);
    },
  });
  const targetLabel = target.el.querySelector('.val') as HTMLElement;

  const voxelSize = numberInput({
    label: t('sample.voxelSize'),
    value: st.downsample.voxelSize,
    step: 0.001,
    min: 0,
    suffix: t('sample.voxelAuto'),
    onInput: (v) => app.applyDownsample({ voxelSize: Math.max(0, v) }),
  });

  const seed = numberInput({
    label: t('sample.seed'),
    value: st.downsample.seed,
    step: 1,
    onInput: (v) => app.applyDownsample({ seed: Math.floor(v) || 1 }),
  });

  const auto = toggle({
    label: t('sample.auto'),
    value: st.autoDownsample,
    onChange: (v) => app.setAutoDownsample(v),
  });

  const presets = buttonRow(
    [100_000, 300_000, 800_000, 1_500_000, 3_000_000].map((n) => {
      const b = h('button', { class: 'btn btn-sm', type: 'button', text: compact(n) });
      b.addEventListener('click', () => app.applyDownsample({ target: n, voxelSize: 0 }));
      return b;
    })
  );

  const apply = h('button', { class: 'btn btn-sm btn-primary btn-block', type: 'button' }, [
    icon('refresh', 13),
    h('span', { text: t('sample.apply') }),
  ]);
  apply.addEventListener('click', () => app.applyDownsample({}));

  const reset = h('button', { class: 'btn btn-sm btn-block', type: 'button' }, [
    icon('rotate', 13),
    h('span', { text: t('sample.reset') }),
  ]);
  reset.addEventListener('click', () => app.resetDownsample());

  sec.body.appendChild(prop(t('ctrl.method'), method.el));
  sec.body.appendChild(target.el);
  sec.body.appendChild(presets);
  sec.body.appendChild(voxelSize.el);
  sec.body.appendChild(seed.el);
  sec.body.appendChild(auto.el);
  sec.body.appendChild(apply);
  sec.body.appendChild(reset);

  const secStat = section(t('sample.stats'), { icon: 'bars' });
  const statBody = h('div', { class: 'col', style: 'gap:4px' });
  secStat.body.appendChild(statBody);
  secStat.body.appendChild(
    hint(t('sample.hint'))
  );

  const root = h('div', {}, [sec.root, secStat.root]);

  const sync = (): void => {
    const s = app.state;
    method.set(s.downsample.method);
    const max = Math.max(20_000, s.source?.sourceCount ?? 1_500_000);
    const pct = tFromTarget(s.downsample.target, max);
    target.set(clampNum(pct, 0, 100));
    targetLabel.textContent = fmtInt(s.downsample.target);
    voxelSize.set(s.downsample.voxelSize);
    seed.set(s.downsample.seed);
    auto.set(s.autoDownsample);

    const useVoxel = s.downsample.method === 'voxel';
    const useRandom = s.downsample.method === 'random';
    const useTarget = s.downsample.method === 'voxel' || s.downsample.method === 'random' || s.downsample.method === 'uniform';
    target.el.hidden = !useTarget || (useVoxel && s.downsample.voxelSize > 0);
    voxelSize.el.hidden = !useVoxel;
    seed.el.hidden = !useRandom;

    statBody.innerHTML = '';
    const total = s.source?.sourceCount ?? 0;
    const shown = s.view?.count ?? 0;
    statBody.appendChild(infoRow(t('sample.srcCount'), fmtInt(total)));
    statBody.appendChild(infoRow(t('sample.afterDs'), fmtInt(s.baseView?.count ?? 0)));
    statBody.appendChild(infoRow(t('sample.afterFilter'), fmtInt(shown)));
    statBody.appendChild(infoRow(t('sample.keepRatio'), total ? `${((shown / total) * 100).toFixed(2)} %` : '—'));
    const diag = s.view?.diagonal ?? 0;
    const spacing = shown > 0 && diag > 0 ? Math.cbrt((diag ** 3) / shown) : NaN;
    statBody.appendChild(infoRow(t('sample.spacing'), Number.isFinite(spacing) ? fmtNum(spacing) : '—'));
  };

  return { root, sync };
}

function compact(n: number): string {
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return `${Number.isInteger(v) ? v : v.toFixed(1)}M`;
  }
  return `${Math.round(n / 1000)}k`;
}

function targetFromT(t: number, max: number): number {
  const hi = Math.max(max, 20_000);
  return Math.round(10_000 * Math.pow(hi / 10_000, t / 100));
}

function tFromTarget(v: number, max: number): number {
  const hi = Math.max(max, 20_000);
  const t = (100 * Math.log(Math.max(10_000, v) / 10_000)) / Math.log(hi / 10_000);
  return Math.max(0, Math.min(100, t));
}

function clampNum(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/* ══════════════════════════════════════════════════════════════
   Filter page
   ══════════════════════════════════════════════════════════════ */

function buildFilterPage(app: App): PageHandle {
  const st = app.state;

  const sec = section(t('filter.title'), { icon: 'filter', badge: '' });

  const logic = segmented<'and' | 'or'>({
    label: t('filter.logic'),
    options: [
      { value: 'and', label: t('filter.and') },
      { value: 'or', label: t('filter.or') },
    ],
    value: st.filters.logic,
    onChange: (v) => app.setFilterLogic(v),
  });

  const rulesEl = h('div', { class: 'col', style: 'gap:8px' });

  const targetSel = select<string>({
    label: t('filter.newBased'),
    options: app.targetOptions(),
    value: '',
  });

  const addBtn = h('button', { class: 'btn btn-sm btn-primary btn-block', type: 'button' }, [
    icon('plus', 13),
    h('span', { text: t('filter.add') }),
  ]);
  addBtn.addEventListener('click', () => {
    const v = targetSel.get();
    if (!v) {
      toast('warn', t('filter.noField'));
      return;
    }
    app.addFilterRule(v);
  });

  const clearBtn = h('button', { class: 'btn btn-sm btn-block', type: 'button' }, [
    icon('trash', 13),
    h('span', { text: t('filter.clear') }),
  ]);
  clearBtn.addEventListener('click', () => app.clearFilters());

  sec.body.appendChild(logic.el);
  sec.body.appendChild(rulesEl);
  sec.body.appendChild(targetSel.el);
  sec.body.appendChild(addBtn);
  sec.body.appendChild(clearBtn);
  sec.body.appendChild(
    hint(t('filter.hint'))
  );

  const secStat = section(t('filter.stats'), { icon: 'bars' });
  const statBody = h('div', { class: 'col', style: 'gap:4px' });
  secStat.body.appendChild(statBody);

  const root = h('div', {}, [sec.root, secStat.root]);

  let renderedSig = '';

  const renderRules = (): void => {
    rulesEl.innerHTML = '';
    const rules = app.state.filters.rules;
    renderedSig = rules.map((r) => r.id).join('|');
    if (rules.length === 0) {
      rulesEl.appendChild(emptyState(t('filter.noRules'), 'filter'));
      return;
    }
    for (const rule of rules) rulesEl.appendChild(ruleCard(app, rule));
  };

  const sync = (): void => {
    const s = app.state;
    logic.set(s.filters.logic);
    sec.setBadge(s.filters.rules.length ? t('filter.count', { n: s.filters.rules.length }) : '');
    targetSel.setOptions(app.targetOptions());
    const sig = s.filters.rules.map((r) => r.id).join('|');
    if (sig !== renderedSig) renderRules();

    statBody.innerHTML = '';
    const base = s.baseView?.count ?? 0;
    const shown = s.view?.count ?? 0;
    statBody.appendChild(infoRow(t('filter.afterDs'), fmtInt(base)));
    statBody.appendChild(infoRow(t('filter.hit'), fmtInt(shown)));
    statBody.appendChild(infoRow(t('filter.keepRatio'), base ? `${((shown / base) * 100).toFixed(2)} %` : '—'));
    statBody.appendChild(infoRow(t('filter.hidden'), fmtInt(Math.max(0, base - shown))));
  };

  return { root, sync };
}

function ruleCard(app: App, rule: FilterRule): HTMLElement {
  const view = app.state.baseView ?? app.state.view;

  const enabled = check({
    label: '',
    value: rule.enabled,
    onChange: (v) => app.updateFilterRule(rule.id, { enabled: v }),
  });

  const title = h('span', { class: 'filter-item-title truncate', text: ruleTitle(rule), title: ruleTitle(rule) });

  const del = h('button', { class: 'icon-btn icon-btn-sm', type: 'button', title: t('filter.delRule') }, [
    icon('trash', 12),
  ]);
  del.addEventListener('click', () => app.removeFilterRule(rule.id));

  const head = h('div', { class: 'filter-item-head' }, [enabled.el, title, del]);

  const mode = segmented<'range' | 'set'>({
    options: [
      { value: 'range', label: t('filter.range') },
      { value: 'set', label: t('filter.set') },
    ],
    value: rule.mode,
    onChange: (v) => app.updateFilterRule(rule.id, { mode: v }),
  });

  const [lo, hi, hist] = ruleRange(view, rule);

  const range = dualRange({
    label: t('filter.range'),
    min: lo,
    max: hi === lo ? lo + 1 : hi,
    lo: rule.min,
    hi: rule.max,
    format: (v) => fmtNum(v),
    histogram: hist,
    onChange: (a, b) => app.updateFilterRule(rule.id, { min: a, max: b }),
  });

  const setInput = h('input', {
    class: 'input',
    value: rule.set.join(', '),
    placeholder: t('filter.setValuePlaceholder'),
  }) as HTMLInputElement;
  setInput.addEventListener('change', () => {
    const nums = setInput.value
      .split(/[,，\s]+/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n));
    app.updateFilterRule(rule.id, { set: nums });
  });
  const setRow = prop(t('filter.values'), setInput);

  const invert = toggle({
    label: t('filter.invert'),
    value: rule.invert,
    onChange: (v) => app.updateFilterRule(rule.id, { invert: v }),
  });

  const body = h('div', { class: 'filter-item-body col', style: 'gap:6px' }, [
    mode.el,
    range.el,
    setRow,
    invert.el,
  ]);
  range.el.hidden = rule.mode !== 'range';
  setRow.hidden = rule.mode !== 'set';

  const root = h('div', { class: 'filter-item' }, [head, body]);

  // Keep the card responsive to changes made elsewhere.
  const off = app.store.on((events) => {
    if (!root.isConnected) {
      off();
      return;
    }
    if (!events.has('filters')) return;
    const live = app.state.filters.rules.find((r) => r.id === rule.id);
    if (!live) {
      off();
      root.remove();
      return;
    }
    rule.enabled = live.enabled;
    rule.mode = live.mode;
    rule.min = live.min;
    rule.max = live.max;
    rule.invert = live.invert;
    rule.set = live.set;
    enabled.set(live.enabled);
    mode.set(live.mode);
    invert.set(live.invert);
    title.textContent = ruleTitle(live);
    title.title = ruleTitle(live);
    range.el.hidden = live.mode !== 'range';
    setRow.hidden = live.mode !== 'set';
    if (document.activeElement !== setInput) setInput.value = live.set.join(', ');
  });

  return root;
}

function ruleTitle(rule: FilterRule): string {
  if (rule.kind === 'axis') {
    const axisKey = rule.field === 'x' ? 'axis.x' : rule.field === 'y' ? 'axis.y' : 'axis.z';
    return `${t(axisKey)} ${t('axis.coord')}`;
  }
  return rule.field;
}

function ruleRange(view: CloudView | null, rule: FilterRule): [number, number, Int32Array | undefined] {
  if (!view) return [rule.min, rule.max, undefined];
  if (rule.kind === 'axis') {
    const b = view.bounds;
    const ax = rule.field === 'x' ? 0 : rule.field === 'y' ? 1 : 2;
    return [b.min[ax], b.max[ax], undefined];
  }
  const st = view.stats(rule.field);
  return st ? [st.min, st.max, st.histogram] : [rule.min, rule.max, undefined];
}

/* ══════════════════════════════════════════════════════════════
   Profile page
   ══════════════════════════════════════════════════════════════ */

function buildProfilePage(app: App): PageHandle {
  const st = app.state;

  const secPick = section(t('profile.pick'), { icon: 'crosshair' });

  const modeBtn = h('button', { class: 'btn btn-sm btn-primary btn-block', type: 'button' }, [
    icon('crosshair', 13),
    h('span', { text: t('profile.enter') }),
  ]);
  modeBtn.addEventListener('click', () => app.setMode(app.state.ui.mode === 'measure' ? 'orbit' : 'measure'));

  const aEl = h('div', { class: 'mono', text: '—' });
  const bEl = h('div', { class: 'mono', text: '—' });

  const swapBtn = h('button', { class: 'btn btn-sm', type: 'button', title: t('profile.swap') }, [
    icon('rotate', 13),
  ]);
  swapBtn.addEventListener('click', () => {
    const m = app.state.measure;
    const a = m.a;
    m.a = m.b;
    m.b = a;
    const la = m.aLabel;
    m.aLabel = m.bLabel;
    m.bLabel = la;
    app.store.emit('measure');
    app.runProfile(true);
  });
  const clearBtn = h('button', { class: 'btn btn-sm', type: 'button', title: t('profile.clear') }, [
    icon('close', 13),
  ]);
  clearBtn.addEventListener('click', () => app.clearMeasure());

  secPick.body.appendChild(modeBtn);
  secPick.body.appendChild(prop(t('profile.startA'), aEl));
  secPick.body.appendChild(prop(t('profile.endB'), bEl));
  secPick.body.appendChild(buttonRow([swapBtn, clearBtn]));
  secPick.body.appendChild(
    hint(t('profile.pickHint'))
  );

  const secOpt = section(t('profile.opt'), { icon: 'sliders' });

  const field = select<string>({
    label: t('profile.field'),
    options: app.profileFieldOptions(),
    value: st.measure.field,
    onChange: (v) => app.setMeasureField(v),
  });

  const radius = slider({
    label: t('profile.radius'),
    min: 0,
    max: 100,
    step: 0.5,
    value: 0,
    format: (v) => (v <= 0 ? t('profile.radiusAuto') : fmtNum(radiusFromT(app, v))),
    onInput: (v) => app.setMeasureOption({ radius: v <= 0 ? 0 : radiusFromT(app, v) }),
  });

  const bins = slider({
    label: t('profile.samples'),
    min: 2,
    max: 600,
    step: 1,
    value: st.measure.bins,
    format: (v) => `${Math.round(v)}`,
    onInput: (v) => app.setMeasureOption({ bins: Math.round(v) }),
  });

  const smooth = slider({
    label: t('profile.smooth'),
    min: 0,
    max: 41,
    step: 1,
    value: st.measure.smooth,
    format: (v) => (v < 2 ? t('profile.smoothOff') : `${Math.round(v)} ${t('profile.seg')}`),
    onInput: (v) => app.setMeasureOption({ smooth: Math.round(v) }),
  });

  secOpt.body.appendChild(field.el);
  secOpt.body.appendChild(radius.el);
  secOpt.body.appendChild(bins.el);
  secOpt.body.appendChild(smooth.el);

  const secStats = section(t('profile.stats'), { icon: 'sigma' });
  const statsGrid = h('div', { class: 'chart-stats' });
  secStats.body.appendChild(statsGrid);

  const csvBtn = h('button', { class: 'btn btn-sm btn-block', type: 'button' }, [
    icon('download', 13),
    h('span', { text: t('profile.exportCsv') }),
  ]);
  csvBtn.addEventListener('click', () => app.exportProfileCSV());
  secStats.body.appendChild(h('div', { style: 'height:8px' }));
  secStats.body.appendChild(csvBtn);

  const secHist = section(t('profile.history'), { icon: 'list', collapsed: true });
  const histEl = h('div', { class: 'measure-list' });
  secHist.body.appendChild(histEl);

  const root = h('div', {}, [secPick.root, secOpt.root, secStats.root, secHist.root]);

  const sync = (): void => {
    const s = app.state;
    const m = s.measure;
    const measuring = s.ui.mode === 'measure';
    modeBtn.classList.toggle('btn-primary', !measuring);
    modeBtn.classList.toggle('btn-active', measuring);
    const label = modeBtn.querySelector('span');
    if (label) label.textContent = measuring ? t('profile.exit') : t('profile.enter');

    aEl.textContent = m.aLabel || t('profile.notSet');
    bEl.textContent = m.bLabel || t('profile.notSet');

    field.setOptions(app.profileFieldOptions());
    field.set(m.field);
    radius.set(radiusTFromValue(app, m.radius));
    bins.set(m.bins);
    smooth.set(m.smooth);

    statsGrid.innerHTML = '';
    const res = s.profile;
    if (!res || res.sampled === 0) {
      statsGrid.appendChild(emptyState(t('profile.noData'), 'chart'));
      statsGrid.style.gridColumn = '1 / -1';
    } else {
      statsGrid.style.gridColumn = '';
      const st2 = res.stats;
      const unit = s.source?.units.get(res.field) ?? '';
      const items: [string, string][] = [
        [t('profile.length'), fmtNum(res.length)],
        [t('profile.sampled'), fmtInt(res.sampled)],
        [t('profile.min'), `${fmtNum(st2.min)}${unit}`],
        [t('profile.max'), `${fmtNum(st2.max)}${unit}`],
        [t('profile.mean'), `${fmtNum(st2.mean)}${unit}`],
        [t('profile.median'), `${fmtNum(st2.median)}${unit}`],
        [t('profile.std'), fmtNum(st2.std)],
        [t('profile.delta'), fmtNum(st2.delta)],
        [t('profile.maxSlope'), fmtNum(st2.maxSlope)],
        [t('profile.trend'), `${fmtNum(st2.trend)}${unit}/${t('profile.perUnit')}`],
        [t('profile.peakAt'), fmtNum(st2.maxAt)],
        [t('profile.valleyAt'), fmtNum(st2.minAt)],
      ];
      for (const [k, v] of items) {
        statsGrid.appendChild(
          h('div', { class: 'mini-stat' }, [
            h('div', { class: 'mini-stat-k', text: k }),
            h('div', { class: 'mini-stat-v', text: v }),
          ])
        );
      }
    }

    histEl.innerHTML = '';
      if (m.history.length === 0) {
      histEl.appendChild(emptyState(t('profile.noHistory'), 'list'));
    } else {
      for (const rec of m.history) {
        const dot = h('span', { class: 'measure-dot' });
        const item = h('div', {
          class: `measure-item${rec.id === m.activeId ? ' is-active' : ''}`,
          title: `${rec.field || 'z'}${s.source?.units.get(rec.field) ?? ''} · ${t('profile.length')} ${fmtNum(rec.length)} · ${fmtInt(rec.sampled)} ${t('profile.pointsUnit')}`,
        }, [
          dot,
          h('div', { class: 'measure-item-body' }, [
            h('div', { class: 'measure-item-title' }, [
              h('span', { text: rec.field || 'z' }),
              h('span', { class: 'field-hint', text: `${fmtNum(rec.length)} ${t('profile.length')}` }),
            ]),
            h('div', { class: 'measure-item-sub', text: `${fmtInt(rec.sampled)} ${t('profile.pointsUnit')} · ${new Date(rec.at).toLocaleTimeString()}` }),
          ]),
        ]);
        item.addEventListener('click', () => app.loadMeasureRecord(rec.id));
        histEl.appendChild(item);
      }
    }
  };

  return { root, sync };
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
   Export page
   ══════════════════════════════════════════════════════════════ */

function buildExportPage(app: App): PageHandle {
  const secImg = section(t('export.image'), { icon: 'camera' });

  const shotBtn = h('button', { class: 'btn btn-sm btn-primary btn-block', type: 'button' }, [
    icon('camera', 13),
    h('span', { text: t('export.imageBtn') }),
  ]);
  shotBtn.addEventListener('click', () => app.openImageExport());

  secImg.body.appendChild(shotBtn);
  secImg.body.appendChild(hint(t('export.imageSub')));

  const secData = section(t('export.data'), { icon: 'download' });

  const fmt = segmented<'csv' | 'ply' | 'pcd'>({
    label: t('export.format'),
    options: [
      { value: 'csv', label: 'CSV' },
      { value: 'ply', label: 'PLY' },
      { value: 'pcd', label: 'PCD' },
    ],
    value: 'csv',
  });

  const scope = segmented<'view' | 'source'>({
    label: t('export.scope'),
    options: [
      { value: 'view', label: t('export.scopeView') },
      { value: 'source', label: t('export.scopeSource') },
    ],
    value: 'view',
  });

  const exportBtn = h('button', { class: 'btn btn-sm btn-primary btn-block', type: 'button' }, [
    icon('download', 13),
    h('span', { text: t('export.exportPoints') }),
  ]);
  exportBtn.addEventListener('click', () => {
    app.exportPoints(fmt.get(), scope.get());
  });

  secData.body.appendChild(fmt.el);
  secData.body.appendChild(scope.el);
  secData.body.appendChild(exportBtn);
  secData.body.appendChild(
    hint(t('export.pointsHint'))
  );

  const secProfile = section(t('export.profile'), { icon: 'chart' });
  const profileBtn = h('button', { class: 'btn btn-sm btn-block', type: 'button' }, [
    icon('download', 13),
    h('span', { text: t('export.profileCsv') }),
  ]);
  profileBtn.addEventListener('click', () => app.exportProfileCSV());
  secProfile.body.appendChild(profileBtn);

  const secPreset = section(t('export.preset'), { icon: 'save', collapsed: true });
  const presetBtn = h('button', { class: 'btn btn-sm btn-block', type: 'button' }, [
    icon('save', 13),
    h('span', { text: t('export.presetBtn') }),
  ]);
  presetBtn.addEventListener('click', () => app.exportPreset());
  secPreset.body.appendChild(presetBtn);
  secPreset.body.appendChild(hint(t('export.presetHint')));

  const root = h('div', {}, [secImg.root, secData.root, secProfile.root, secPreset.root]);

  const sync = (): void => {
    const has = !!app.state.view && app.state.view.count > 0;
    shotBtn.toggleAttribute('disabled', !has);
    exportBtn.toggleAttribute('disabled', !has);
    profileBtn.toggleAttribute('disabled', !app.state.profile);
  };

  return { root, sync };
}
