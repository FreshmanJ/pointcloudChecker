/** Reusable form-control factories used across all panels. */

import { fmtNum, h, icon, type IconName } from './dom';

export interface Control<T> {
  el: HTMLElement;
  set(v: T): void;
  get(): T;
}

export interface SectionHandle {
  root: HTMLElement;
  body: HTMLElement;
  setBadge(text: string): void;
  setCollapsed(v: boolean): void;
  isCollapsed(): boolean;
}

export function section(
  title: string,
  opts: { icon?: IconName; badge?: string; collapsed?: boolean } = {}
): SectionHandle {
  const chev = icon('chevron', 11);
  chev.setAttribute('class', 'chev');
  const badge = h('span', { class: 'badge', text: opts.badge ?? '' });
  if (!opts.badge) badge.style.display = 'none';

  const head = h('button', { class: 'section-head', type: 'button' }, [
    chev,
    opts.icon ? icon(opts.icon, 13) : null,
    h('span', { text: title }),
    badge,
  ]);
  const body = h('div', { class: 'section-body' });
  const root = h('div', { class: `section${opts.collapsed ? ' collapsed' : ''}` }, [head, body]);
  head.addEventListener('click', () => root.classList.toggle('collapsed'));

  return {
    root,
    body,
    setBadge(text: string) {
      badge.textContent = text;
      badge.style.display = text ? '' : 'none';
    },
    setCollapsed(v: boolean) {
      root.classList.toggle('collapsed', v);
    },
    isCollapsed: () => root.classList.contains('collapsed'),
  };
}

export function prop(label: string, control: HTMLElement, opts: { wide?: boolean; title?: string } = {}): HTMLElement {
  if (opts.wide) {
    return h('div', { class: 'prop prop-wide' }, [
      h('label', { class: 'prop-k', text: label, title: opts.title ?? label }),
      control,
    ]);
  }
  return h('div', { class: 'prop' }, [
    h('label', { class: 'prop-k', text: label, title: opts.title ?? label }),
    h('div', { class: 'prop-v' }, [control]),
  ]);
}

/* ────────── slider ────────── */

export function slider(opts: {
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  format?: (v: number) => string;
  onInput?: (v: number) => void;
  hint?: string;
}): Control<number> {
  const fmt = opts.format ?? ((v: number) => fmtNum(v));
  const val = h('span', { class: 'val', text: fmt(opts.value) });
  const input = h('input', {
    type: 'range',
    class: 'slider',
    min: String(opts.min),
    max: String(opts.max),
    step: String(opts.step ?? (opts.max - opts.min) / 200),
    value: String(opts.value),
  }) as HTMLInputElement;

  const labelRow = h('div', { class: 'field-label' }, [h('span', { text: opts.label }), val]);
  const el = h('div', { class: 'field' }, [labelRow, input]);
  if (opts.hint) el.appendChild(h('div', { class: 'field-hint', text: opts.hint }));

  input.addEventListener('input', () => {
    const v = Number(input.value);
    val.textContent = fmt(v);
    opts.onInput?.(v);
  });

  return {
    el,
    set(v: number) {
      input.value = String(v);
      val.textContent = fmt(v);
    },
    get: () => Number(input.value),
  };
}

/* ────────── number ────────── */

export function numberInput(opts: {
  label: string;
  value: number;
  step?: number;
  min?: number;
  max?: number;
  onInput?: (v: number) => void;
  suffix?: string;
}): Control<number> {
  const input = h('input', {
    type: 'number',
    class: 'input',
    value: String(opts.value),
    step: String(opts.step ?? 'any'),
    min: opts.min !== undefined ? String(opts.min) : undefined,
    max: opts.max !== undefined ? String(opts.max) : undefined,
  }) as HTMLInputElement;
  const row = h('div', { class: 'row', style: 'gap:6px' }, [input]);
  if (opts.suffix) row.appendChild(h('span', { class: 'field-hint', text: opts.suffix }));
  const el = prop(opts.label, row);

  input.addEventListener('change', () => {
    const v = Number(input.value);
    if (Number.isFinite(v)) opts.onInput?.(v);
  });
  input.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') input.blur();
  });

  return {
    el,
    set(v: number) {
      if (document.activeElement !== input) input.value = String(v);
    },
    get: () => Number(input.value),
  };
}

/* ────────── select ────────── */

export interface Option<T extends string = string> {
  value: T;
  label: string;
  group?: string;
}

