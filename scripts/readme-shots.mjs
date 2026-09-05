/**
 * Capture feature screenshots for the README.
 *   node scripts/readme-shots.mjs [url] [outDir]
 *
 * - Forces the LIGHT theme.
 * - For each feature, crops the screenshot to the panel element that actually
 *   changes (clip to its bounding box) instead of dumping the whole window.
 * - Adds two shots that previously were missing: the export tab (image export)
 *   and a segment-measurement overlay drawn on the viewport.
 *
 * Uses raw Chrome DevTools Protocol.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME =
  process.env.CHROME_PATH ||
  'C:/Users/admin/.agent-browser/browsers/chrome-152.0.7977.75/chrome.exe';
const TARGET = process.argv[2] || 'http://localhost:5173/';
const PORT = Number(process.env.CDP_PORT || 9361);
const outDir = process.argv[3] || path.join(process.cwd(), 'docs', 'shots');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined) { const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } }
      else for (const fn of this.listeners) fn(m);
    });
  }
  on(fn) { this.listeners.push(fn); }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); } }, 30000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
}

async function waitDevTools(port, t = 30000) {
  const d = Date.now() + t;
  while (Date.now() < d) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return r.json(); } catch {}
    await sleep(300);
  }
  throw new Error('Chrome DevTools 端口未就绪');
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const profileDir = mkdtempSync(path.join(tmpdir(), 'pci-readme-'));
  console.log(`Chrome: ${CHROME}\nTarget: ${TARGET}\nOut: ${outDir}`);
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--enable-unsafe-swiftshader',
    '--use-gl=angle', '--use-angle=swiftshader', '--hide-scrollbars', '--mute-audio',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`,
    '--window-size=1600,1000', 'about:blank',
  ], { stdio: 'ignore' });

  let cdp;
  const clickTab = async (hostId, tabId) => {
    await cdp.eval(`document.querySelector('#${hostId} .tab[data-tab="${tabId}"]').click();`);
    await sleep(700);
  };
  const shotEl = async (name, selector) => {
    // NOTE: returning a plain object through Runtime.evaluate with
    // awaitPromise:true serialises to `undefined`; returning a JSON *string*
    // (returnByValue, no await) works reliably. So serialise in-page.
    const expr = `(function(){ const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return JSON.stringify({ x: b.x, y: b.y, w: b.width, h: b.height }); })()`;
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    const rect = JSON.parse(r.result.value);
    const { data } = await cdp.send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: false,
      clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: 2 },
    });
    const f = path.join(outDir, name);
    writeFileSync(f, Buffer.from(data, 'base64'));
    console.log(`  saved ${name}  (${Math.round(rect.w)}x${Math.round(rect.h)})`);
    return f;
  };
  const shotWindow = async (name) => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const f = path.join(outDir, name);
    writeFileSync(f, Buffer.from(data, 'base64'));
    console.log(`  saved ${name}  (full window)`);
    return f;
  };
  try {
    await waitDevTools(PORT);
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    cdp = new Cdp(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });

    await cdp.send('Page.navigate', { url: TARGET });
    await sleep(2500);
    await cdp.eval(`document.getElementById('welcomeDemo').click();`);
    for (let i = 0; i < 80; i++) {
      if ((await cdp.eval(`return window.__pci ? window.__pci.state.stage : 'none';`)) === 'ready') break;
      await sleep(400);
    }
    await sleep(800);

    // Force LIGHT theme (fresh profile should already be light after the
    // default change, but guard anyway).
    await cdp.eval(`if (document.documentElement.getAttribute('data-theme') !== 'light') document.getElementById('themeToggle').click();`);
    await sleep(600);

    // 1) Overview — full window (light) so the hero still shows the whole app.
    await shotWindow('overview.png');

    // 2) Colouring — left panel
    await clickTab('leftTabs', 'color');
    await shotEl('coloring.png', '#panelLeft');

    // 3) Scene & camera — left panel
    await clickTab('leftTabs', 'scene');
    await shotEl('scene.png', '#panelLeft');

    // 4) Downsampling — right panel
    await clickTab('rightTabs', 'sample');
    await shotEl('downsample.png', '#panelRight');

    // 5) Filtering — right panel
    await clickTab('rightTabs', 'filter');
    await shotEl('filters.png', '#panelRight');

    // 6) Section / profile — right panel
    await clickTab('rightTabs', 'profile');
    await shotEl('profile.png', '#panelRight');

    // 7) Image export — right panel (export tab)
    await clickTab('rightTabs', 'export');
    await shotEl('export.png', '#panelRight');

    // 8) Compliance report — bottom dock
    await clickTab('dockTabs', 'report');
    await shotEl('report.png', '#dock');

    // 9) Line / segment measurement — viewport overlay with A→B segment.
    await cdp.eval(`window.__pci.setMode('measure');`);
    await sleep(300);
    await cdp.eval(`(function(){
      const v = window.__pci.state.view; const p = v.positions; const n = v.count;
      const i = Math.floor(n * 0.30); const j = Math.floor(n * 0.72);
      const a = [p[i*3], p[i*3+1], p[i*3+2]];
      const b = [p[j*3], p[j*3+1], p[j*3+2]];
      window.__pci.pushEndpoint(a); window.__pci.pushEndpoint(b);
    })();`);
    await sleep(700);
    await shotEl('measure.png', '#viewport');

    console.log('Done.');
  } finally {
    try { await cdp?.send('Browser.close'); } catch {}
    chrome.kill('SIGKILL'); await sleep(400);
    try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
  }
}
main().catch((e) => { console.error('截图失败:', e.message); process.exit(1); });
