/**
 * Probe: verify plane-rotation buttons and collapsed-panel expand tabs.
 *
 * Rotation — for a rotation *within* a plane, the coordinate along the plane's
 * normal axis must stay constant, and the distance to target must be preserved:
 *   xy plane (about Z) → z constant
 *   yz plane (about X) → x constant
 *   xz plane (about Y) → y constant
 *
 * Expand tabs — after collapsing a panel, its expand tab must become visible
 * and must sit inside the workspace bounds (not off-screen).
 *
 *   node scripts/rotate-expand-probe.mjs [url]
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

const CHROME =
  process.env.CHROME_PATH ||
  'C:/Users/admin/.agent-browser/browsers/chrome-152.0.7977.75/chrome.exe';
const TARGET = process.argv[2] || 'http://127.0.0.1:4173/';
const PORT = Number(process.env.CDP_PORT || 9351);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ok = 0;
let fail = 0;
function check(label, cond, detail = '') {
  if (cond) { ok++; console.log(`  \u2713 ${label}`); }
  else { fail++; console.log(`  \u2717 ${label}${detail ? ` \u2014 ${detail}` : ''}`); }
}

/* ── tiny demo cloud so the viewer has a target ── */
const N = 400;
{
  const lines = ['x,y,z'];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    lines.push(
      `${(Math.cos(a) * 5).toFixed(4)},${(Math.sin(a) * 5).toFixed(4)},${((i / N) * 6 - 3).toFixed(4)}`
    );
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'pci-rot-'));
  const csv = path.join(dir, 'demo.csv');
  writeFileSync(csv, lines.join('\n') + '\n');
  globalThis.__CSV = csv;
}

