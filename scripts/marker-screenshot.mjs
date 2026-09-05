/**
 * Capture real screenshots of the new ring pick-marker so the look can be reviewed.
 *
 *   1. loads the app, uploads a solid-sphere demo cloud,
 *   2. moves the cursor over a point to trigger the hover ring marker,
 *   3. saves a full-view PNG and a zoomed crop centred on the marker.
 *
 *   node scripts/marker-screenshot.mjs [url] [outDir]
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

const CHROME =
  process.env.CHROME_PATH ||
  'C:/Users/admin/.agent-browser/browsers/chrome-152.0.7977.75/chrome.exe';
const TARGET = process.argv[2] || 'http://127.0.0.1:4451/';
const OUTDIR = process.argv[3] || '.tmp';
const PORT = Number(process.env.CDP_PORT || 9360);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* demo cloud: dense solid sphere so the projected centre has geometry around it */
const dir = mkdtempSync(path.join(tmpdir(), 'pci-mark-'));
const csv = path.join(dir, 'demo.csv');
{
  const lines = ['x,y,z'];
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 60000; i++) {
    const r = 4 * Math.cbrt(rnd());
    const th = 2 * Math.PI * rnd();
    const ph = Math.acos(2 * rnd() - 1);
    lines.push(
      `${(r * Math.sin(ph) * Math.cos(th)).toFixed(4)},${(r * Math.cos(ph)).toFixed(4)},${(r * Math.sin(ph) * Math.sin(th)).toFixed(4)}`
    );
  }
  writeFileSync(csv, lines.join('\n') + '\n');
}

const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu',
  '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
  '--hide-scrollbars', '--mute-audio',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}-chrome`,
  '--window-size=1600,1000', 'about:blank',
], { stdio: 'ignore' });
await sleep(2500);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new globalThis.WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        if (p) { this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }
      }, 20_000);
    });
  }
  eval(expr) {
    return this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
      .then((r) => {
        if (r?.exceptionDetails) throw new Error(String(r.exceptionDetails.text || 'JS error'));
        return r?.result?.value;
      });
  }
}
const cdp = new Cdp(ws);
await cdp.send('Page.enable');

console.log('navigating to', TARGET);
await cdp.eval(`window.location.href = '${TARGET}'`);
for (let i = 0; i < 60; i++) {
  if (await cdp.eval(`typeof window.__pci === 'object' && window.__pci !== null`).catch(() => false)) break;
  await sleep(300);
}
let loaded = false;
for (let attempt = 0; attempt < 4 && !loaded; attempt++) {
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
    const q = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#fileInput' });
    await cdp.send('DOM.setFileInputFiles', { nodeId: q.nodeId, files: [csv] });
    loaded = true;
  } catch { await sleep(1200); }
}
console.log(loaded ? 'file attached' : 'FILE ATTACH FAILED');
for (let i = 0; i < 40; i++) {
  if (await cdp.eval(`!!document.querySelector('.modal-backdrop')`).catch(() => false)) {
    await cdp.eval(`(() => { const b = Array.from(document.querySelectorAll('.modal button'))
      .find(x => /确定|确认|载入/.test(x.textContent||'')); if (b) b.click(); })()`);
    break;
  }
  await sleep(250);
}
for (let i = 0; i < 80; i++) {
  if (await cdp.eval(`window.__pci.state.stage`).catch(() => '') === 'ready') break;
  await sleep(300);
}
console.log('stage:', await cdp.eval(`window.__pci.state.stage`).catch(() => '?'));

async function waitSettled(max = 40) {
  let prev = null;
  for (let i = 0; i < max; i++) {
    const cur = await cdp.eval(`window.__pci.viewer.camera.position.toArray().map(v=>v.toFixed(5)).join(',')`);
    if (cur === prev) return;
    prev = cur; await sleep(150);
  }
}
await waitSettled();

/* pick a point whose screen position is comfortably inside the viewport, hover it */
const pts = await cdp.eval(`
  (() => {
    const app = window.__pci;
    const v = app.state.view;
    const cam = app.viewer.camera;
    cam.updateMatrixWorld();
    const m = cam.matrixWorldInverse.elements;
    const pj = cam.projectionMatrix.elements;
    const cv = document.getElementById('gl');
    const rect = cv.getBoundingClientRect();
    const out = [];
    for (let k = 0; k < v.count && out.length < 40; k += Math.max(1, Math.floor(v.count / 600))) {
      const p = v.positionAt(k);
      const cx = m[0]*p[0] + m[4]*p[1] + m[8]*p[2]  + m[12];
      const cy = m[1]*p[0] + m[5]*p[1] + m[9]*p[2]  + m[13];
      const cz = m[2]*p[0] + m[6]*p[1] + m[10]*p[2] + m[14];
      if (cz > -1e-4) continue;
      const w = -cz;
      const ndcX = (pj[0]*cx + pj[8]*cz + pj[12]) / w;
      const ndcY = (pj[5]*cy + pj[9]*cz + pj[13]) / w;
      if (Math.abs(ndcX) > 0.45 || Math.abs(ndcY) > 0.45) continue;
      out.push({
        x: rect.left + (ndcX * 0.5 + 0.5) * rect.width,
        y: rect.top + (1 - (ndcY * 0.5 + 0.5)) * rect.height,
        l: rect.left, t: rect.top,
      });
    }
    return out;
  })()
`);

let hp = null;
for (const p of pts) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', buttons: 0 });
  await sleep(280);
  const has = await cdp.eval(`!!window.__pci.hovered`).catch(() => false);
  if (has) { hp = p; break; }
}
console.log(hp ? `hover marker triggered at (${hp.x.toFixed(0)}, ${hp.y.toFixed(0)})` : 'HOVER NOT TRIGGERED');

async function shot(file, clip) {
  const params = { format: 'png', captureBeyondViewport: false };
  if (clip) params.clip = clip;
  const r = await cdp.send('Page.captureScreenshot', params);
  writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log('saved', file);
}

const full = path.join(OUTDIR, 'marker-full.png');
await shot(full);

if (hp) {
  const size = 260;
  const clip = {
    x: Math.max(0, hp.x - size / 2),
    y: Math.max(0, hp.y - size / 2),
    width: size, height: size, scale: 2,
  };
  const zoom = path.join(OUTDIR, 'marker-zoom.png');
  await shot(zoom, clip);
}

try { ws.close(); } catch {}
try { chrome.kill(); } catch {}
process.exit(0);
