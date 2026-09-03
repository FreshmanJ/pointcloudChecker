/**
 * Browser smoke test for the coordinate-column picker dialog.
 *
 * Drives the app over the Chrome DevTools Protocol (no Playwright/Puppeteer).
 * Uploads a CSV whose coordinate columns are NOT the first three, then:
 *   1. verifies the dialog appears with correct defaults (auto-mapped X/Y/Z);
 *   2. confirms with the default 3D mapping and checks the parsed coordinates;
 *   3. switches to 2D and confirms, checking that Z is forced to 0;
 *   4. cancels the dialog and verifies no cloud was loaded.
 *
 *   node scripts/dialog-smoke.mjs [url]
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME =
  process.env.CHROME_PATH ||
  'C:/Users/admin/.agent-browser/browsers/chrome-152.0.7977.75/chrome.exe';
const TARGET = process.argv[2] || process.env.SMOKE_URL || 'http://localhost:4173/';
const PORT = Number(process.env.CDP_PORT || 9341);

// CSV whose coordinate columns are NOT the first three: name, Lon, Lat, Elev, temp
const N = 300;
const first = { Lon: 10.0, Lat: 20.0, Elev: 5.0, temp: 30.0 };
{
  const lines = ['name,Lon,Lat,Elev,temp'];
  for (let i = 0; i < N; i++) {
    const lon = 10 + i * 0.1;
    const lat = 20 + i * 0.05;
    const elev = 5 + i * 0.02;
    const temp = 30 + i * 0.1;
    lines.push(`pt${i},${lon.toFixed(4)},${lat.toFixed(4)},${elev.toFixed(4)},${temp.toFixed(4)}`);
  }
  const probeDir = mkdtempSync(path.join(tmpdir(), 'pci-dlg-'));
  writeFileSync(path.join(probeDir, 'coords.csv'), lines.join('\n') + '\n');
  globalThis.__PROBE_DIR = probeDir;
  globalThis.__CSV = path.join(probeDir, 'coords.csv');
  // X/Y/Z each carry some numbers but never on the same row → would yield 0 points.
  const misalignLines = ['x,y,z', '1,,3', ',2,3', '4,,3'];
  writeFileSync(path.join(probeDir, 'misalign.csv'), misalignLines.join('\n') + '\n');
  globalThis.__MISALIGN = path.join(probeDir, 'misalign.csv');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
let checks = 0;
function ok(label, cond, detail = '') {
  checks++;
  const tag = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  console.log(`  ${tag}  ${label}${detail ? ` — ${detail}` : ''}`);
}
function section(t) {
  console.log(`\n── ${t} ──`);
}

async function waitForApp(cdp, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await cdp
      .eval(`return { app: typeof window.__pci === 'object' && window.__pci !== null };`)
      .catch(() => ({ app: false }));
    if (ready.app) return;
    await sleep(250);
  }
  throw new Error('应用启动超时');
}

/* ══════════ CDP client (mirrors scripts/browser-smoke.mjs) ══════════ */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
        }
      } else {
        for (const fn of this.listeners) fn(msg);
      }
    });
  }
  on(fn) { this.listeners.push(fn); }
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
      }, 30_000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      const e = r.exceptionDetails;
      throw new Error(e.exception?.description || e.text || 'eval failed');
    }
    return r.result.value;
  }
}

async function waitForDevTools(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch { /* not up yet */ }
    await sleep(300);
  }
  throw new Error('Chrome DevTools 端口未就绪');
}

/** Upload a file via the hidden #fileInput and wait for the dialog to open. */
async function openDialog(cdp, file) {
  await cdp.eval(`if (window.__pci.closeCloud) window.__pci.closeCloud();`);
  await sleep(300);
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
  const q = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#fileInput' });
  await cdp.send('DOM.setFileInputFiles', { nodeId: q.nodeId, files: [file] });
  for (let i = 0; i < 40; i++) {
    const has = await cdp.eval(`return !!document.querySelector('.modal-backdrop');`);
    if (has) return true;
    await sleep(250);
  }
  throw new Error('坐标列选择对话框未出现');
}

async function waitReady(cdp) {
  for (let i = 0; i < 60; i++) {
    const stage = await cdp.eval(`return window.__pci.state.stage;`);
    if (stage === 'ready') return true;
    await sleep(500);
  }
  return false;
}