export function select<T extends string = string>(opts: {
  label: string;
  options: Option<T>[];
  value: T;
  onChange?: (v: T) => void;
}): Control<T> & { setOptions(list: Option<T>[], keepValue?: boolean): void } {
  const el0 = h('select', { class: 'select' }) as HTMLSelectElement;
  const wrap = h('div', { class: 'select-wrap' }, [el0]);
  const el = prop(opts.label, wrap);

  const fill = (list: Option<T>[]) => {
    el0.innerHTML = '';
    let group: HTMLOptGroupElement | null = null;
    for (const o of list) {
      const opt = h('option', { value: o.value, text: o.label }) as HTMLOptionElement;
      if (o.group) {
        if (!group || group.label !== o.group) {
          group = document.createElement('optgroup');
          group.label = o.group;
          el0.appendChild(group);
        }
        group.appendChild(opt);
      } else {
        group = null;
        el0.appendChild(opt);
      }
    }
  };
  fill(opts.options);
  el0.value = opts.value;
  el0.addEventListener('change', () => opts.onChange?.(el0.value as T));

  return {
    el,
    set(v: T) {
      el0.value = v;
    },
    get: () => el0.value as T,
    setOptions(list: Option<T>[], keepValue = true) {
      const prev = el0.value;
      fill(list);
      if (keepValue && list.some((o) => o.value === prev)) el0.value = prev;
    },
  };
}

/* ────────── switch ────────── */

export function toggle(opts: {
  label: string;
  value: boolean;
  onChange?: (v: boolean) => void;
}): Control<boolean> {
  const input = h('input', { type: 'checkbox' }) as HTMLInputElement;
  input.checked = opts.value;
  const lab = h('label', { class: 'switch' }, [
    input,
    h('span', { class: 'switch-track' }),
    h('span', { class: 'switch-label', text: opts.label }),
  ]);
  input.addEventListener('change', () => opts.onChange?.(input.checked));
  return {
    el: lab,
    set(v: boolean) {
      input.checked = v;
    },
    get: () => input.checked,
  };
}

/* ────────── check ────────── */

export function check(opts: {
  label: string;
  value: boolean;
  onChange?: (v: boolean) => void;
}): Control<boolean> {
  const input = h('input', { type: 'checkbox' }) as HTMLInputElement;
  input.checked = opts.value;
  const tick = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  tick.setAttribute('viewBox', '0 0 24 24');
  tick.innerHTML = '<path d="M20 6 9 17l-5-5"/>';
  const lab = h('label', { class: 'check' }, [
    input,
    h('span', { class: 'check-box' }, [tick]),
    h('span', { class: 'check-label', text: opts.label }),
  ]);
  input.addEventListener('change', () => opts.onChange?.(input.checked));
  return {
    el: lab,
    set(v: boolean) {
      input.checked = v;
    },
    get: () => input.checked,
  };
}

/* ────────── segmented ────────── */

export function segmented<T extends string = string>(opts: {
  label?: string;
  options: { value: T; label: string; title?: string }[];
  value: T;
  onChange?: (v: T) => void;
}): Control<T> {
  const wrap = h('div', { class: 'seg' });
  const buttons = new Map<T, HTMLButtonElement>();
  const paint = (v: T) => {
    for (const [key, b] of buttons) b.classList.toggle('is-on', key === v);
  };
  for (const o of opts.options) {
    const b = h('button', { class: 'seg-btn', type: 'button', title: o.title ?? o.label, text: o.label });
    b.addEventListener('click', () => {
      opts.onChange?.(o.value);
      paint(o.value);
    });
    buttons.set(o.value, b);
    wrap.appendChild(b);
  }
  paint(opts.value);
  const el = opts.label ? prop(opts.label, wrap) : wrap;
  return {
    el,
    set(v: T) {
      paint(v);
    },
    get: () => [...buttons.entries()].find(([, b]) => b.classList.contains('is-on'))?.[0] as T,
  };
}

/* ────────── colour ────────── */

export function colorInput(opts: {
  label: string;
  value: string;
  onChange?: (v: string) => void;
}): Control<string> {
  const input = h('input', { type: 'color', value: opts.value }) as HTMLInputElement;
  const btn = h('span', { class: 'swatch-btn' }, [input]);
  const hex = h('input', { class: 'input', value: opts.value, style: 'flex:1' }) as HTMLInputElement;
  const row = h('div', { class: 'row' }, [btn, hex]);
  const el = prop(opts.label, row);

  input.addEventListener('input', () => {
    hex.value = input.value;
    opts.onChange?.(input.value);
  });
  hex.addEventListener('change', () => {
    const v = hex.value.trim();
    if (/^#?[0-9a-fA-F]{6}$/.test(v)) {
      const norm = v.startsWith('#') ? v : `#${v}`;
      input.value = norm;
      hex.value = norm;
      opts.onChange?.(norm);
    } else {
      hex.value = input.value;
    }
  });

  return {
    el,
    set(v: string) {
      input.value = v;
      hex.value = v;
    },
    get: () => input.value,
  };
}

