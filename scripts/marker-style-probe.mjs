/**
 * Probe: pick-marker rendering.
 *
 * The old marker was a solid square drawn with depthTest:false, so it floated
 * above the cloud and could never be hidden by it. This probe verifies the
 * replacement — a ring marker that is depth-tested against the cloud:
 *
 *   1. the material depth-tests (and never writes depth),
 *   2. hovering shows a RING: a hole between the centre dot and the ring, and
 *      nothing beyond it — a filled square would paint both,
 *   3. occlusion: a marker placed behind the cloud disappears, one placed in
 *      front of it stays visible.
 *
 *   node scripts/marker-style-probe.mjs [url]
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

const CHROME =
  process.env.CHROME_PATH ||
  'C:/Users/admin/.agent-browser/browsers/chrome-152.0.7977.75/chrome.exe';
const TARGET = process.argv[2] || 'http://127.0.0.1:4173/';
const PORT = Number(process.env.CDP_PORT || 9359);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(ok, label, detail = '') {
  if (ok) { pass++; console.log(`  \u2713 ${label}${detail ? '  \u2014 ' + detail : ''}`); }
  else { fail++; console.log(`  \u2717 ${label}${detail ? '  \u2014 ' + detail : ''}`); }
}

const dir = mkdtempSync(path.join(tmpdir(), 'pci-mark-'));
const csv = path.join(dir, 'demo.csv');
{
  const lines = ['x,y,z'];
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 60000; i++) {
    // Uniform inside a solid sphere: a dense volume, so the projected centre
    // always has near-surface geometry in front of it for the occlusion test.
    const r = 4 * Math.cbrt(rnd());
    const th = 2 * Math.PI * rnd();
    const ph = Math.acos(2 * rnd() - 1);
    lines.push(
      `${(r * Math.sin(ph) * Math.cos(th)).toFixed(4)},${(r * Math.cos(ph)).toFixed(4)},${(r * Math.sin(ph) * Math.sin(th)).toFixed(4)}`
    );
  }
  writeFileSync(csv, lines.join('\n') + '\n');
}

const profileDir = mkdtempSync(path.join(tmpdir(), 'pci-mark-chrome-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu',
  '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
  '--hide-scrollbars', '--mute-audio',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`,
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
await cdp.eval(`window.location.href = '${TARGET}'`);
for (let i = 0; i < 60; i++) {
  if (await cdp.eval(`typeof window.__pci === 'object' && window.__pci !== null`).catch(() => false)) break;
  await sleep(300);
}
/* DOM agent node ids occasionally go stale right after navigation — retry. */
let loaded = false;
for (let attempt = 0; attempt < 4 && !loaded; attempt++) {
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
    const q = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#fileInput' });
    await cdp.send('DOM.setFileInputFiles', { nodeId: q.nodeId, files: [csv] });
    loaded = true;
  } catch {
    await sleep(1200);
  }
}
check(loaded, 'file attached to the input');
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
check(await cdp.eval(`window.__pci.state.stage`) === 'ready', 'cloud loaded');

async function waitSettled(max = 40) {
  let prev = null;
  for (let i = 0; i < max; i++) {
    const cur = await cdp.eval(`window.__pci.viewer.camera.position.toArray().map(v=>v.toFixed(5)).join(',')`);
    if (cur === prev) return;
    prev = cur; await sleep(150);
  }
}
await waitSettled();

/* in-page helpers: grab the WebGL framebuffer and diff two grabs */
await cdp.eval(`
  window.__gr = () => {
    const cv = document.getElementById('gl');
    const c = document.createElement('canvas');
    c.width = cv.width; c.height = cv.height;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(cv, 0, 0);
    return x.getImageData(0, 0, c.width, c.height).data;
  };
  window.__cmp = (A, B, cx, cy) => {
    const cv = document.getElementById('gl');
    const w = cv.width, h = cv.height;
    let n = 0, minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
    const bands = [0, 0, 0, 0];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const d = Math.max(Math.abs(A[i]-B[i]), Math.abs(A[i+1]-B[i+1]), Math.abs(A[i+2]-B[i+2]));
      if (d <= 24) continue;
      n++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      const r = Math.hypot(x - cx, y - cy);
      bands[r < 2.2 ? 0 : r < 4.6 ? 1 : r < 8.2 ? 2 : 3]++;
    }
    return { n, w: maxX - minX + 1, h: maxY - minY + 1, cx: (minX + maxX) >> 1, cy: (minY + maxY) >> 1, bands };
  };
`);

/* ── 1. material flags ──────────────────────────────────────────────────── */
const flags = await cdp.eval(`
  (() => {
    const m = window.__pci.viewer.hoverMarker.material;
    return { depthTest: m.depthTest, depthWrite: m.depthWrite, transparent: m.transparent };
  })()
`);
check(flags.depthTest === true, 'marker depth-tests against the cloud', `depthTest=${flags.depthTest}`);
check(flags.depthWrite === false, 'marker does not write depth', `depthWrite=${flags.depthWrite}`);

/* ── 2. hover shape: ring, not square ───────────────────────────────────── */
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
    const dpr = cv.width / rect.width;
    const out = [];
    for (let k = 0; k < v.count && out.length < 12; k += Math.max(1, Math.floor(v.count / 400))) {
      const p = v.positionAt(k);
      const cx = m[0]*p[0] + m[4]*p[1] + m[8]*p[2]  + m[12];
      const cy = m[1]*p[0] + m[5]*p[1] + m[9]*p[2]  + m[13];
      const cz = m[2]*p[0] + m[6]*p[1] + m[10]*p[2] + m[14];
      if (cz > -1e-4) continue;
      const w = -cz;
      const ndcX = (pj[0]*cx + pj[8]*cz + pj[12]) / w;
      const ndcY = (pj[5]*cy + pj[9]*cz + pj[13]) / w;
      if (Math.abs(ndcX) > 0.6 || Math.abs(ndcY) > 0.6) continue;
      out.push({
        index: k,
        x: rect.left + (ndcX * 0.5 + 0.5) * rect.width,
        y: rect.top + (1 - (ndcY * 0.5 + 0.5)) * rect.height,
        l: rect.left, t: rect.top,
      });
    }
    return out;
  })()
