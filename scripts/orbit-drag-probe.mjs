/**
 * Probe: mouse-drag sanity check for the trackball camera.
 *
 * TrackballControls rotates the eye offset **and** `camera.up` by one shared
 * quaternion, which is what lets the view tumble over the poles. So the old
 * "up must stay pinned to world Y" invariant no longer applies — the invariants
 * that matter now are that the camera rig moves as a rigid body:
 *
 *   · the orbit radius is preserved exactly (rotation is tangential),
 *   · the angle between the eye offset and `up` is preserved (no roll creep),
 *   · the rotation that takes eye_before → eye_after also takes up_before →
 *     up_after, i.e. one single rigid rotation, not two independent ones.
 *
 * Scenarios:
 *   A. drag from a pristine, world-up view  → still orbits the world Y axis
 *   B. drag after tilting `up` with the XY-plane buttons → still rigid
 *   C. 24 × 15° about Z → completes a full turn and returns both eye and up home
 *
 *   node scripts/orbit-drag-probe.mjs [url]
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

const CHROME =
  process.env.CHROME_PATH ||
  'C:/Users/admin/.agent-browser/browsers/chrome-152.0.7977.75/chrome.exe';
const TARGET = process.argv[2] || 'http://127.0.0.1:4173/';
const PORT = Number(process.env.CDP_PORT || 9355);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(ok, label, detail = '') {
  if (ok) { pass++; console.log(`  \u2713 ${label}${detail ? '  \u2014 ' + detail : ''}`); }
  else { fail++; console.log(`  \u2717 ${label}${detail ? '  \u2014 ' + detail : ''}`); }
}

/* ── demo cloud ── */
const N = 500;
const dir = mkdtempSync(path.join(tmpdir(), 'pci-orbit-'));
const csv = path.join(dir, 'demo.csv');
{
  const lines = ['x,y,z'];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    lines.push(
      `${(Math.cos(a) * 5).toFixed(4)},${(Math.sin(a) * 8).toFixed(4)},${((i / N) * 6 - 3).toFixed(4)}`
    );
  }
  writeFileSync(csv, lines.join('\n') + '\n');
}

/* ── vector helpers (plain arrays) ── */
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const dist = (a, b) => len(sub(a, b));

/** Minimal rotation taking unit vector a to unit vector b, as {axis, angle}. */
function minimalRotation(a, b) {
  const cr = [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const cl = len(cr);
  if (cl < 1e-12) return null;
  return { axis: cr.map((v) => v / cl), angle: Math.atan2(cl, dot(a, b)) };
}

function applyRotation({ axis: [x, y, z], angle }, v) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  return [
    (t * x * x + c) * v[0] + (t * x * y - s * z) * v[1] + (t * x * z + s * y) * v[2],
    (t * x * y + s * z) * v[0] + (t * y * y + c) * v[1] + (t * y * z - s * x) * v[2],
    (t * x * z - s * y) * v[0] + (t * y * z + s * x) * v[1] + (t * z * z + c) * v[2],
  ];
}

/** Angle in degrees between the eye offset and the camera up vector. */
function rigAngle(cam) {
  const eye = norm(sub(cam.p, cam.t));
  const up = norm(cam.up);
  return (Math.acos(Math.max(-1, Math.min(1, dot(eye, up)))) * 180) / Math.PI;
}

/**
 * The invariant that defines "the rig rotates as a rigid body": the minimal
 * rotation that carries eye_before onto eye_after must also carry up_before
 * onto up_after.
 */
function rigidRotationError(before, after) {
  const eyeA = norm(sub(before.p, before.t));
  const eyeB = norm(sub(after.p, after.t));
  const q = minimalRotation(eyeA, eyeB);
  if (!q) return { err: 0, turned: 0, axis: [0, 0, 0] };
  return {
    err: dist(applyRotation(q, norm(before.up)), norm(after.up)),
    turned: (q.angle * 180) / Math.PI,
    axis: q.axis,
  };
}