/* ────────── dual range ────────── */

export function dualRange(opts: {
  label: string;
  min: number;
  max: number;
  lo: number;
  hi: number;
  step?: number;
  format?: (v: number) => string;
  onChange?: (lo: number, hi: number) => void;
  histogram?: Int32Array;
  histMin?: number;
  histMax?: number;
}): Control<[number, number]> & { setHistogram(h: Int32Array, min: number, max: number): void } {
  const fmt = opts.format ?? ((v: number) => fmtNum(v));
  const step = opts.step ?? (opts.max - opts.min) / 500;
  const lo = h('input', {
    type: 'range', min: String(opts.min), max: String(opts.max), step: String(step), value: String(opts.lo),
  }) as HTMLInputElement;
  const hi = h('input', {
    type: 'range', min: String(opts.min), max: String(opts.max), step: String(step), value: String(opts.hi),
  }) as HTMLInputElement;
  const fill = h('div', { class: 'dual-fill' });
  const canvas = h('canvas', { class: 'dual-hist' }) as HTMLCanvasElement;
  const box = h('div', { class: 'dual-range' }, [
    h('div', { class: 'dual-track' }),
    canvas,
    fill,
    lo,
    hi,
  ]);
  const readout = h('span', { class: 'val mono', text: `${fmt(opts.lo)} → ${fmt(opts.hi)}` });
  const labelRow = h('div', { class: 'field-label' }, [h('span', { text: opts.label }), readout]);
  const el = h('div', { class: 'field' }, [labelRow, box]);

  let hist: Int32Array | null = opts.histogram ?? null;
  let hMin = opts.histMin ?? opts.min;
  let hMax = opts.histMax ?? opts.max;

  const paintFill = () => {
    const a = Number(lo.value);
    const b = Number(hi.value);
    const span = Number(lo.max) - Number(lo.min) || 1;
    const left = ((Math.min(a, b) - Number(lo.min)) / span) * 100;
    const width = (Math.abs(b - a) / span) * 100;
    fill.style.left = `${left}%`;
    fill.style.width = `${width}%`;
    readout.textContent = `${fmt(Math.min(a, b))} → ${fmt(Math.max(a, b))}`;
  };

  const paintHist = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, canvas.clientWidth || 200);
    const hgt = 18;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hgt * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!hist || hist.length === 0) return;
    let peak = 0;
    for (let i = 0; i < hist.length; i++) if (hist[i] > peak) peak = hist[i];
    if (peak <= 0) return;
    ctx.fillStyle = '#3d8bff';
    const bw = canvas.width / hist.length;
    for (let i = 0; i < hist.length; i++) {
      const bh = (hist[i] / peak) * (canvas.height - 1);
      ctx.fillRect(i * bw, canvas.height - bh, Math.max(1, bw - 0.5 * dpr), bh);
    }
  };

  const notify = () => {
    let a = Number(lo.value);
    let b = Number(hi.value);
    if (a > b) { const t = a; a = b; b = t; }
    paintFill();
    opts.onChange?.(a, b);
  };

  lo.addEventListener('input', notify);
  hi.addEventListener('input', notify);

  requestAnimationFrame(() => {
    paintFill();
    paintHist();
  });
  window.addEventListener('resize', paintHist);

  return {
    el,
    set(v: [number, number]) {
      lo.value = String(v[0]);
      hi.value = String(v[1]);
      paintFill();
    },
    get: () => [Number(lo.value), Number(hi.value)],
    setHistogram(hs: Int32Array, min: number, max: number) {
      hist = hs;
      hMin = min;
      hMax = max;
      void hMin;
      void hMax;
      paintHist();
    },
  };
}

/* ────────── misc ────────── */

export function buttonRow(items: HTMLElement[]): HTMLElement {
  return h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' }, items);
}

export function hint(text: string): HTMLElement {
  return h('div', { class: 'field-hint', text });
}

export function emptyState(text: string, iconName: IconName = 'info'): HTMLElement {
  return h('div', { class: 'empty' }, [
    icon(iconName, 28),
    h('div', { class: 'empty-text', text }),
  ]);
}
