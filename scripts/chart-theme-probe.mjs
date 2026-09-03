/**
 * Probe: verify profile chart canvas background in light theme.
 *
 * 1. Open app → switch to light mode
 * 2. Find .chart-canvas-box canvas
 * 3. Read its computed background + check it's white-ish (not #0e1218)
 * 4. Switch back to dark → verify dark bg
 *
 *   node scripts/chart-theme-probe.mjs [url]
 */

import { spawn } from 'node:child_process';

const CHROME =
  process.env.CHROME_PATH ||
  'C:/Users/admin/.agent-browser/browsers/chrome-152.0.7977.75/chrome.exe';
const TARGET = process.argv[2] || 'http://127.0.0.1:4173/';
const PORT = Number(process.env.CDP_PORT || 9344);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ok = 0;
let fail = 0;
function check(label, condition, detail = '') {
  if (condition) { ok++; console.log(`  \u2713 ${label}`); }
  else { fail++; console.log(`  \u2717 ${label}${detail ? ` \u2014 ${detail}` : ''}`); }
}

/* ── Launch Chrome ── */
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  '--headless=new',
  '--enable-unsafe-swiftshader',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--no-sandbox',
  '--disable-gpu-sandbox',
  '--disable-dev-shm-usage',
  TARGET,
], { stdio: 'ignore' });

await sleep(2000);

/* ── Connect CDP (attach to page target) ── */
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
if (!page) throw new Error('no page target found');
const ws = new globalThis.WebSocket(page.webSocketDebuggerUrl);
await new Promise((res) => { ws.onopen = res; });

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
        }
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 15_000);
    });
  }
  eval(expr) {
    return this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    }).then(r => {
      if (r?.exceptionDetails) throw new Error(String(r.exceptionDetails.text || 'JS error'));
      return r?.result?.value;
    });
  }
}

const cdp = new Cdp(ws);

/* ── Wait for app to be ready ── */
await sleep(1500);

/* ── Test: Light theme ── */
console.log('── Light mode ──');
await cdp.send('Page.enable');
await sleep(1500);

// Click profile tab so the chart canvas renders
await cdp.eval(`
  (() => {
    const b = document.querySelector('.tab[data-tab="profile"]');
    if(b) { b.click(); return 'clicked'; }
    return 'not found: ' + Array.from(document.querySelectorAll('.tab')).map(t=>t.dataset.tab).join(',');
  })()
`);
await sleep(1000);

await cdp.eval(`document.documentElement.setAttribute('data-theme', 'light')`);
await sleep(800);

const lightCanvas = await (async () => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const raw = await cdp.eval(`
      (() => {
        const cv = document.querySelector('.chart-canvas-box canvas');
        if (!cv) return JSON.stringify({error: 'no canvas'});
        if (cv.width === 0 || cv.height === 0) return JSON.stringify({error: 'zero size', w: cv.width, h: cv.height});
        const d = cv.getContext('2d').getImageData(0, 0, 1, 1).data;
        return JSON.stringify({r:d[0], g:d[1], b:d[2], a:d[3]});
      })()
    `);
    let p = null;
    try { p = JSON.parse(raw); } catch {}
    if (p && !p.error) return raw;
    console.log(`    [retry ${attempt+1}] ${raw}`);
    await sleep(500);
  }
  return JSON.stringify({error: 'timeout'});
})();
let light = null;
try { light = JSON.parse(lightCanvas); } catch {}
check('canvas element exists in light mode', light && !light.error, light?.error || '');
if (light && !light.error) {
  const { r, g, b } = light;
  check(`pixel is light rgb(${r},${g},${b})`, r > 200 && g > 200 && b > 200, `expected >200 each`);
  check('NOT dark #0e1218', !(r < 20 && g < 30 && b < 30), `got rgb(${r},${g},${b})`);
}

/* ── Test: Dark theme ── */
console.log('\n── Dark mode ──');
await cdp.eval(`document.documentElement.setAttribute('data-theme', 'dark')`);
await sleep(600);

const darkCanvas = await (async () => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const raw = await cdp.eval(`
      (() => {
        const cv = document.querySelector('.chart-canvas-box canvas');
        if (!cv) return JSON.stringify({error: 'no canvas'});
        if (cv.width === 0 || cv.height === 0) return JSON.stringify({error: 'zero size', w: cv.width, h: cv.height});
        const d = cv.getContext('2d').getImageData(0, 0, 1, 1).data;
        return JSON.stringify({r:d[0], g:d[1], b:d[2], a:d[3]});
      })()
    `);
    let p = null;
    try { p = JSON.parse(raw); } catch {}
    if (p && !p.error) return raw;
    await sleep(500);
  }
  return JSON.stringify({error: 'timeout'});
})();
let dark = null;
try { dark = JSON.parse(darkCanvas); } catch {}
check('canvas element exists in dark mode', dark && !dark.error, dark?.error || '');
if (dark && !dark.error) {
  const { r, g, b } = dark;
  // Dark background (not light); allow some variation from grid/axis overlap at sample point
  const isDark = r < 80 && g < 90 && b < 100;
  check(`pixel is dark rgb(${r},${g},${b})`, isDark, `expected dark, got ${r},${g},${b}`);
}

/* ── Cleanup ── */
ws.close();
chrome.kill();

console.log(`\n${ok + fail} checks: ${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
