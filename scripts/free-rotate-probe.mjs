/**
 * Probe: can the camera keep rotating past the poles?
 *
 * A real 3D viewer must let you tumble the model without ever "hitting a wall".
 * OrbitControls cannot: it keeps a fixed world up and clamps the polar angle to
 * [EPS, PI-EPS] via Spherical.makeSafe(), so the view seizes at the zenith and
 * the nadir. TrackballControls carries `camera.up` along with every rotation and
 * has no such clamp.
 *
 * This probe drags upward in a straight line many times in a row and measures
 * how far the camera actually turned on each drag. Freely rotating means every
 * drag keeps turning the camera by roughly the same amount; a clamp shows up as
 * per-drag deltas collapsing to ~0.
 *
 *   node scripts/free-rotate-probe.mjs [url]
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

const CHROME =
  process.env.CHROME_PATH ||
  'C:/Users/admin/.agent-browser/browsers/chrome-152.0.7977.75/chrome.exe';
const TARGET = process.argv[2] || 'http://127.0.0.1:4173/';
const PORT = Number(process.env.CDP_PORT || 9357);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(ok, label, detail = '') {
  if (ok) { pass++; console.log(`  \u2713 ${label}${detail ? '  \u2014 ' + detail : ''}`); }
  else { fail++; console.log(`  \u2717 ${label}${detail ? '  \u2014 ' + detail : ''}`); }
}

/* demo cloud */
const dir = mkdtempSync(path.join(tmpdir(), 'pci-free-'));
const csv = path.join(dir, 'demo.csv');
{
  const lines = ['x,y,z'];
  for (let i = 0; i < 400; i++) {
    const a = (i / 400) * Math.PI * 2;
    lines.push(`${(Math.cos(a) * 5).toFixed(4)},${(Math.sin(a) * 5).toFixed(4)},${((i / 400) * 6 - 3).toFixed(4)}`);
  }
  writeFileSync(csv, lines.join('\n') + '\n');
}

const profileDir = mkdtempSync(path.join(tmpdir(), 'pci-free-chrome-'));
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

const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
const q = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#fileInput' });
await cdp.send('DOM.setFileInputFiles', { nodeId: q.nodeId, files: [csv] });
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

/** Poll until the camera stops moving (frameAll easing + damping both settle). */
async function waitSettled(max = 40) {
  let prev = null;
  for (let i = 0; i < max; i++) {
    const cur = await cdp.eval(`window.__pci.viewer.camera.position.toArray().map(v=>v.toFixed(5)).join(',')`);
    if (cur === prev) return;
    prev = cur; await sleep(150);
  }
}

/**
 * Snapshot of the camera around its target:
 *   offset — eye offset vector, r — orbit radius,
 *   polar  — angle from +Y in degrees (0 = straight down the +Y axis),
 *   roll   — angle between the eye offset and the camera up vector (should stay ~90°).
 */
async function snapshot() {
  const raw = await cdp.eval(`
    (() => {
      const v = window.__pci.viewer;
      const off = v.camera.position.clone().sub(v.controls.target);
      const up = v.camera.up;
      const r = off.length();
      const cos = Math.max(-1, Math.min(1, off.dot(up) / (r * up.length() || 1)));
      return JSON.stringify({
        offset: off.toArray(), up: up.toArray(), upLen: up.length(), r,
        polar: Math.acos(Math.max(-1, Math.min(1, off.y / r))) * 180 / Math.PI,
        roll: Math.acos(cos) * 180 / Math.PI,
      });
    })()
  `);
  return JSON.parse(raw);
}

/** Angle in degrees between two eye-offset vectors. */
function angleBetween(a, b) {
  const la = Math.hypot(...a);
  const lb = Math.hypot(...b);
  const d = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb || 1);
  return (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI;
}

async function drag(dx, dy) {
  const cx = 800, cy = 500;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1, buttons: 1 });
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: cx + (dx * i) / steps, y: cy + (dy * i) / steps, button: 'left', buttons: 1,
    });
    await sleep(20);
  }
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: cx + dx, y: cy + dy, button: 'left', buttons: 0, clickCount: 1,
  });
  await waitSettled();
}

/* ── start from a known iso view ─────────────────────────────────────────── */
await cdp.eval(`window.__pci.viewer.setViewAxis('iso')`);
await waitSettled();
const start = await snapshot();
console.log(`\n\u2500\u2500 Tumbling upward: 14 \u00d7 120 px drags \u2500\u2500`);
console.log(`    start: polar ${start.polar.toFixed(2)}\u00b0, radius ${start.r.toFixed(3)}, roll ${start.roll.toFixed(2)}\u00b0`);

const deltas = [];
let prevOffset = start.offset;
let prev = start;
const radii = [start.r];
const rolls = [start.roll];
for (let i = 0; i < 14; i++) {
  await drag(0, -120);
  const s = await snapshot();
  const d = angleBetween(prevOffset, s.offset);
  deltas.push(d);
  radii.push(s.r);
  rolls.push(s.roll);
  console.log(`    drag ${String(i + 1).padStart(2)}: turned ${d.toFixed(2).padStart(6)}\u00b0   polar ${s.polar.toFixed(2).padStart(7)}\u00b0   roll ${s.roll.toFixed(2)}\u00b0`);
  prevOffset = s.offset;
  prev = s;
}

