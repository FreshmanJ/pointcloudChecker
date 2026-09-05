import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const CHROME = 'C:/Users/admin/.agent-browser/browsers/chrome-152.0.7977.75/chrome.exe';
const PORT = 9379;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id !== undefined) { const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } } }); }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('to ' + method)); } }, 20000); }); }
  async eval(x) { const r = await this.send('Runtime.evaluate', { expression: '(async()=>{' + x + '})()', awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result && r.result.value; }
}
const wait = async (p) => { for (let i = 0; i < 100; i++) { try { const r = await fetch('http://127.0.0.1:' + p + '/json/version'); if (r.ok) return r.json(); } catch {} await sleep(300); } throw new Error('no cdp'); };
const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--hide-scrollbars', '--remote-debugging-port=' + PORT, '--user-data-dir=' + mkdtempSync(path.join(tmpdir(), 'dbgp-')), 'about:blank'], { stdio: 'ignore' });
try {
  await wait(PORT);
  await sleep(500);
  const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:5173/' }); await sleep(2500);
  await cdp.eval('document.getElementById(\'welcomeDemo\').click();');
  for (let i = 0; i < 60; i++) { if (await cdp.eval('return window.__pci?window.__pci.state.stage:\'none\';') === 'ready') break; await sleep(400); }
  await sleep(500);
  console.log('theme=', await cdp.eval('return document.documentElement.getAttribute(\'data-theme\');'));
  console.log('leftOpen=', await cdp.eval('return window.__pci.state.ui.leftOpen;'));
  console.log('panelLeft exists=', await cdp.eval('return !!document.getElementById(\'panelLeft\');'));
  console.log('rect obj=', JSON.stringify(await cdp.eval('(function(){const b=document.getElementById(\'panelLeft\').getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height};})()')));
  console.log('rect arr=', JSON.stringify(await cdp.eval('(function(){const b=document.getElementById(\'panelRight\').getBoundingClientRect();return [b.x,b.y,b.width,b.height];})()')));
  console.log('rect obj noawait=', JSON.stringify(await cdp.send('Runtime.evaluate', { expression: 'JSON.stringify((function(){const b=document.getElementById(\'panelLeft\').getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height};})())', returnByValue: true }).then(r => r.result && r.result.value)));
  console.log('typeof gBCR=', await cdp.eval('return typeof document.getElementById(\'panelLeft\').getBoundingClientRect'));
} finally { try { await cdp.send('Browser.close'); } catch {} chrome.kill('SIGKILL'); }
