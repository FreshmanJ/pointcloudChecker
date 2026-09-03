/** Tiny DOM helpers and an inline icon set (no runtime icon dependency). */

export type Attrs = Record<string, string | number | boolean | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: (Node | string | null | undefined)[] = []
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'html') el.innerHTML = String(v);
    else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function qs<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T {
  const el = root.querySelector(sel);
  if (!el) throw new Error(`未找到元素：${sel}`);
  return el as unknown as T;
}

/* ────────── icons ────────── */

const ICON_PATHS: Record<string, string> = {
  sliders: 'M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4',
  palette: 'M12 2.7 6.3 8.4a8 8 0 1 0 11.4 0z M9 11h.01M15 11h.01M12 15h.01',
  camera: 'M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3zM12 16a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  filter: 'M22 3H2l8 9.46V19l4 2v-8.54z',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  chart: 'M22 12h-4l-3 9L9 3l-3 9H2',
  bars: 'M12 20V10M18 20V4M6 20v-4',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
  grid: 'M3 3h18v18H3zM9 3v18M15 3v18M3 9h18M3 15h18',
  box: 'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16zM3.3 7 12 12l8.7-5M12 22V12',
  axes: 'M4 20V5a1 1 0 0 1 1-1h15M4 20h16M9 20v-5M14 20v-8M19 20v-3',
  refresh: 'M3 2v6h6M3.51 15a9 9 0 1 0 2.13-9.36L3 8',
  upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12',
  close: 'M18 6 6 18M6 6l12 12',
  chevron: 'm6 9 6 6 6-6',
  check: 'M20 6 9 17l-5-5',
  alert: 'm21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3zM12 9v4M12 17h.01',
  checkCircle: 'M22 11.08V12a10 10 0 1 1-5.93-9.14M22 4 12 14.01l-3-3',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  crosshair: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM22 12h-4M6 12H2M12 6V2M12 22v-4',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  trash: 'M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
  copy: 'M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
  save: 'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2zM17 21v-8H7v8M7 3v5h8',
  frame: 'M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3',
  layers: 'M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83zM6.08 9.5l-3.5 1.6a1 1 0 0 0 0 1.81l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9a1 1 0 0 0 0-1.83l-3.5-1.59',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  table: 'M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM3 9h18M3 15h18M9 3v18',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
  hand: 'M18 11V6a2 2 0 0 0-4 0M14 10V4a2 2 0 0 0-4 0v2M10 10.5V6a2 2 0 0 0-4 0v8M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15',
  dots: 'M7 12h.01M12 12h.01M17 12h.01M6 8h.01M12 8h.01M18 8h.01M6 16h.01M12 16h.01M18 16h.01',
  rotate: 'M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8',
  target: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  cube: 'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z',
  play: 'M6 3l14 9-14 9z',
  pause: 'M8 4v16M16 4v16',
  sigma: 'M18 4H6l6 8-6 8h12',
  scissors: 'M20 4 8 16M8 8l12 12M6 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM6 18a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  pipette: 'M2 22l1-4 11-11 3 3L6 21zM14 4l6 6-2.5 2.5-6-6z',
  wand: 'M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8 19 13M17.8 6.2 19 5M3 21l9-9M12.2 6.2 13 7',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z',
};

export type IconName = keyof typeof ICON_PATHS;

export function icon(name: IconName, size = 14): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = ICON_PATHS[name]
    .split(' M')
    .map((seg, i) => `<path d="${i === 0 ? seg : 'M' + seg}"/>`)
    .join('');
  return svg;
}

export function iconButton(
  name: IconName,
  title: string,
  onClick: () => void,
  cls = 'icon-btn'
): HTMLButtonElement {
  const b = h('button', { class: cls, title, type: 'button' }, [icon(name, 14)]);
  b.addEventListener('click', onClick);
  return b;
}

/* ────────── toasts ────────── */

export type ToastLevel = 'ok' | 'warn' | 'err' | 'info';

export function toast(level: ToastLevel, title: string, desc?: string, ms = 4200): void {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = h('div', { class: `toast toast-${level}` }, [
    h('div', { class: 'toast-icon' }, []),
    h('div', { class: 'toast-body' }, [
      h('div', { class: 'toast-title', text: title }),
      desc ? h('div', { class: 'toast-desc', text: desc }) : null,
    ]),
  ]);
  el.insertBefore(icon(iconFor(level), 16), el.firstChild);
  host.appendChild(el);
  const remove = () => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 220);
  };
  const timer = window.setTimeout(remove, ms);
  el.addEventListener('click', () => {
    window.clearTimeout(timer);
    remove();
  });
  while (host.children.length > 5) host.firstElementChild?.remove();
}

function iconFor(level: ToastLevel): IconName {
  switch (level) {
    case 'ok': return 'checkCircle';
    case 'warn': return 'alert';
    case 'err': return 'alert';
    default: return 'info';
  }
}

/* ────────── number formatting ────────── */

export function fmtNum(v: number, digits?: number): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-4 || a >= 1e7)) return v.toExponential(2);
  if (digits !== undefined) return v.toFixed(digits);
  if (Number.isInteger(v)) return v.toLocaleString();
  if (a >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 1 });
  if (a >= 10) return v.toFixed(2);
  if (a >= 1) return v.toFixed(3);
  return v.toFixed(4);
}

export function fmtInt(v: number): string {
  return Number.isFinite(v) ? Math.round(v).toLocaleString() : '—';
}

/** Pick a sensible number of decimals for a value range. */
export function decimalsFor(span: number): number {
  if (!Number.isFinite(span) || span <= 0) return 2;
  const e = Math.floor(Math.log10(span));
  return Math.max(0, Math.min(6, 4 - e));
}