/* ── Launch Chrome ── */
const profileDir = mkdtempSync(path.join(tmpdir(), 'pci-rot-chrome-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu',
  '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
  '--hide-scrollbars', '--mute-audio',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profileDir}`,
  '--window-size=1600,1000', 'about:blank',
], { stdio: 'ignore' });

await sleep(2500);

/* ── connect to page target ── */
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
if (!page) throw new Error('no page target');
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
    return this.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    }).then((r) => {
      if (r?.exceptionDetails) throw new Error(String(r.exceptionDetails.text || 'JS error'));
      return r?.result?.value;
    });
  }
}
const cdp = new Cdp(ws);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.eval(`window.location.href = '${TARGET}'`);

/* wait for app */
let appReady = false;
for (let i = 0; i < 60; i++) {
  const r = await cdp.eval(`typeof window.__pci === 'object' && window.__pci !== null`).catch(() => false);
  if (r) { appReady = true; break; }
  await sleep(300);
}
check('app booted', appReady);
if (!appReady) { cleanup(1); }

/* ── load demo cloud ── */
const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
const q = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#fileInput' });
await cdp.send('DOM.setFileInputFiles', { nodeId: q.nodeId, files: [globalThis.__CSV] });

// The column-selection dialog may appear for CSV input — confirm it.
let sawDialog = false;
for (let i = 0; i < 40; i++) {
  const has = await cdp.eval(`!!document.querySelector('.modal-backdrop')`).catch(() => false);
  if (has) { sawDialog = true; break; }
  await sleep(250);
}
if (sawDialog) {
  const clicked = await cdp.eval(`
    (() => {
      const btns = Array.from(document.querySelectorAll('.modal button'));
      const b = btns.find(x => /确定|确认|载入/.test(x.textContent||''));
      if (b) { b.click(); return 'ok'; }
      return 'no confirm btn';
    })()
  `);
  console.log(`    [dialog] confirm: ${clicked}`);
}

let stage = '';
for (let i = 0; i < 80; i++) {
  stage = await cdp.eval(`window.__pci.state.stage`).catch(() => '');
  if (stage === 'ready') break;
  await sleep(300);
}
check('cloud loaded (stage=ready)', stage === 'ready', `stage=${stage}`);

/* ══════════ 1. Plane rotation ══════════ */
console.log('\n── Plane rotation ──');

// Loading a cloud triggers the frameAll easing animation. Wait until the camera
// settles, otherwise the first measurement is taken mid-flight.
async function waitCameraSettled(maxTries = 40) {
  let prev = null;
  for (let i = 0; i < maxTries; i++) {
    const cur = await cdp.eval(`
      window.__pci.viewer.camera.position.toArray().map(v => v.toFixed(5)).join(',')
    `);
    if (cur === prev) return true;
    prev = cur;
    await sleep(150);
  }
  return false;
}
const settled = await waitCameraSettled();
check('camera settled before measuring', settled);

/** Read camera position + target, click a plane button, read again. */
async function rotateAndMeasure(plane, arrowIdx) {
  const before = await cdp.eval(`
    (() => {
      const v = window.__pci.viewer;
      return JSON.stringify({
        p: v.camera.position.toArray(),
        t: v.controls.target.toArray(),
      });
    })()
  `);
  // Click the ↻ (cw) button of the given plane row
  const clicked = await cdp.eval(`
    (() => {
      const rows = Array.from(document.querySelectorAll('.rot-row'));
      const row = rows.find(r => r.textContent.includes('${plane.toUpperCase()} 平面'));
      if (!row) return 'no row';
      const btns = row.querySelectorAll('button');
      if (btns.length < ${arrowIdx + 1}) return 'no btn';
      btns[${arrowIdx}].click();
      return 'ok';
    })()
  `);
  // Let OrbitControls damping finish before sampling the new position.
  await waitCameraSettled();
  const after = await cdp.eval(`
    (() => {
      const v = window.__pci.viewer;
      return JSON.stringify({
        p: v.camera.position.toArray(),
        t: v.controls.target.toArray(),
      });
    })()
  `);
  return { before: JSON.parse(before), after: JSON.parse(after), clicked };
}

const dist = (p, t) => Math.hypot(p[0] - t[0], p[1] - t[1], p[2] - t[2]);

for (const [plane, normalIdx] of [['xy', 2], ['yz', 0], ['xz', 1]]) {
  const { before, after, clicked } = await rotateAndMeasure(plane, 1);
  if (clicked !== 'ok') { check(`${plane} plane: button found`, false, clicked); continue; }

  const pb = before.p, pa = after.p, tb = before.t, ta = after.t;
  // offset relative to target
  const ob = [pb[0] - tb[0], pb[1] - tb[1], pb[2] - tb[2]];
  const oa = [pa[0] - ta[0], pa[1] - ta[1], pa[2] - ta[2]];

  const dNormal = Math.abs(oa[normalIdx] - ob[normalIdx]);
  const scale = Math.max(1, dist(pb, tb));
  check(
    `${plane} plane: normal-axis coord unchanged (\u0394=${dNormal.toFixed(4)})`,
    dNormal / scale < 0.02,
    `normal axis idx ${normalIdx} moved ${dNormal.toFixed(4)}`
  );

  const dB = dist(pb, tb), dA = dist(pa, ta);
  check(
    `${plane} plane: orbit radius preserved (${dB.toFixed(3)} \u2192 ${dA.toFixed(3)})`,
    Math.abs(dA - dB) / Math.max(dB, 1e-6) < 0.02,
    `radius changed ${Math.abs(dA - dB).toFixed(4)}`
  );

  // The two in-plane components must actually change (rotation really happened)
  const moved = [0, 1, 2].filter((i) => i !== normalIdx)
    .reduce((s, i) => s + Math.abs(oa[i] - ob[i]), 0);
  check(`${plane} plane: camera actually moved in-plane`, moved / scale > 0.1,
    `moved ${moved.toFixed(4)}`);
}

/* ══════════ 2. Expand tabs ══════════ */
console.log('\n── Expand tabs ──');

async function tabState(id) {
  const raw = await cdp.eval(`
    (() => {
      const el = document.getElementById('${id}');
      if (!el) return JSON.stringify({missing:true});
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return JSON.stringify({
        display: cs.display,
        visibility: cs.visibility,
        opacity: cs.opacity,
        rect: {x: r.x, y: r.y, w: r.width, h: r.height},
      });
    })()
  `);
  return JSON.parse(raw);
}

// Initially panels are open → tabs hidden
let lt = await tabState('leftExpand');
check('left expand tab hidden while panel open', lt.display === 'none', `display=${lt.display}`);

// Collapse left panel
await cdp.eval(`document.getElementById('leftCollapse').click()`);
await sleep(600);

lt = await tabState('leftExpand');
const hasLeftCls = await cdp.eval(`document.querySelector('.workspace').classList.contains('no-left')`);
check('workspace has .no-left after collapse', hasLeftCls === true);
check('left expand tab VISIBLE after collapse', lt.display !== 'none', `display=${lt.display}`);
check('left expand tab has nonzero size', lt.rect && lt.rect.w > 0 && lt.rect.h > 0,
  `rect=${JSON.stringify(lt.rect)}`);
check('left expand tab within viewport bounds',
  lt.rect && lt.rect.x >= 0 && lt.rect.x < 200 && lt.rect.y > 0,
  `x=${lt.rect?.x} y=${lt.rect?.y}`);

// Clicking it should re-expand
await cdp.eval(`document.getElementById('leftExpand').click()`);
await sleep(600);
lt = await tabState('leftExpand');
const leftOpenAgain = await cdp.eval(`!document.querySelector('.workspace').classList.contains('no-left')`);
check('clicking expand tab reopens left panel', leftOpenAgain === true);
check('left expand tab hidden again after reopen', lt.display === 'none', `display=${lt.display}`);

// Same for right panel
await cdp.eval(`document.getElementById('rightCollapse').click()`);
await sleep(600);
let rt = await tabState('rightExpand');
check('right expand tab VISIBLE after collapse', rt.display !== 'none', `display=${rt.display}`);
check('right expand tab has nonzero size', rt.rect && rt.rect.w > 0 && rt.rect.h > 0,
  `rect=${JSON.stringify(rt.rect)}`);
check('right expand tab near right edge', rt.rect && rt.rect.x > 1200, `x=${rt.rect?.x}`);

await cdp.eval(`document.getElementById('rightExpand').click()`);
await sleep(600);
const rightOpenAgain = await cdp.eval(`!document.querySelector('.workspace').classList.contains('no-right')`);
check('clicking expand tab reopens right panel', rightOpenAgain === true);

/* ── cleanup ── */
function cleanup(code) {
  try { ws.close(); } catch {}
  try { chrome.kill(); } catch {}
  console.log(`\n${ok + fail} checks: ${ok} passed, ${fail} failed`);
  process.exit(code ?? (fail ? 1 : 0));
}
cleanup();
