/**
 * Objective visual-acceptance probe for the coordinate-column dialog.
 *
 * The model cannot read screenshots, so instead of eyeballing PNGs we drive the
 * real browser, open the dialog, and read the *computed* CSS of the modal in
 * both themes, then compute WCAG contrast ratios. This gives hard evidence that
 * the modal is readable (light text on dark bg in dark theme, dark on light in
 * light theme) without needing image inspection.
 *
 *   node scripts/dialog-theme-probe.mjs [url]
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
// Use Node 22's global WebSocket (same as dialog-smoke.mjs) — do NOT import 'ws'.

const CHROME =
  process.env.CHROME_PATH ||
  'C:/Users/admin/.agent-browser/browsers/chrome-152.0.7977.75/chrome.exe';
const TARGET = process.argv[2] || process.env.SMOKE_URL || 'http://localhost:4173/';
const PORT = Number(process.env.CDP_PORT || 9342);

const N = 60;
const probeDir = mkdtempSync(path.join(tmpdir(), 'pci-dlg-theme-'));
const csv = path.join(probeDir, 'coords.csv');
{
  const lines = ['name,Lon,Lat,Elev,temp'];
  for (let i = 0; i < N; i++) {
    lines.push(`pt${i},${(10 + i * 0.1).toFixed(4)},${(20 + i * 0.05).toFixed(4)},${(5 + i * 0.02).toFixed(4)},${(30 + i * 0.1).toFixed(4)}`);
  }
  writeFileSync(csv, lines.join('\n') + '\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0, checks = 0;
function ok(label, cond, detail = '') {
  checks++;
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

/* ── WCAG contrast helpers ── */
function parseRGB(s) {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(s || '');
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
function lin(c) {
  c /= 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function lum(rgb) {
  if (!rgb) return null;
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}
function contrast(a, b) {
  const la = lum(a), lb = lum(b);
  if (la == null || lb == null) return null;
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/* ── CDP client (mirrors dialog-smoke.mjs) ── */
class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (p) { this.pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); }
      } else for (const fn of this.listeners) fn(msg);
    });
  }
  on(fn) { this.listeners.push(fn); }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); } }, 30_000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'eval failed');
    return r.result.value;
  }
}
async function waitForDevTools(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const res = await fetch(`http://127.0.0.1:${port}/json/version`); if (res.ok) return res.json(); } catch { /* not up */ }
    await sleep(300);
  }
  throw new Error('Chrome DevTools 端口未就绪');
}
async function waitForApp(cdp, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await cdp.eval(`return typeof window.__pci === 'object' && window.__pci !== null;`).catch(() => false);
    if (ready) return;
    await sleep(250);
  }
  throw new Error('应用启动超时');
}
async function openDialog(cdp, file) {
  await cdp.eval(`if (window.__pci.closeCloud) window.__pci.closeCloud();`);
  await sleep(300);
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
  const q = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#fileInput' });
  await cdp.send('DOM.setFileInputFiles', { nodeId: q.nodeId, files: [file] });
  for (let i = 0; i < 40; i++) {
    if (await cdp.eval(`return !!document.querySelector('.modal-backdrop');`)) return true;
    await sleep(250);
  }
  throw new Error('对话框未出现');
}

async function readModalStyles(cdp) {
  return cdp.eval(`
    const cs = (el) => el ? getComputedStyle(el) : null;
    const rgb = (s) => s ? s : 'unknown';
    const b = document.querySelector('.modal-backdrop');
    const m = b.querySelector('.modal');
    const title = b.querySelector('.modal-title');
    const preview = b.querySelector('.modal-preview');
    const sel = b.querySelector('.modal-cols .select');
    const segOn = b.querySelector('.seg-btn.is-on');
    const theme = document.documentElement.getAttribute('data-theme') || 'dark';
    return {
      theme,
      backdropBg: cs(b).backgroundColor,
      modalBg: cs(m).backgroundColor,
      modalColor: cs(m).color,
      titleColor: cs(title).color,
      previewColor: cs(preview).color,
      selectBg: sel ? cs(sel).backgroundColor : null,
      selectColor: sel ? cs(sel).color : null,
      segOnBg: segOn ? cs(segOn).backgroundColor : null,
      segOnColor: segOn ? cs(segOn).color : null,
    };
  `);
}

