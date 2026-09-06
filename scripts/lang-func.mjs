/**
 * Functional smoke test for the custom language selector (raw CDP).
 *   node scripts/lang-func.mjs
 * Verifies: click-to-open, option-click switches language + persists,
 * rebuildUI updates UI text, and click-outside closes the menu.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const CHROME =
  process.env.CHROME_PATH ||
  'C:/Users/admin/.agent-browser/browsers/chrome-152.0.7977.75/chrome.exe';
const TARGET = process.env.SMOKE_URL || 'http://127.0.0.1:4450/';
const PORT = Number(process.env.CDP_PORT || 9337);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data);
      if (m.id !== undefined) { const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } } });
  }
  send(method, params = {}) { const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); } }, 30000); }); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; }
}

async function waitForDevTools(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { try { const res = await fetch(`http://127.0.0.1:${port}/json/version`); if (res.ok) return await res.json(); } catch {} await sleep(300); }
  throw new Error('Chrome DevTools 端口未就绪');
}

async function main() {
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu',
    '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
    '--hide-scrollbars', '--mute-audio',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${mkdtempSync(tmpdir())}/pci-langfn-`,
    '--window-size=1600,1000', 'about:blank',
  ], { stdio: 'ignore' });
  let cdp;
  const results = {};
  try {
    await waitForDevTools(PORT);
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    cdp = new Cdp(ws);
    await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });

    await cdp.send('Page.navigate', { url: TARGET });
    await sleep(2500);
    await cdp.eval(`document.getElementById('welcomeDemo').click();`);
    for (let i = 0; i < 60; i++) { const s = await cdp.eval(`return window.__pci ? window.__pci.state.stage : 'none';`); if (s === 'ready') break; await sleep(500); }

    const openLabel = () => cdp.eval(`return document.querySelector('.topbar .btn-primary span')?.textContent || null;`);

    const initialLang = await cdp.eval(`return document.documentElement.lang;`);
    const initialLabel = await openLabel();
    results.initial = { lang: initialLang, openBtnLabel: initialLabel };

    // 1) click to open
    await cdp.eval(`document.querySelector('.lang-btn').click();`);
    await sleep(200);
    results.opensOnClick = await cdp.eval(`return document.querySelector('.lang').classList.contains('is-open');`);

    // 2) select English
    await cdp.eval(`document.querySelector('.lang-opt[data-lang="en"]').click();`);
    await sleep(400); // rebuildUI
    results.afterSelectEn = {
      docLang: await cdp.eval(`return document.documentElement.lang;`),
      stored: await cdp.eval(`return localStorage.getItem('pci.lang');`),
      openBtnLabel: await openLabel(),
      menuClosedAfterSelect: await cdp.eval(`return !document.querySelector('.lang')?.classList.contains('is-open');`),
    };

    // 3) re-open then click outside to close
    await cdp.eval(`document.querySelector('.lang-btn').click();`);
    await sleep(150);
    const openedAgain = await cdp.eval(`return document.querySelector('.lang').classList.contains('is-open');`);
    await cdp.eval(`document.querySelector('.viewport').click();`);
    await sleep(150);
    const closedOnOutside = await cdp.eval(`return !document.querySelector('.lang').classList.contains('is-open');`);
    results.clickOutside = { openedAgain, closedOnOutside };

    // 4) switch back to zh for cleanliness
    await cdp.eval(`document.querySelector('.lang-btn').click();`);
    await sleep(150);
    await cdp.eval(`document.querySelector('.lang-opt[data-lang="zh"]').click();`);
    await sleep(300);
    results.afterSelectZh = {
      docLang: await cdp.eval(`return document.documentElement.lang;`),
      openBtnLabel: await openLabel(),
    };

    const ok =
      results.opensOnClick === true &&
      results.afterSelectEn.docLang === 'en' &&
      results.afterSelectEn.stored === 'en' &&
      results.afterSelectEn.openBtnLabel === 'Open File' &&
      results.afterSelectEn.menuClosedAfterSelect === true &&
      results.clickOutside.openedAgain === true &&
      results.clickOutside.closedOnOutside === true &&
      results.afterSelectZh.docLang === 'zh-CN';

    console.log(JSON.stringify(results, null, 2));
    console.log(`\nLANG_FUNC_OK=${ok}`);
    process.exitCode = ok ? 0 : 1;
  } finally {
    try { await cdp?.send('Browser.close'); } catch {}
    chrome.kill('SIGKILL');
  }
}
main().catch((e) => { console.error('功能测试失败:', e.message); process.exit(1); });