async function main() {
  const profileDir = mkdtempSync(path.join(tmpdir(), 'pci-dlg-smoke-'));
  const csvFile = globalThis.__CSV;
  console.log(`Chrome: ${CHROME}`);
  console.log(`Target: ${TARGET}`);

  const chrome = spawn(
    CHROME,
    [
      '--headless=new', '--no-sandbox', '--disable-gpu',
      '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
      '--hide-scrollbars', '--mute-audio',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profileDir}`,
      '--window-size=1600,1000', 'about:blank',
    ],
    { stdio: 'ignore' }
  );

  let cdp;
  try {
    await waitForDevTools(PORT);
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (!page) throw new Error('找不到 page 目标');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    cdp = new Cdp(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    section('1. 启动');
    await cdp.send('Page.navigate', { url: TARGET });
    await waitForApp(cdp);
    ok('App 已启动', true);

    /* ───────── 2. dialog appears with correct defaults ───────── */
    section('2. 坐标列对话框（默认 3D 自动映射）');
    await openDialog(cdp, csvFile);
    const dlg = await cdp.eval(`
      const b = document.querySelector('.modal-backdrop');
      const sels = b.querySelectorAll('.modal-cols .select');
      return {
        title: b.querySelector('.modal-title')?.textContent,
        cols: b.querySelectorAll('.modal-cols .field').length,
        optsX: sels[0] ? sels[0].options.length : 0,
        valX: sels[0] ? sels[0].value : null,
        valY: sels[1] ? sels[1].value : null,
        valZ: sels[2] ? sels[2].value : null,
        zHidden: sels[2] ? sels[2].closest('.field').hidden : null,
        modeOn: b.querySelector('.seg-btn.is-on')?.textContent,
        preview: b.querySelector('.modal-preview')?.textContent || '',
      };
    `);
    ok('对话框已弹出', !!dlg.title, dlg.title || '');
    ok('标题为「选择坐标列」', dlg.title === '选择坐标列', dlg.title);
    ok('每轴下拉含全部 5 列', dlg.optsX === 5, `${dlg.optsX} 个选项`);
    ok('X 默认映射到 Lon（列 #2）', dlg.valX === '1', `X=${dlg.valX}`);
    ok('Y 默认映射到 Lat（列 #3）', dlg.valY === '2', `Y=${dlg.valY}`);
    ok('Z 默认映射到 Elev（列 #4）', dlg.valZ === '3', `Z=${dlg.valZ}`);
    ok('默认三维，Z 列可见', dlg.zHidden === false && /三维/.test(dlg.modeOn || ''), dlg.modeOn);
    ok('预览显示了列名 Lon', /Lon/.test(dlg.preview), dlg.preview.slice(0, 60));

    /* ───────── 3. confirm default 3D → correct coordinates ───────── */
    section('3. 确认 3D 映射后正确解析');
    await cdp.eval(`document.querySelector('.modal-foot .btn-primary').click();`);
    const ready = await waitReady(cdp);
    ok('上传后进入 ready', ready);
    const r3 = await cdp.eval(`
      const s = window.__pci.state;
      const p0 = s.view.positionAt(0);
      return {
        count: s.source.count,
        format: s.fileInfo.format,
        p0: [p0[0], p0[1], p0[2]],
        coordMeta: s.source.meta['坐标列'] || '',
      };
    `);
    ok('点云已解析', r3.count > 0, `${r3.count} 点`);
    ok('格式识别为 CSV', (r3.format || '').toUpperCase() === 'CSV', r3.format);
    ok('首点 X = Lon', Math.abs(r3.p0[0] - first.Lon) < 1e-3, `X=${r3.p0[0]}`);
    ok('首点 Y = Lat', Math.abs(r3.p0[1] - first.Lat) < 1e-3, `Y=${r3.p0[1]}`);
    ok('首点 Z = Elev', Math.abs(r3.p0[2] - first.Elev) < 1e-3, `Z=${r3.p0[2]}`);
    ok('坐标列记录到 meta', /X#2 Y#3 Z#4/.test(r3.coordMeta), r3.coordMeta);

    /* ───────── 4. 2D mode forces Z = 0 ───────── */
    section('4. 切换为二维（Z 固定为 0）');
    await openDialog(cdp, csvFile);
    await cdp.eval(`
      const b = document.querySelector('.modal-backdrop');
      const seg2d = Array.from(b.querySelectorAll('.seg-btn')).find(x => /二维/.test(x.textContent));
      seg2d.click();
    `);
    const twoD = await cdp.eval(`
      const b = document.querySelector('.modal-backdrop');
      return {
        modeOn: b.querySelector('.seg-btn.is-on')?.textContent,
        zHidden: b.querySelectorAll('.modal-cols .select')[2].closest('.field').hidden,
        note: b.querySelector('.modal-note')?.hidden,
      };
    `);
    ok('已切换到二维', /二维/.test(twoD.modeOn || ''), twoD.modeOn);
    ok('二维下 Z 列已隐藏', twoD.zHidden === true);
    ok('二维说明已显示', twoD.note === false);
    await cdp.eval(`document.querySelector('.modal-foot .btn-primary').click();`);
    await waitReady(cdp);
    const r2 = await cdp.eval(`
      const p0 = window.__pci.state.view.positionAt(0);
      return { z: p0[2], coordMeta: window.__pci.state.source.meta['坐标列'] || '' };
    `);
    ok('二维模式 Z = 0', Math.abs(r2.z) < 1e-6, `Z=${r2.z}`);
    ok('meta 标记为 2D', /2D|二维/.test(r2.coordMeta), r2.coordMeta);

    /* ───────── 5. cancel leaves no cloud ───────── */
    section('5. 取消对话框不载入');
    await openDialog(cdp, csvFile);
    await cdp.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`);
    await sleep(400);
    const cancelled = await cdp.eval(`
      return {
        dialogGone: !document.querySelector('.modal-backdrop'),
        stage: window.__pci.state.stage,
        source: window.__pci.state.source === null,
      };
    `);
    ok('对话框已关闭', cancelled.dialogGone);
    ok('取消后未载入点云', cancelled.source && cancelled.stage === 'empty',
      `stage=${cancelled.stage}`);

    /* ───────── 6. 选到非数值列时拦截确认（避免静默空点云） ───────── */
    section('6. 选择非数值列时拦截（避免空点云）');
    await openDialog(cdp, csvFile);
    await cdp.eval(`
      const b = document.querySelector('.modal-backdrop');
      const sels = b.querySelectorAll('.modal-cols .select');
      sels[0].value = '0';                       // 第 1 列 name 全为非数值
      sels[0].dispatchEvent(new Event('change', { bubbles: true }));
    `);
    const nameOpt = await cdp.eval(`
      const b = document.querySelector('.modal-backdrop');
      const sels = b.querySelectorAll('.modal-cols .select');
      return sels[0].options[0] ? sels[0].options[0].textContent : '';
    `);
    ok('非数值列在选项中被标记', /⚠/.test(nameOpt || ''), (nameOpt || '').slice(0, 48));
    await cdp.eval(`document.querySelector('.modal-foot .btn-primary').click();`);
    await sleep(400);
    const blocked = await cdp.eval(`
      const b = document.querySelector('.modal-backdrop');
      const err = b ? b.querySelector('.modal-err') : null;
      return {
        stillOpen: !!b,
        errVisible: err ? !err.hidden : false,
        errText: err ? (err.textContent || '') : '',
        stage: window.__pci.state.stage,
      };
    `);
    ok('选非数值列时确认被拦截', blocked.stillOpen && blocked.errVisible, (blocked.errText || '').slice(0, 50));
    ok('拦截提示指出非数值列', /数值/.test(blocked.errText || ''), (blocked.errText || '').slice(0, 50));
    ok('拦截后未载入点云', blocked.stage !== 'ready', `stage=${blocked.stage}`);
    // 恢复有效选择并载入，使页面回到干净状态
    await cdp.eval(`
      const b = document.querySelector('.modal-backdrop');
      const sels = b.querySelectorAll('.modal-cols .select');
      sels[0].value = '1'; sels[0].dispatchEvent(new Event('change', { bubbles: true }));
    `);
    await cdp.eval(`document.querySelector('.modal-foot .btn-primary').click();`);
    await waitReady(cdp);
    ok('恢复有效选择后可正常载入', true);

    /* ───────── 7. 选中列各自有值但从不共行 → 预测 0 有效点，拦截 ───────── */
    section('7. 坐标列错位（各列有值但不共行）拦截');
    await openDialog(cdp, globalThis.__MISALIGN);
    const pred = await cdp.eval(`
      const b = document.querySelector('.modal-backdrop');
      return b ? (b.querySelector('.modal-pred')?.textContent || '') : '';
    `);
    ok('预览显示预计有效点 0/3', /0 \/ 3/.test(pred || ''), (pred || '').slice(0, 40));
    await cdp.eval(`document.querySelector('.modal-foot .btn-primary').click();`);
    await sleep(400);
    const blocked2 = await cdp.eval(`
      const b = document.querySelector('.modal-backdrop');
      const err = b ? b.querySelector('.modal-err') : null;
      return {
        stillOpen: !!b,
        errVisible: err ? !err.hidden : false,
        errText: err ? (err.textContent || '') : '',
        stage: window.__pci.state.stage,
      };
    `);
    ok('错位选择确认被拦截', blocked2.stillOpen && blocked2.errVisible, (blocked2.errText || '').slice(0, 50));
    ok('拦截提示指出空点云', /空点云|同时包含有效数值/.test(blocked2.errText || ''), (blocked2.errText || '').slice(0, 50));
    ok('拦截后未载入点云', blocked2.stage !== 'ready', `stage=${blocked2.stage}`);
    await cdp.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`);
    await sleep(400);
    ok('已关闭对话框', !(await cdp.eval(`return !!document.querySelector('.modal-backdrop');`)));
  } finally {
    console.log(`\n${'═'.repeat(52)}`);
    console.log(`  对话框冒烟：${checks - failures}/${checks} 通过` + (failures ? `，${failures} 项失败` : '，全部通过'));
    console.log('═'.repeat(52));
    try { await cdp?.send('Browser.close'); } catch { /* ignore */ }
    chrome.kill('SIGKILL');
    await sleep(400);
    try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(globalThis.__PROBE_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\n对话框冒烟失败：', err.message);
  process.exit(1);
});