const stalled = deltas.filter((d) => d < 2).length;
const totalTravel = deltas.reduce((a, b) => a + b, 0);
const radiusDrift = Math.max(...radii.map((r) => Math.abs(r - start.r) / start.r));
const rollDrift = Math.max(...rolls.map((r) => Math.abs(r - start.roll)));
const upSane = Math.abs(prev.upLen - 1) < 1e-3;

console.log('\n' + '='.repeat(64));
check(stalled === 0, 'no drag stalls', `${stalled} of ${deltas.length} drags turned < 2°`);
check(totalTravel > 360, 'camera tumbled more than a full turn', `${totalTravel.toFixed(1)}° total over ${deltas.length} drags`);
check(Math.min(...deltas) > 5, 'every drag turns a meaningful amount', `min ${Math.min(...deltas).toFixed(2)}°`);
check(radiusDrift < 0.02, 'orbit radius preserved', `max drift ${(radiusDrift * 100).toFixed(3)}%`);
check(rollDrift < 1, 'eye/up angle preserved (no tumbling artefacts)', `max drift ${rollDrift.toFixed(3)}°`);
check(upSane, 'up vector stays normalized', `|up| = ${prev.upLen.toFixed(6)}`);
console.log('='.repeat(64));

/* ── sideways drag: the other axis must be free too ──────────────────────── */
console.log(`\n\u2500\u2500 Tumbling sideways: 14 \u00d7 120 px drags \u2500\u2500`);
await cdp.eval(`window.__pci.viewer.setViewAxis('y')`);
await waitSettled();
const topStart = await snapshot();
let prev2 = topStart.offset;
const deltas2 = [];
for (let i = 0; i < 14; i++) {
  await drag(120, 0);
  const s = await snapshot();
  deltas2.push(angleBetween(prev2, s.offset));
  prev2 = s.offset;
}
const total2 = deltas2.reduce((a, b) => a + b, 0);
const stalled2 = deltas2.filter((d) => d < 2).length;
console.log(`    per-drag: ${deltas2.map((d) => d.toFixed(1)).join(', ')}`);
console.log('\n' + '='.repeat(64));
check(stalled2 === 0, 'no sideways drag stalls', `${stalled2} of ${deltas2.length} drags turned < 2°`);
check(total2 > 360, 'sideways tumble exceeds a full turn', `${total2.toFixed(1)}° total`);
check(Math.abs(topStart.polar - 0) < 0.5, 'top preset view is a true straight-down view', `polar ${topStart.polar.toFixed(3)}°`);
console.log('='.repeat(64));

/* ── turntable: TrackballControls ships no autoRotate, so it is hand-rolled ── */
console.log(`\n\u2500\u2500 Turntable auto-rotation \u2500\u2500`);
await cdp.eval(`window.__pci.viewer.setViewAxis('iso')`);
await waitSettled();
const before = await snapshot();
await cdp.eval(`window.__pci.setRender({ turntable: true })`);
await sleep(2000);
const after = await snapshot();
await cdp.eval(`window.__pci.setRender({ turntable: false })`);
await waitSettled();

// Measured as an azimuth sweep rather than a plain 3D angle: a spin about the
// world Y axis leaves the height untouched, so the 3D chord angle understates it.
let spun = (Math.atan2(after.offset[2], after.offset[0]) - Math.atan2(before.offset[2], before.offset[0]));
while (spun > Math.PI) spun -= 2 * Math.PI;
while (spun < -Math.PI) spun += 2 * Math.PI;
spun = Math.abs((spun * 180) / Math.PI);
const heightDrift = Math.abs(after.offset[1] - before.offset[1]) / before.r;
const radiusHeld = Math.abs(after.r - before.r) / before.r;
console.log(`    2 s of turntable turned the camera ${spun.toFixed(2)}\u00b0 (expect ~10.8\u00b0); radius drift ${(radiusHeld * 100).toFixed(3)}%, height drift ${(heightDrift * 100).toFixed(3)}%`);
console.log('\n' + '='.repeat(64));
check(spun > 6 && spun < 18, 'turntable turns ~5.4\u00b0/s', `${spun.toFixed(2)}\u00b0 in 2 s`);
check(heightDrift < 0.005, 'turntable spins about world Y (height unchanged)', `${(heightDrift * 100).toFixed(3)}%`);
check(radiusHeld < 0.005, 'turntable preserves orbit radius', `${(radiusHeld * 100).toFixed(3)}%`);
check(Math.abs(after.roll - before.roll) < 0.5, 'turntable preserves the eye/up angle', `drift ${Math.abs(after.roll - before.roll).toFixed(3)}\u00b0`);
console.log('='.repeat(64));

console.log(`\n  ${pass} passed, ${fail} failed\n`);

try { ws.close(); } catch {}
try { chrome.kill(); } catch {}
process.exit(fail ? 1 : 0);