`);
check(pts.length > 0, 'projected candidate points', `${pts.length} candidates`);

let shape = null;
for (const p of pts.slice(0, 8)) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', buttons: 0 });
  await sleep(260);
  const has = await cdp.eval(`!!window.__pci.hovered`);
  if (!has) continue;
  const sx = await cdp.eval(`document.getElementById('gl').width / document.getElementById('gl').clientWidth`);
  const cx = Math.round((p.x - p.l) * sx);
  const cy = Math.round((p.y - p.t) * sx);
  await cdp.eval(`void (window.__A = window.__gr())`);
  await cdp.eval(`window.__pci.viewer.hoverMarker.visible = false; window.__pci.viewer.invalidate()`);
  await sleep(220);
  await cdp.eval(`void (window.__B = window.__gr())`);
  await cdp.eval(`window.__pci.viewer.hoverMarker.visible = true; window.__pci.viewer.invalidate()`);
  await sleep(220);
  shape = await cdp.eval(`window.__cmp(window.__A, window.__B, ${cx}, ${cy})`);
  break;
}
check(!!shape, 'hover marker rendered on screen');
if (shape) {
  console.log(`    changed=${shape.n} px, bbox ${shape.w}×${shape.h}, bands [dot,gap,ring,out] = [${shape.bands.join(', ')}]`);
  check(shape.n > 40, 'marker paints pixels', `${shape.n} changed`);
  check(shape.w >= 11 && shape.w <= 23 && shape.h >= 11 && shape.h <= 23,
    'marker footprint is about 16 px', `${shape.w}×${shape.h}`);
  check(shape.bands[1] <= shape.bands[2] * 0.35, 'ring has a hollow centre (not a filled square)',
    `gap ${shape.bands[1]} vs ring ${shape.bands[2]} px`);
  check(shape.bands[3] <= (shape.bands[0] + shape.bands[2]) * 0.25, 'nothing painted outside the ring',
    `outside ${shape.bands[3]} vs mark ${shape.bands[0] + shape.bands[2]} px`);
}

/* ── 3. occlusion: behind the cloud hides, in front stays visible ───────── */
async function markerAlongRay(t) {
  await cdp.eval(`
    (() => {
      const v = window.__pci.viewer;
      const p = v.camera.position.clone().lerp(v.controls.target, ${t});
      const attr = v.hoverMarker.geometry.getAttribute('position');
      attr.setXYZ(0, p.x, p.y, p.z);
      attr.needsUpdate = true;
      v.hoverMarker.visible = true;
      v.invalidate();
    })()
  `);
  await sleep(260);
}
async function projTarget() {
  return cdp.eval(`
    (() => {
      const v = window.__pci.viewer;
      const cam = v.camera;
      cam.updateMatrixWorld();
      const p = v.controls.target.clone().project(cam);
      const cv = document.getElementById('gl');
      const rect = cv.getBoundingClientRect();
      return JSON.stringify({
        x: Math.round((p.x * 0.5 + 0.5) * rect.width * (cv.width / rect.width)),
        y: Math.round((1 - (p.y * 0.5 + 0.5)) * rect.height * (cv.height / rect.height)),
      });
    })()
  `).then((s) => JSON.parse(s));
}
async function diffNow(cx, cy) {
  await cdp.eval(`void (window.__C = window.__gr())`);
  await cdp.eval(`window.__pci.viewer.hoverMarker.visible = false; window.__pci.viewer.invalidate()`);
  await sleep(220);
  await cdp.eval(`void (window.__D = window.__gr())`);
  await cdp.eval(`window.__pci.viewer.hoverMarker.visible = true; window.__pci.viewer.invalidate()`);
  await sleep(220);
  return cdp.eval(`window.__cmp(window.__C, window.__D, ${cx}, ${cy})`);
}

const { x: tx, y: ty } = await projTarget();

await markerAlongRay(0.1);
const frontBaseline = (await diffNow(tx, ty)).n;
await markerAlongRay(1.25); // 25 % beyond the target: the whole cloud is in front
const behind = await diffNow(tx, ty);
console.log(`    behind cloud: ${behind.n} px changed`);
// A point cloud only writes depth where its points are, so a sparse surface
// leaks a little — compare against the un-occluded rendering instead of a hard 0.
check(behind.n < frontBaseline * 0.35, 'marker behind the cloud is occluded',
  `${behind.n} px visible vs ${frontBaseline} un-occluded`);

await markerAlongRay(0.1); // 10 % along the way: in front of the near surface
const front = await diffNow(tx, ty);
console.log(`    in front:     ${front.n} px changed`);
check(front.n > 40, 'marker in front of the cloud stays visible', `${front.n} px visible`);
check(front.bands[1] <= front.bands[2] * 0.5, 'front marker keeps its hollow centre',
  `gap ${front.bands[1]} vs ring ${front.bands[2]} px`);

await cdp.eval(`window.__pci.viewer.hoverMarker.visible = false`);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
try { ws.close(); } catch {}
try { chrome.kill(); } catch {}
process.exit(fail ? 1 : 0);
