/** Right panel — file info, downsampling, filters, profile analysis, export. */

import type { App } from '../app';
import type { CloudView } from '../core/cloud';
import type { FilterRule } from '../core/filters';
import { formatBytes } from '../io';
import { fmtInt, fmtNum, h, icon, toast } from './dom';
import {
  buttonRow, check, dualRange, emptyState, hint, numberInput, prop, section, segmented,
  select, slider, toggle,
} from './controls';

const TAB_DEFS = [
  { id: 'file', label: '文件', icon: 'file' as const },
  { id: 'sample', label: '采样', icon: 'grid' as const },
  { id: 'filter', label: '筛选', icon: 'filter' as const },
  { id: 'profile', label: '剖面', icon: 'scissors' as const },
  { id: 'export', label: '导出', icon: 'download' as const },
];

export function createFunctionsPanel(app: App, host: HTMLElement, tabsHost: HTMLElement): void {
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

  app.store.on(sync);
  sync(new Set(['cloud', 'filters', 'measure', 'profile', 'meta']));
}

/* ══════════════════════════════════════════════════════════════
   File page
   ══════════════════════════════════════════════════════════════ */

interface PageHandle {
  root: HTMLElement;
  sync(): void;
}

function buildFilePage(app: App): PageHandle {
  const secInfo = section('文件信息', { icon: 'file' });
  const infoBody = h('div', { class: 'col', style: 'gap:4px' });
  secInfo.body.appendChild(infoBody);

  const secMeta = section('元数据', { icon: 'info', collapsed: true });
  const metaBody = h('div', { class: 'col', style: 'gap:4px' });
  secMeta.body.appendChild(metaBody);

  const secCheck = section('合规校验', { icon: 'checkCircle' });
  const checkBody = h('div', { class: 'col', style: 'gap:6px' });
  secCheck.body.appendChild(checkBody);

  const secAttr = section('属性', { icon: 'layers' });
  const attrBody = h('div', { class: 'col', style: 'gap:4px' });
  secAttr.body.appendChild(attrBody);

  const secOps = section('操作', { icon: 'refresh', collapsed: true });
  const closeBtn = h('button', { class: 'btn btn-sm btn-danger btn-block', type: 'button' }, [
    icon('trash', 13),
    h('span', { text: '关闭当前点云' }),
  ]);
  closeBtn.addEventListener('click', () => {
    app.closeCloud();
    toast('info', '已关闭当前点云');
  });
  const demoBtn = h('button', { class: 'btn btn-sm btn-block', type: 'button' }, [
    icon('cube', 13),
    h('span', { text: '载入示例数据' }),
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
      infoBody.appendChild(emptyState('尚未载入点云文件。', 'file'));
    } else {
      const fi = st.fileInfo;
      const b = st.view?.bounds;
      const rows: [string, string][] = [
        ['名称', fi.name],
        ['格式', `${fi.format} · ${formatBytes(fi.size)}`],
        ['解析耗时', `${(fi.parseMs / 1000).toFixed(2)} s`],
        ['原始点数', fmtInt(src.sourceCount)],
        ['当前点数', fmtInt(st.view?.count ?? 0)],
        ['降采样', src.downsampled ? '是' : '否'],
        ['包围盒', b ? `${fmtNum(b.max[0] - b.min[0])} × ${fmtNum(b.max[1] - b.min[1])} × ${fmtNum(b.max[2] - b.min[2])}` : '—'],
      ];
      for (const [k, v] of rows) infoBody.appendChild(infoRow(k, v));
    }

    metaBody.innerHTML = '';
    const meta = src?.meta ?? {};
    const keys = Object.keys(meta);
    if (keys.length === 0) metaBody.appendChild(emptyState('无元数据。'));
    for (const k of keys) metaBody.appendChild(infoRow(k, meta[k]));

    checkBody.innerHTML = '';
    const v = st.validation;
    if (!v) {
      checkBody.appendChild(emptyState('尚未校验。'));
    } else {
      const errs = v.issues.filter((i) => i.level === 'err').length;
      const warns = v.issues.filter((i) => i.level === 'warn').length;
      secCheck.setBadge(errs ? `${errs} 错误` : warns ? `${warns} 警告` : '通过');
      checkBody.appendChild(infoRow('结论', errs ? '不合规' : v.needsDownsample ? '合规（已自动降采样）' : '合规'));
      checkBody.appendChild(infoRow('无效坐标', fmtInt(v.invalidPoints)));
      checkBody.appendChild(infoRow('重复率估计', `${(v.duplicateRatio * 100).toFixed(1)} %`));
      const reportBtn = h('button', { class: 'btn btn-sm btn-block', type: 'button' }, [
        icon('list', 13),
        h('span', { text: '查看完整校验报告' }),
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
      attrBody.appendChild(emptyState('该点云没有附加属性。', 'layers'));
    } else {
      for (const name of src.scalarOrder) {
        const unit = src.units.get(name) ?? '';
        const use = h('button', { class: 'btn btn-sm', type: 'button', title: '用该属性着色' }, [
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

  const sec = section('降采样', { icon: 'grid' });

  const method = segmented<'voxel' | 'random' | 'uniform' | 'none'>({
    options: [
      { value: 'voxel', label: '体素', title: '体素网格抽稀，保留几何结构' },
      { value: 'random', label: '随机', title: '可复现的随机采样' },
      { value: 'uniform', label: '等间隔', title: '按存储顺序等间隔抽稀' },
      { value: 'none', label: '不处理', title: '保留全部点' },
    ],
    value: st.downsample.method,
    onChange: (v) => app.applyDownsample({ method: v }),
  });

  const target = slider({
    label: '目标点数',
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
    label: '体素边长',
    value: st.downsample.voxelSize,
    step: 0.001,
    min: 0,
    suffix: '0 = 自动',
    onInput: (v) => app.applyDownsample({ voxelSize: Math.max(0, v) }),
  });

  const seed = numberInput({
    label: '随机种子',
    value: st.downsample.seed,
    step: 1,
    onInput: (v) => app.applyDownsample({ seed: Math.floor(v) || 1 }),
  });

  const auto = toggle({
    label: '载入时自动降采样',
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
    h('span', { text: '应用降采样' }),
  ]);
  apply.addEventListener('click', () => app.applyDownsample({}));

  const reset = h('button', { class: 'btn btn-sm btn-block', type: 'button' }, [
    icon('rotate', 13),
    h('span', { text: '还原为原始点集' }),
  ]);
  reset.addEventListener('click', () => app.resetDownsample());

  sec.body.appendChild(prop('方式', method.el));
  sec.body.appendChild(target.el);
  sec.body.appendChild(presets);
  sec.body.appendChild(voxelSize.el);
  sec.body.appendChild(seed.el);
  sec.body.appendChild(auto.el);
  sec.body.appendChild(apply);
  sec.body.appendChild(reset);

  const secStat = section('抽稀统计', { icon: 'bars' });
  const statBody = h('div', { class: 'col', style: 'gap:4px' });
  secStat.body.appendChild(statBody);
  secStat.body.appendChild(
    hint('体素降采样会保留每个体素中距中心最近的点，因此属性与几何形状都能较好地保留。')
  );

  const root = h('div', {}, [sec.root, secStat.root]);

  const sync = (): void => {
    const s = app.state;
    method.set(s.downsample.method);
    const max = Math.max(20_000, s.source?.sourceCount ?? 1_500_000);
    const t = tFromTarget(s.downsample.target, max);
    target.set(clampNum(t, 0, 100));
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
    statBody.appendChild(infoRow('原始点数', fmtInt(total)));
    statBody.appendChild(infoRow('降采样后', fmtInt(s.baseView?.count ?? 0)));
    statBody.appendChild(infoRow('筛选后（渲染）', fmtInt(shown)));
    statBody.appendChild(infoRow('保留率', total ? `${((shown / total) * 100).toFixed(2)} %` : '—'));
    const diag = s.view?.diagonal ?? 0;
    const spacing = shown > 0 && diag > 0 ? Math.cbrt((diag ** 3) / shown) : NaN;
    statBody.appendChild(infoRow('平均点间距估计', Number.isFinite(spacing) ? fmtNum(spacing) : '—'));
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

  const sec = section('筛选条件', { icon: 'filter', badge: '' });

  const logic = segmented<'and' | 'or'>({
    label: '组合方式',
    options: [
      { value: 'and', label: '全部满足 (AND)' },
      { value: 'or', label: '任一满足 (OR)' },
    ],
    value: st.filters.logic,
    onChange: (v) => app.setFilterLogic(v),
  });

  const rulesEl = h('div', { class: 'col', style: 'gap:8px' });

  const targetSel = select<string>({
    label: '新条件基于',
    options: app.targetOptions(),
    value: '',
  });

  const addBtn = h('button', { class: 'btn btn-sm btn-primary btn-block', type: 'button' }, [
    icon('plus', 13),
    h('span', { text: '添加条件' }),
  ]);
  addBtn.addEventListener('click', () => {
    const v = targetSel.get();
    if (!v) {
      toast('warn', '没有可筛选的字段');
      return;
    }
    app.addFilterRule(v);
  });

  const clearBtn = h('button', { class: 'btn btn-sm btn-block', type: 'button' }, [
    icon('trash', 13),
    h('span', { text: '清空条件' }),
  ]);
  clearBtn.addEventListener('click', () => app.clearFilters());

  sec.body.appendChild(logic.el);
  sec.body.appendChild(rulesEl);
  sec.body.appendChild(targetSel.el);
  sec.body.appendChild(addBtn);
  sec.body.appendChild(clearBtn);
  sec.body.appendChild(
    hint('筛选是无损的：被隐藏的点仍然保留在内存中，清空条件即可恢复。')
  );

  const secStat = section('筛选结果', { icon: 'bars' });
  const statBody = h('div', { class: 'col', style: 'gap:4px' });
  secStat.body.appendChild(statBody);

  const root = h('div', {}, [sec.root, secStat.root]);

  let renderedSig = ' ';

  const renderRules = (): void => {
    rulesEl.innerHTML = '';
    const rules = app.state.filters.rules;
    renderedSig = rules.map((r) => r.id).join('|');
    if (rules.length === 0) {
      rulesEl.appendChild(emptyState('没有筛选条件，当前显示全部点。', 'filter'));
      return;
    }
    for (const rule of rules) rulesEl.appendChild(ruleCard(app, rule));
  };

  const sync = (): void => {
    const s = app.state;
    logic.set(s.filters.logic);
    sec.setBadge(s.filters.rules.length ? `${s.filters.rules.length} 条` : '');
    targetSel.setOptions(app.targetOptions());
    const sig = s.filters.rules.map((r) => r.id).join('|');
    if (sig !== renderedSig) renderRules();

    statBody.innerHTML = '';
    const base = s.baseView?.count ?? 0;
    const shown = s.view?.count ?? 0;
    statBody.appendChild(infoRow('降采样后', fmtInt(base)));
    statBody.appendChild(infoRow('命中点数', fmtInt(shown)));
    statBody.appendChild(infoRow('保留比例', base ? `${((shown / base) * 100).toFixed(2)} %` : '—'));
    statBody.appendChild(infoRow('被隐藏', fmtInt(Math.max(0, base - shown))));
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

  const del = h('button', { class: 'icon-btn icon-btn-sm', type: 'button', title: '删除条件' }, [
    icon('trash', 12),
  ]);
  del.addEventListener('click', () => app.removeFilterRule(rule.id));

  const head = h('div', { class: 'filter-item-head' }, [enabled.el, title, del]);

  const mode = segmented<'range' | 'set'>({
    options: [
      { value: 'range', label: '区间' },
      { value: 'set', label: '枚举' },
    ],
    value: rule.mode,
    onChange: (v) => app.updateFilterRule(rule.id, { mode: v }),
  });

  const [lo, hi, hist] = ruleRange(view, rule);

  const range = dualRange({
    label: '区间',
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
    placeholder: '例如：2, 6, 9（整数值）',
  }) as HTMLInputElement;
  setInput.addEventListener('change', () => {
    const nums = setInput.value
      .split(/[,，\s]+/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n));
    app.updateFilterRule(rule.id, { set: nums });
  });
  const setRow = prop('取值', setInput);

  const invert = toggle({
    label: '反转（排除命中范围）',
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
  return rule.kind === 'axis' ? `${rule.field.toUpperCase()} 坐标` : rule.field;
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

  const secPick = section('端点选取', { icon: 'crosshair' });

  const modeBtn = h('button', { class: 'btn btn-sm btn-primary btn-block', type: 'button' }, [
    icon('crosshair', 13),
    h('span', { text: '进入剖面测量模式' }),
  ]);
  modeBtn.addEventListener('click', () => app.setMode(app.state.ui.mode === 'measure' ? 'orbit' : 'measure'));

  const aEl = h('div', { class: 'mono', text: '—' });
  const bEl = h('div', { class: 'mono', text: '—' });

  const swapBtn = h('button', { class: 'btn btn-sm', type: 'button', title: '交换起点与终点' }, [
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
  const clearBtn = h('button', { class: 'btn btn-sm', type: 'button', title: '清除端点 (Esc)' }, [
    icon('close', 13),
  ]);
  clearBtn.addEventListener('click', () => app.clearMeasure());

  secPick.body.appendChild(modeBtn);
  secPick.body.appendChild(prop('起点 A', aEl));
  secPick.body.appendChild(prop('终点 B', bEl));
  secPick.body.appendChild(buttonRow([swapBtn, clearBtn]));
  secPick.body.appendChild(
    hint('在测量模式下点击点云拾取真实点作为端点；端点以坐标保存，筛选或降采样后依然有效。')
  );

  const secOpt = section('采样参数', { icon: 'sliders' });

  const field = select<string>({
    label: '分析量',
    options: app.profileFieldOptions(),
    value: st.measure.field,
    onChange: (v) => app.setMeasureField(v),
  });

  const radius = slider({
    label: '管道半径',
    min: 0,
    max: 100,
    step: 0.5,
    value: 0,
    format: (v) => (v <= 0 ? '自动' : fmtNum(radiusFromT(app, v))),
    onInput: (v) => app.setMeasureOption({ radius: v <= 0 ? 0 : radiusFromT(app, v) }),
  });

  const bins = slider({
    label: '分段数',
    min: 20,
    max: 400,
    step: 10,
    value: st.measure.bins,
    format: (v) => `${Math.round(v)}`,
    onInput: (v) => app.setMeasureOption({ bins: Math.round(v) }),
  });

  const smooth = slider({
    label: '滑动平均窗口',
    min: 0,
    max: 41,
    step: 1,
    value: st.measure.smooth,
    format: (v) => (v < 2 ? '关闭' : `${Math.round(v)} 段`),
    onInput: (v) => app.setMeasureOption({ smooth: Math.round(v) }),
  });

  secOpt.body.appendChild(field.el);
  secOpt.body.appendChild(radius.el);
  secOpt.body.appendChild(bins.el);
  secOpt.body.appendChild(smooth.el);

  const secStats = section('沿程统计', { icon: 'sigma' });
  const statsGrid = h('div', { class: 'chart-stats' });
  secStats.body.appendChild(statsGrid);

  const csvBtn = h('button', { class: 'btn btn-sm btn-block', type: 'button' }, [
    icon('download', 13),
    h('span', { text: '导出剖面数据 (CSV)' }),
  ]);
  csvBtn.addEventListener('click', () => app.exportProfileCSV());
  secStats.body.appendChild(h('div', { style: 'height:8px' }));
  secStats.body.appendChild(csvBtn);

  const secHist = section('历史记录', { icon: 'list', collapsed: true });
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
    if (label) label.textContent = measuring ? '退出测量模式' : '进入剖面测量模式';

    aEl.textContent = m.aLabel || '未选择';
    bEl.textContent = m.bLabel || '未选择';

    field.setOptions(app.profileFieldOptions());
    field.set(m.field);
    radius.set(radiusTFromValue(app, m.radius));
    bins.set(m.bins);
    smooth.set(m.smooth);

    statsGrid.innerHTML = '';
    const res = s.profile;
    if (!res || res.sampled === 0) {
      statsGrid.appendChild(emptyState('选择起点与终点后显示沿程统计。', 'chart'));
      statsGrid.style.gridColumn = '1 / -1';
    } else {
      statsGrid.style.gridColumn = '';
      const st2 = res.stats;
      const unit = s.source?.units.get(res.field) ?? '';
      const items: [string, string][] = [
        ['线段长度', fmtNum(res.length)],
        ['采样点数', fmtInt(res.sampled)],
        ['最小值', `${fmtNum(st2.min)}${unit}`],
        ['最大值', `${fmtNum(st2.max)}${unit}`],
        ['平均值', `${fmtNum(st2.mean)}${unit}`],
        ['中位数', `${fmtNum(st2.median)}${unit}`],
        ['标准差', fmtNum(st2.std)],
        ['首尾差 Δ', fmtNum(st2.delta)],
        ['最大梯度', fmtNum(st2.maxSlope)],
        ['线性趋势', `${fmtNum(st2.trend)}${unit}/单位`],
        ['峰值位置', fmtNum(st2.maxAt)],
        ['谷值位置', fmtNum(st2.minAt)],
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
      histEl.appendChild(emptyState('还没有测量记录。', 'list'));
    } else {
      for (const rec of m.history) {
        const dot = h('span', { class: 'measure-dot' });
        const item = h('div', {
          class: `measure-item${rec.id === m.activeId ? ' is-active' : ''}`,
          title: `${rec.field || 'z'}${s.source?.units.get(rec.field) ?? ''} · 长度 ${fmtNum(rec.length)} · ${fmtInt(rec.sampled)} 点`,
        }, [
          dot,
          h('div', { class: 'measure-item-body' }, [
            h('div', { class: 'measure-item-title' }, [
              h('span', { text: rec.field || 'z' }),
              h('span', { class: 'field-hint', text: `${fmtNum(rec.length)} 长度` }),
            ]),
            h('div', { class: 'measure-item-sub', text: `${fmtInt(rec.sampled)} 点 · ${new Date(rec.at).toLocaleTimeString()}` }),
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
  const secImg = section('导出图片', { icon: 'camera' });

  const scale = segmented<'1' | '2' | '3' | '4'>({
    label: '分辨率倍率',
    options: [
      { value: '1', label: '1×' },
      { value: '2', label: '2×' },
      { value: '3', label: '3×' },
      { value: '4', label: '4×' },
    ],
    value: '2',
  });

  const bg = select<'current' | 'white' | 'black'>({
    label: '背景',
    options: [
      { value: 'current', label: '当前背景色' },
      { value: 'white', label: '白色' },
      { value: 'black', label: '黑色' },
    ],
    value: 'current',
  });

  const shotBtn = h('button', { class: 'btn btn-sm btn-primary btn-block', type: 'button' }, [
    icon('camera', 13),
    h('span', { text: '导出 PNG 截图' }),
  ]);
  shotBtn.addEventListener('click', () => {
    const bgv: string | undefined =
      bg.get() === 'white' ? '#ffffff' : bg.get() === 'black' ? '#000000' : app.state.render.background;
    app.exportPNG(Number(scale.get()), bgv);
  });

  secImg.body.appendChild(scale.el);
  secImg.body.appendChild(bg.el);
  secImg.body.appendChild(shotBtn);
  secImg.body.appendChild(hint('截图会包含当前的点云、色标与辅助元素，但不包含界面面板。'));

  const secData = section('导出点云', { icon: 'download' });

  const fmt = segmented<'csv' | 'ply' | 'pcd'>({
    label: '格式',
    options: [
      { value: 'csv', label: 'CSV' },
      { value: 'ply', label: 'PLY' },
      { value: 'pcd', label: 'PCD' },
    ],
    value: 'csv',
  });

  const scope = segmented<'view' | 'source'>({
    label: '范围',
    options: [
      { value: 'view', label: '当前视图' },
      { value: 'source', label: '完整原始' },
    ],
    value: 'view',
  });

  const exportBtn = h('button', { class: 'btn btn-sm btn-primary btn-block', type: 'button' }, [
    icon('download', 13),
    h('span', { text: '导出点数据' }),
  ]);
  exportBtn.addEventListener('click', () => {
    app.exportPoints(fmt.get(), scope.get());
  });

  secData.body.appendChild(fmt.el);
  secData.body.appendChild(scope.el);
  secData.body.appendChild(exportBtn);
  secData.body.appendChild(
    hint('「当前视图」导出经过降采样与筛选后的点；「完整原始」导出解析后的全部点（含所有属性列）。')
  );

  const secProfile = section('导出剖面', { icon: 'chart' });
  const profileBtn = h('button', { class: 'btn btn-sm btn-block', type: 'button' }, [
    icon('download', 13),
    h('span', { text: '导出剖面数据 (CSV)' }),
  ]);
  profileBtn.addEventListener('click', () => app.exportProfileCSV());
  secProfile.body.appendChild(profileBtn);

  const secPreset = section('设置预设', { icon: 'save', collapsed: true });
  const presetBtn = h('button', { class: 'btn btn-sm btn-block', type: 'button' }, [
    icon('save', 13),
    h('span', { text: '导出当前渲染/采样/筛选设置' }),
  ]);
  presetBtn.addEventListener('click', () => app.exportPreset());
  secPreset.body.appendChild(presetBtn);
  secPreset.body.appendChild(hint('预设只包含显示与处理参数，不包含点数据本身。'));

  const root = h('div', {}, [secImg.root, secData.root, secProfile.root, secPreset.root]);

  const sync = (): void => {
    const has = !!app.state.view && app.state.view.count > 0;
    shotBtn.toggleAttribute('disabled', !has);
    exportBtn.toggleAttribute('disabled', !has);
    profileBtn.toggleAttribute('disabled', !app.state.profile);
  };

  return { root, sync };
}
