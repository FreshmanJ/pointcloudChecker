/**
 * Language-selector visual verification (raw Chrome DevTools Protocol).
 *   node scripts/lang-shot.mjs
 * Loads the demo, then captures the top bar (closed + menu-open) in both
 * dark and light themes so we can confirm the custom dropdown renders well.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME =
  process.env.CHROME_PATH ||
  'C:/Users/admin/.agent-browser/browsers/chrome-152.0.7977.75/chrome.exe';
const TARGET = process.env.SMOKE_URL || 'http://127.0.0.1:4450/';
const PORT = Number(process.env.CDP_PORT || 9336);
const OUT = mkdtempSync(path.join(tmpdir(), 'pci-lang-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (p) { this.pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); }
      }
    });
  }
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
  async shot(file, clip) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip });
    writeFileSync(file, Buffer.from(r.data, 'base64'));
  }
}

async function waitForDevTools(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const res = await fetch(`http://127.0.0.1:${port}/json/version`); if (res.ok) return await res.json(); } catch { /* retry */ }
    await sleep(300);
  }
  throw new Error('Chrome DevTools 端口未就绪');
}

async function topbarClip(cdp) {
  return cdp.eval(`return (() => {
    const t = document.querySelector('.topbar').getBoundingClientRect();
    return { x: t.x, y: t.y, width: t.width, height: t.height + 150, scale: 1 };
  })();`);
}

async function main() {
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu',
    '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
    '--hide-scrollbars', '--mute-audio',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pci-lang-'))}`,
    '--window-size=1600,1000', 'about:blank',
  ], { stdio: 'ignore' });

  let cdp;
  try {
    await waitForDevTools(PORT);
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
    for (let i = 0; i < 60; i++) {
      const s = await cdp.eval(`return window.__pci ? window.__pci.state.stage : 'none';`);
      if (s === 'ready') break;
      await sleep(500);
    }

    const openMenu = () => cdp.eval(`document.querySelector('.lang').classList.add('is-open');`);
    const closeMenu = () => cdp.eval(`document.querySelector('.lang').classList.remove('is-open');`);

    // ── Dark: closed ──
    let clip = await topbarClip(cdp);
    await cdp.shot(path.join(OUT, 'dark-closed.png'), clip);

    // ── Dark: open ──
    await openMenu(); await sleep(350);
    clip = await topbarClip(cdp);
    const darkProbe = await cdp.eval(`return (() => {
      const b = document.querySelector('.lang-btn');
      const m = document.querySelector('.lang-menu');
      const cs = getComputedStyle(b), ms = getComputedStyle(m);
      return {
        theme: document.documentElement.getAttribute('data-theme'),
        btnBg: cs.backgroundColor, btnBorder: cs.borderColor, btnColor: cs.color, btnRadius: cs.borderRadius,
        menuBg: ms.backgroundColor, menuBorder: ms.borderColor, menuDisplay: ms.display,
        label: b.querySelector('.lang-label').textContent,
        activeOpt: [...document.querySelectorAll('.lang-opt')].find(o => o.classList.contains('is-on'))?.querySelector('span')?.textContent || null,
      };
    })();`);
    await cdp.shot(path.join(OUT, 'dark-open.png'), clip);
    await closeMenu();

    // ── Light: closed ──
    await cdp.eval(`document.getElementById('themeToggle').click();`);
    await sleep(700);
    clip = await topbarClip(cdp);
    await cdp.shot(path.join(OUT, 'light-closed.png'), clip);

    // ── Light: open ──
    await openMenu(); await sleep(350);
    clip = await topbarClip(cdp);
    const lightProbe = await cdp.eval(`return (() => {
      const b = document.querySelector('.lang-btn');
      const m = document.querySelector('.lang-menu');
      const cs = getComputedStyle(b), ms = getComputedStyle(m);
      return { theme: document.documentElement.getAttribute('data-theme'),
        btnBg: cs.backgroundColor, btnBorder: cs.borderColor, btnColor: cs.color,
        menuBg: ms.backgroundColor, menuBorder: ms.borderColor, menuDisplay: ms.display };
    })();`);
    await cdp.shot(path.join(OUT, 'light-open.png'), clip);
    await closeMenu();

    const report = { darkProbe, lightProbe, files: {
      darkClosed: path.join(OUT, 'dark-closed.png'),
      darkOpen: path.join(OUT, 'dark-open.png'),
      lightClosed: path.join(OUT, 'light-closed.png'),
      lightOpen: path.join(OUT, 'light-open.png'),
    } };
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 0;
  } finally {
    try { await cdp?.send('Browser.close'); } catch { /* ignore */ }
    chrome.kill('SIGKILL');
  }
}

main().catch((e) => { console.error('截图失败:', e.message); process.exit(1); });