const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/**
 * A trackball spins the camera about an axis fixed to the **screen**, not to the
 * world, so these are the angle-independent invariants:
 *
 *   horizontal drag → axis = up − (up·eye)eye, i.e. the screen-vertical axis;
 *                     it lies in the plane spanned by `up` and the eye, so it is
 *                     perpendicular to up × eye.
 *   vertical drag   → axis = up × eye (the screen-horizontal axis), which is
 *                     perpendicular to both `up` and the eye.
 *
 * Note this is deliberately *not* "the camera's height stays constant": a
 * trackball sweeps a great circle, so height falls off as cos(turn). That loss
 * of the turntable constraint is exactly what buys rotation past the poles.
 */

/* ── launch chrome ── */
const profileDir = mkdtempSync(path.join(tmpdir(), 'pci-orbit-chrome-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu',
  '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
  '--hide-scrollbars', '--mute-audio',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profileDir}`,
  '--window-size=1600,1000', 'about:blank',
], { stdio: 'ignore' });
await sleep(2500);

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

for (let i = 0; i < 60; i++) {
  const r = await cdp.eval(`typeof window.__pci === 'object' && window.__pci !== null`).catch(() => false);
  if (r) break;
  await sleep(300);
}

/* ── load the cloud ── */
const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
const fileNode = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#fileInput' });
check(fileNode.nodeId > 0, 'file input found', `nodeId=${fileNode.nodeId}`);
await cdp.send('DOM.setFileInputFiles', { nodeId: fileNode.nodeId, files: [csv] });

// CSV uploads open the column-selection dialog; dismiss it if it shows up.
for (let i = 0; i < 40; i++) {
  const has = await cdp.eval(`!!document.querySelector('.modal-backdrop')`).catch(() => false);
  if (has) {
    const clicked = await cdp.eval(`
      (() => {
        const btns = Array.from(document.querySelectorAll('.modal button'));
        const b = btns.find((x) => /确定|确认|载入/.test(x.textContent || ''));
        if (!b) return 'NO MATCH: ' + JSON.stringify(btns.map((x) => (x.textContent || '').trim()));
        b.click();
        return 'ok';
      })()
    `);
    console.log(`    [dialog] confirm: ${clicked}`);
    break;
  }
  await sleep(250);
}

let stage = '';
for (let i = 0; i < 120; i++) {
  stage = await cdp.eval(`window.__pci.state.stage`).catch(() => '');
  if (stage === 'ready') break;
  await sleep(300);
}
if (stage !== 'ready') {
  const dbg = await cdp.eval(`
    (() => {
      const w = document.getElementById('welcome');
      return JSON.stringify({
        stage: window.__pci.state.stage,
        welcomeHidden: w ? w.hidden : 'no el',
        modal: !!document.querySelector('.modal-backdrop'),
        cloud: window.__pci.state.cloud ? window.__pci.state.cloud.count : 'none',
      });
    })()
  `).catch((e) => String(e));
  console.log(`    [load] DEBUG ${dbg}`);
}
check(stage === 'ready', 'cloud loaded', `stage=${stage}`);
if (stage !== 'ready') {
  try { ws.close(); } catch {}
  try { chrome.kill(); } catch {}
  process.exit(1);
}

async function waitSettled(maxTries = 60) {
  let prev = null;
  for (let i = 0; i < maxTries; i++) {
    const cur = await cdp.eval(
      `window.__pci.viewer.camera.position.toArray().map(v=>v.toFixed(5)).join(',')`
    );
    if (cur === prev) return true;
    prev = cur;
    await sleep(150);
  }
  return false;
}
await waitSettled();

/* ── helpers ── */
async function cam() {
  return JSON.parse(await cdp.eval(`
    (() => {
      const v = window.__pci.viewer;
      return JSON.stringify({
        p: v.camera.position.toArray(),
        up: v.camera.up.toArray(),
        t: v.controls.target.toArray(),
      });
    })()
  `));
}

/**
 * Drag across the middle of the viewport. The centre comes from the canvas rect
 * rather than being hard-coded, so a layout change cannot silently aim the drag
 * at an overlay (the welcome panel covers the canvas while no cloud is loaded).
 */
async function drag(dx, dy) {
  const rect = JSON.parse(await cdp.eval(`
    (() => {
      const r = window.__pci.viewer.canvas.getBoundingClientRect();
      return JSON.stringify([r.left + r.width / 2, r.top + r.height / 2]);
    })()
  `));
  const cx = Math.round(rect[0]);
  const cy = Math.round(rect[1]);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1, buttons: 1,
  });
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: cx + (dx * i) / steps,
      y: cy + (dy * i) / steps,
      button: 'left', buttons: 1,
    });
    await sleep(20);
  }
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: cx + dx, y: cy + dy, button: 'left', buttons: 0, clickCount: 1,
  });
  await waitSettled();
}

/** Click the ↻ (clockwise) button on the given plane row. */
async function rotatePlane(plane, times = 1) {
  for (let i = 0; i < times; i++) {
    await cdp.eval(`
      (() => {
        const row = Array.from(document.querySelectorAll('.rot-row'))
          .find(r => r.textContent.includes('${plane}'));
        if (!row) return;
        const btns = row.querySelectorAll('button');
        if (btns.length >= 2) btns[1].click();
      })()
    `);
    await sleep(250);
  }
  await waitSettled();
}

/* ══════════ Scenario A: pristine, world-up view ══════════ */
console.log('\n── A. Drags from a pristine world-up view ──');
await cdp.eval(`window.__pci.viewer.setViewAxis('iso')`);
await waitSettled();
const a0 = await cam();
check(
  Math.abs(a0.up[0]) < 1e-6 && Math.abs(a0.up[1] - 1) < 1e-6 && Math.abs(a0.up[2]) < 1e-6,
  'A: up is world Y before drag',
  `up=${a0.up.map((v) => v.toFixed(3))}`
);

{
  await drag(60, 0);
  const a1 = await cam();
  const rA0 = dist(a0.p, a0.t);
  const rA1 = dist(a1.p, a1.t);
  const rig = rigidRotationError(a0, a1);
  // axis must lie in the plane spanned by `up` and the eye → ⟂ (up × eye)
  const planeNormal = norm(cross(norm(a0.up), norm(sub(a0.p, a0.t))));
  const outOfPlane = Math.abs(dot(rig.axis, planeNormal));
  console.log(`    horizontal: turned ${rig.turned.toFixed(2)}\u00b0, axis out of the up/eye plane ${outOfPlane.toExponential(2)}`);
  check(dist(a0.p, a1.p) / rA0 > 0.01, 'A: horizontal drag moved the camera',
    `moved ${dist(a0.p, a1.p).toFixed(4)} of radius ${rA0.toFixed(3)}`);
  check(outOfPlane < 1e-6, 'A: horizontal drag spins about the screen-vertical axis',
    `axis\u00b7(up\u00d7eye) = ${outOfPlane.toExponential(2)} (should be 0)`);
  check(Math.abs(rA1 - rA0) / rA0 < 0.02, 'A: radius preserved', `${rA0.toFixed(3)} \u2192 ${rA1.toFixed(3)}`);
  check(rig.err < 1e-4, 'A: eye and up share one rigid rotation',
    `up deviates ${rig.err.toExponential(2)} from the predicted direction`);
}

await cdp.eval(`window.__pci.viewer.setViewAxis('iso')`);
await waitSettled();
{
  const v0 = await cam();
  await drag(0, -60);
  const v1 = await cam();
  const rV0 = dist(v0.p, v0.t);
  const rV1 = dist(v1.p, v1.t);
  const rig = rigidRotationError(v0, v1);
  // axis must be the screen-horizontal axis → ⟂ up and ⟂ eye
  const offUp = Math.abs(dot(rig.axis, norm(v0.up)));
  const offEye = Math.abs(dot(rig.axis, norm(sub(v0.p, v0.t))));
  console.log(`    vertical:   turned ${rig.turned.toFixed(2)}\u00b0, axis\u00b7up ${offUp.toExponential(2)}, axis\u00b7eye ${offEye.toExponential(2)}`);
  check(dist(v0.p, v1.p) / rV0 > 0.01, 'A: vertical drag moved the camera',
    `moved ${dist(v0.p, v1.p).toFixed(4)} of radius ${rV0.toFixed(3)}`);
  check(offUp < 1e-6 && offEye < 1e-6, 'A: vertical drag spins about the screen-horizontal axis',
    `axis\u00b7up = ${offUp.toExponential(2)}, axis\u00b7eye = ${offEye.toExponential(2)} (both should be 0)`);
  check(Math.abs(rV1 - rV0) / rV0 < 0.02, 'A: radius preserved (vertical)', `${rV0.toFixed(3)} \u2192 ${rV1.toFixed(3)}`);
}

/* ══════════ Scenario B: tilted up (after plane rotation) ══════════ */
console.log('\n── B. Horizontal drag after tilting up via the XY-plane buttons ──');
await cdp.eval(`window.__pci.viewer.setViewAxis('iso')`);
await waitSettled();
await rotatePlane('XY 平面', 2); // 2 × 15° = 30° about Z

const b0 = await cam();
const tilt = (Math.acos(Math.max(-1, Math.min(1, b0.up[1]))) * 180) / Math.PI;
console.log(`    up after rotation = [${b0.up.map((v) => v.toFixed(3))}]  (${tilt.toFixed(1)}\u00b0 from world Y)`);
check(tilt > 20 && tilt < 40, 'B: plane rotation actually tilted up',
  `up is ${tilt.toFixed(1)}\u00b0 from world Y (expected ~30\u00b0)`);

await drag(160, 0);
const b1 = await cam();
const rB0 = dist(b0.p, b0.t);
const rB1 = dist(b1.p, b1.t);
const rigid = rigidRotationError(b0, b1);
console.log(`    turned ${rigid.turned.toFixed(2)}\u00b0, rig-angle ${rigAngle(b0).toFixed(3)}\u00b0 \u2192 ${rigAngle(b1).toFixed(3)}\u00b0`);

check(dist(b0.p, b1.p) / rB0 > 0.01, 'B: drag actually moved the camera',
  `moved ${dist(b0.p, b1.p).toFixed(4)} of radius ${rB0.toFixed(3)}`);
check(Math.abs(rB1 - rB0) / rB0 < 0.02, 'B: radius preserved', `${rB0.toFixed(3)} \u2192 ${rB1.toFixed(3)}`);
check(Math.abs(rigAngle(b1) - rigAngle(b0)) < 0.05, 'B: eye/up angle preserved (no roll creep)',
  `${rigAngle(b0).toFixed(4)}\u00b0 \u2192 ${rigAngle(b1).toFixed(4)}\u00b0`);
check(rigid.err < 1e-4, 'B: eye and up share one rigid rotation',
  `up deviates ${rigid.err.toExponential(2)} from the predicted direction`);
check(Math.abs(len(b1.up) - 1) < 1e-3, 'B: up stays a unit vector', `|up| = ${len(b1.up).toFixed(6)}`);

/* ══════════ C. Full 360° about Z ══════════ */
console.log('\n── C. 24 \u00d7 15\u00b0 rotation about Z (full turn) ──');
await cdp.eval(`window.__pci.viewer.setViewAxis('iso')`);
await waitSettled();
const c0 = await cam();
let stuckAt = -1;
let prevPos = c0.p;
for (let i = 0; i < 24; i++) {
  await rotatePlane('XY 平面', 1);
  const now = await cam();
  if (dist(now.p, prevPos) / dist(now.p, now.t) < 0.005) { stuckAt = i + 1; break; }
  prevPos = now.p;
}
const c1 = await cam();
const posErr = dist(c1.p, c0.p) / dist(c0.p, c0.t);
const upErr = dist(norm(c1.up), norm(c0.up));
console.log(`    steps completed: ${stuckAt < 0 ? 24 : stuckAt - 1}/24, position return error ${(posErr * 100).toFixed(3)}%, up return error ${upErr.toExponential(2)}`);
check(stuckAt < 0, 'C: full 360\u00b0 turn about Z completes without seizing',
  `rotation froze at step ${stuckAt}`);
check(posErr < 0.005, 'C: camera returns to its starting position', `${(posErr * 100).toFixed(3)}% off`);
check(upErr < 1e-3, 'C: up returns to its starting direction', `off by ${upErr.toExponential(2)}`);

console.log(`\n  ${pass} passed, ${fail} failed\n`);

try { ws.close(); } catch {}
try { chrome.kill(); } catch {}
process.exit(fail ? 1 : 0);