async function main() {
  console.log(`Chrome: ${CHROME}`);
  console.log(`Target: ${TARGET}`);
  const profileDir = mkdtempSync(path.join(tmpdir(), 'pci-dlg-theme-smoke-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu',
    '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
    '--hide-scrollbars', '--mute-audio',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`,
    '--window-size=1600,1000', 'about:blank',
  ], { stdio: 'ignore' });

  let cdp;
  try {
    await waitForDevTools(PORT);
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (!page) throw new Error('找不到 page 目标');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    cdp = new Cdp(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    await cdp.send('Page.navigate', { url: TARGET });
    await waitForApp(cdp);

    await openDialog(cdp, csv);
    console.log('\n── 深色主题对话框实测样式 ──');
    const dark = await readModalStyles(cdp);
    console.log('  data-theme      =', dark.theme);
    console.log('  backdrop bg     =', dark.backdropBg);
    console.log('  modal bg        =', dark.modalBg);
    console.log('  modal text      =', dark.modalColor);
    console.log('  title text      =', dark.titleColor);
    console.log('  preview text    =', dark.previewColor);
    console.log('  select bg/text  =', dark.selectBg, '/', dark.selectColor);
    console.log('  seg-on bg/text  =', dark.segOnBg, '/', dark.segOnColor);
    const darkContrast = contrast(parseRGB(dark.modalColor), parseRGB(dark.modalBg));
    console.log('  modal text↔bg 对比度 =', darkContrast ? darkContrast.toFixed(2) : 'n/a');

    // toggle to light theme
    await cdp.eval(`document.getElementById('themeToggle').click();`);
    await sleep(500);
    console.log('\n── 浅色主题对话框实测样式 ──');
    const light = await readModalStyles(cdp);
    console.log('  data-theme      =', light.theme);
    console.log('  backdrop bg     =', light.backdropBg);
    console.log('  modal bg        =', light.modalBg);
    console.log('  modal text      =', light.modalColor);
    console.log('  title text      =', light.titleColor);
    console.log('  preview text    =', light.previewColor);
    console.log('  select bg/text  =', light.selectBg, '/', light.selectColor);
    console.log('  seg-on bg/text  =', light.segOnBg, '/', light.segOnColor);
    const lightContrast = contrast(parseRGB(light.modalColor), parseRGB(light.modalBg));
    console.log('  modal text↔bg 对比度 =', lightContrast ? lightContrast.toFixed(2) : 'n/a');

    console.log('\n── 断言 ──');
    ok('主题可切换 dark→light', dark.theme !== light.theme, `${dark.theme} → ${light.theme}`);
    ok('深色：模态背景确实偏暗', lum(parseRGB(dark.modalBg)) < 0.4, `L=${lum(parseRGB(dark.modalBg))?.toFixed(3)}`);
    ok('浅色：模态背景确实偏亮', lum(parseRGB(light.modalBg)) > 0.6, `L=${lum(parseRGB(light.modalBg))?.toFixed(3)}`);
    ok('深色：文字在暗底上可读 (≥4.5)', (darkContrast || 0) >= 4.5, `对比度 ${darkContrast?.toFixed(2)}`);
    ok('浅色：文字在亮底上可读 (≥4.5)', (lightContrast || 0) >= 4.5, `对比度 ${lightContrast?.toFixed(2)}`);
    ok('两主题模态背景明显不同', dark.modalBg !== light.modalBg, `${dark.modalBg} vs ${light.modalBg}`);
  } finally {
    console.log(`\n${'═'.repeat(52)}`);
    console.log(`  对话框主题探针：${checks - failures}/${checks} 通过` + (failures ? `，${failures} 项失败` : '，全部通过'));
    console.log('═'.repeat(52));
    try { await cdp?.send('Browser.close'); } catch { /* ignore */ }
    chrome.kill('SIGKILL');
    await sleep(400);
    try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(probeDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  process.exit(failures > 0 ? 1 : 0);
}
main().catch((err) => { console.error('\n对话框主题探针失败：', err.message); process.exit(1); });
