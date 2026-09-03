/**
 * Theme screenshot + verification harness (raw Chrome DevTools Protocol).
 *   node scripts/theme-shot.mjs [url]
 * Loads the demo cloud, captures dark + light themes, and verifies the
 * toggle actually flips <html data-theme> and the computed surface colour.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME =
  process.env.CHROME_PATH ||
  'C:/Users/admin/.agent-browser/browsers/chrome-152.0.7977.75/chrome.exe';
const TARGET = process.argv[2] || process.env.SMOKE_URL || 'http://localhost:4173/';
const PORT = Number(process.env.CDP_PORT || 9334);
const OUT = mkdtempSync(path.join(tmpdir(), 'pci-theme-'));
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
  async shot(path) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(path, Buffer.from(r.data, 'base64'));
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

async function main() {
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu',
    '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
    '--hide-scrollbars', '--mute-audio',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pci-ts-'))}`,
    '--window-size=1600,1000', 'about:blank',
  ], { stdio: 'ignore' });

  let cdp;
  const errors = [];
  try {
    await waitForDevTools(PORT);
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    cdp = new Cdp(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    cdp.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || 'exception');
    });

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });

    // 1) boot + load demo
    await cdp.send('Page.navigate', { url: TARGET });
    await sleep(2500);
    await cdp.eval(`document.getElementById('welcomeDemo').click();`);
    for (let i = 0; i < 60; i++) {
      const s = await cdp.eval(`return window.__pci ? window.__pci.state.stage : 'none';`);
      if (s === 'ready') break;
      await sleep(500);
    }
    const probe = () => cdp.eval(`return (() => {
      const cs = getComputedStyle(document.documentElement);
      const app = window.__pci;
      return {
        theme: document.documentElement.getAttribute('data-theme'),
        bgApp: cs.getPropertyValue('--bg-app').trim(),
        bgPanel: cs.getPropertyValue('--bg-panel').trim(),
        text1: cs.getPropertyValue('--text-1').trim(),
        vpBg: getComputedStyle(document.querySelector('.viewport')).backgroundColor,
        canvasBg: app && app.state.render ? app.state.render.background : null,
        hasThemeBtn: !!document.getElementById('themeToggle'),
      };
    })();`);

    // 2) dark screenshot
    const dark = await probe();
    await cdp.shot(path.join(OUT, 'theme-dark.png'));

    // 3) toggle to light
    await cdp.eval(`document.getElementById('themeToggle').click();`);
    await sleep(700);
    const light = await probe();
    await cdp.shot(path.join(OUT, 'theme-light.png'));

    // 4) toggle back to dark
    await cdp.eval(`document.getElementById('themeToggle').click();`);
    await sleep(700);
    const dark2 = await probe();
    await cdp.shot(path.join(OUT, 'theme-dark2.png'));

    const report = { dark, light, dark2, errors, files: {
      dark: path.join(OUT, 'theme-dark.png'),
      light: path.join(OUT, 'theme-light.png'),
      dark2: path.join(OUT, 'theme-dark2.png'),
    } };
    console.log(JSON.stringify(report, null, 2));
    const okToggle = light.theme === 'light' && dark.theme === 'dark' && dark2.theme === 'dark';
    const okSurface = dark.bgApp !== light.bgApp;
    const okBtn = dark.hasThemeBtn && light.hasThemeBtn;
    const okBgLink = light.canvasBg && light.canvasBg.toLowerCase() !== dark.canvasBg.toLowerCase();
    console.log(`\nTOGGLE_OK=${okToggle}  SURFACE_CHANGED=${okSurface}  BTN_PRESENT=${okBtn}  CANVAS_BG_LINKED=${okBgLink}  ERRORS=${errors.length}`);
    process.exitCode = okToggle && okSurface && okBtn && okBgLink && errors.length === 0 ? 0 : 1;
  } finally {
    try { await cdp?.send('Browser.close'); } catch { /* ignore */ }
    chrome.kill('SIGKILL');
  }
}

main().catch((e) => { console.error('主题截图失败:', e.message); process.exit(1); });
