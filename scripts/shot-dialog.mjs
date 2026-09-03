/**
 * Capture screenshots of the coordinate-column picker dialog in dark + light
 * themes for visual review.
 *
 *   node scripts/shot-dialog.mjs [url] [outDir]
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME =
  process.env.CHROME_PATH ||
  'C:/Users/admin/.agent-browser/browsers/chrome-152.0.7977.75/chrome.exe';
const TARGET = process.argv[2] || 'http://localhost:4173/';
const PORT = Number(process.env.CDP_PORT || 9342);
const outDir = process.argv[3] || path.join(process.cwd(), 'shots');

// CSV with non-leading coordinate columns so the dialog is meaningful.
const probeDir = mkdtempSync(path.join(tmpdir(), 'pci-shot-'));
const csv = path.join(probeDir, 'coords.csv');
{
  const lines = ['name,Lon,Lat,Elev,temp'];
  for (let i = 0; i < 200; i++) {
    lines.push(`pt${i},${(10 + i * 0.1).toFixed(4)},${(20 + i * 0.05).toFixed(4)},${(5 + i * 0.02).toFixed(4)},${(30 + i * 0.1).toFixed(4)}`);
  }
  writeFileSync(csv, lines.join('\n') + '\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = [];
    ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data);
      if (m.id !== undefined) { const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } }
      else for (const fn of this.listeners) fn(m); }); }
  on(fn) { this.listeners.push(fn); }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => {
    this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); } }, 30000); }); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.text); return r.result.value; }
}

async function waitDevTools(port, t = 30000) { const d = Date.now() + t; while (Date.now() < d) {
  try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return r.json(); } catch {} await sleep(300); }
  throw new Error('Chrome DevTools 端口未就绪'); }

async function main() {
  mkdirSync(outDir, { recursive: true });
  const profileDir = mkdtempSync(path.join(tmpdir(), 'pci-shot-smoke-'));
  console.log(`Chrome: ${CHROME}\nTarget: ${TARGET}\nOut: ${outDir}`);
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--enable-unsafe-swiftshader',
    '--use-gl=angle', '--use-angle=swiftshader', '--hide-scrollbars', '--mute-audio',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`,
    '--window-size=1500,950', 'about:blank',
  ], { stdio: 'ignore' });
  let cdp;
  const shot = async (name) => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const f = path.join(outDir, name);
    writeFileSync(f, Buffer.from(data, 'base64'));
    console.log(`  saved ${name}`);
    return f;
  };
  try {
    await waitDevTools(PORT);
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    cdp = new Cdp(ws);
    await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: TARGET });
    for (let i = 0; i < 80; i++) { if (await cdp.eval(`return typeof window.__pci==='object'&&window.__pci!==null;`).catch(() => false)) break; await sleep(250); }

    await cdp.eval(`if (window.__pci.closeCloud) window.__pci.closeCloud();`);
    await sleep(300);
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
    const q = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#fileInput' });
    await cdp.send('DOM.setFileInputFiles', { nodeId: q.nodeId, files: [csv] });
    for (let i = 0; i < 40; i++) { if (await cdp.eval(`return !!document.querySelector('.modal-backdrop');`)) break; await sleep(250); }
    await sleep(500);
    await shot('dialog-dark.png');

    // Switch to light theme and recapture.
    await cdp.eval(`document.getElementById('themeToggle').click();`);
    await sleep(500);
    await shot('dialog-light.png');

    // Confirm and show a loaded cloud (both coords mapped).
    await cdp.eval(`document.getElementById('themeToggle').click();`); // back to dark
    await cdp.eval(`document.querySelector('.modal-foot .btn-primary').click();`);
    for (let i = 0; i < 60; i++) { if ((await cdp.eval(`return window.__pci.state.stage;`)) === 'ready') break; await sleep(400); }
    await sleep(600);
    await shot('loaded-csv-dark.png');
  } finally {
    try { await cdp?.send('Browser.close'); } catch {}
    chrome.kill('SIGKILL'); await sleep(400);
    try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
    try { rmSync(probeDir, { recursive: true, force: true }); } catch {}
  }
}
main().catch((e) => { console.error('截图失败:', e.message); process.exit(1); });
