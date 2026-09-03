/**
 * Browser smoke test driven straight over the Chrome DevTools Protocol.
 * No Playwright/Puppeteer dependency — uses the built-in WebSocket client.
 *
 *   node scripts/browser-smoke.mjs [url]
 *
 * Verifies: boot without console errors, UI wiring, demo load, real WebGL
 * rendering (non-empty framebuffer), profile analysis, hover readout and
 * filter round-trip.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME =
  process.env.CHROME_PATH ||
  'C:/Users/admin/.agent-browser/browsers/chrome-152.0.7977.75/chrome.exe';
const TARGET = process.argv[2] || process.env.SMOKE_URL || 'http://localhost:4173/';
const PORT = Number(process.env.CDP_PORT || 9333);

// Generate a small PLY file with a scalar attribute for the upload test.
const probeDir = mkdtempSync(path.join(tmpdir(), 'pci-up-'));
const uploadFile = path.join(probeDir, 'smoke-sample.ply');
{
  let s = 'seed';
  const rng = () => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    s += 'x'; h = (h ^ (h >>> 13)) >>> 0; return (h % 1000) / 1000;
  };
  const n = 500;
  const lines = ['ply', 'format ascii 1.0', `element vertex ${n}`,
    'property float x', 'property float y', 'property float z', 'property float temperature',
    'end_header'];
  for (let i = 0; i < n; i++) {
    const x = (rng() - 0.5) * 4, y = (rng() - 0.5) * 4, z = (rng() - 0.5) * 4;
    const t = 20 + (x * x + y * y + z * z) * 8;
    lines.push(`${x.toFixed(4)} ${y.toFixed(4)} ${z.toFixed(4)} ${t.toFixed(3)}`);
  }
  writeFileSync(uploadFile, lines.join('\n') + '\n');
}

// Generate a valid LAS 1.2 file with a temperature Extra Bytes record.
const lasFile = path.join(probeDir, 'smoke-sample.las');
{
  const n = 400;
  const scale = 0.01, ox = 100, oy = 200, oz = -50;
  const pts = [];
  let s = 'las';
  const rng = () => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    s += 'y'; h = (h ^ (h >>> 13)) >>> 0; return (h % 1000) / 1000;
  };
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const wx = ox + (rng() - 0.5) * 30;
    const wy = oy + (rng() - 0.5) * 30;
    const wz = oz + (rng() - 0.5) * 15;
    const temp = 15 + (wx - ox) + (wy - oy);
    pts.push({ wx, wy, wz, temp });
    minX = Math.min(minX, wx); minY = Math.min(minY, wy); minZ = Math.min(minZ, wz);
    maxX = Math.max(maxX, wx); maxY = Math.max(maxY, wy); maxZ = Math.max(maxZ, wz);
  }
  const headerSize = 227;
  const numVLR = 1;
  const pointFormat = 0;
  const extraLen = 4; // float temperature
  const pointLength = 20 + extraLen;
  const vlrRecLen = 192;
  const vlrTotal = 54 + vlrRecLen;
  const offsetToPoints = headerSize + vlrTotal;
  const buf = new ArrayBuffer(offsetToPoints + n * pointLength);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const w8 = (off, str) => { for (let i = 0; i < str.length; i++) u8[off + i] = str.charCodeAt(i); };

  w8(0, 'LASF');
  dv.setUint8(24, 1);            // version major
  dv.setUint8(25, 2);            // version minor
  dv.setUint16(94, headerSize, true);
  dv.setUint32(96, offsetToPoints, true);
  dv.setUint32(100, numVLR, true);
  dv.setUint8(104, pointFormat);
  dv.setUint16(105, pointLength, true);
  dv.setUint32(107, n, true);    // legacy point count
  dv.setFloat64(131, scale, true);
  dv.setFloat64(139, scale, true);
  dv.setFloat64(147, scale, true);
  dv.setFloat64(155, ox, true);
  dv.setFloat64(163, oy, true);
  dv.setFloat64(171, oz, true);
  dv.setFloat64(179, maxX, true);
  dv.setFloat64(187, minX, true);
  dv.setFloat64(195, maxY, true);
  dv.setFloat64(203, minY, true);
  dv.setFloat64(211, maxZ, true);
  dv.setFloat64(219, minZ, true);
  w8(26, 'pointcloud-inspector smoke'.padEnd(32, ' ').slice(0, 32));

  // VLR (LASF_Spec, record id 4) describing the temperature Extra Bytes.
  const vlrBase = headerSize;
  dv.setUint16(vlrBase + 18, 4, true);          // record id
  dv.setUint16(vlrBase + 20, vlrRecLen, true);  // record length after header
  w8(vlrBase + 2, 'LASF_Spec'.padEnd(16, ' ').slice(0, 16));
  const e = vlrBase + 54;                        // extra byte record data
  dv.setUint8(e + 2, 9);                         // data type 9 = float
  w8(e + 4, 'temperature'.padEnd(32, ' ').slice(0, 32));
  dv.setFloat64(e + 40, 0, true);               // no-data
  w8(e + 160, 'Temperature (C)'.padEnd(32, ' ').slice(0, 32));

  // Point records: standard 20 bytes + 4-byte float temperature.
  for (let i = 0; i < n; i++) {
    const p = offsetToPoints + i * pointLength;
    const ix = Math.round((pts[i].wx - ox) / scale);
    const iy = Math.round((pts[i].wy - oy) / scale);
    const iz = Math.round((pts[i].wz - oz) / scale);
    dv.setInt32(p, ix, true);
    dv.setInt32(p + 4, iy, true);
    dv.setInt32(p + 8, iz, true);
    dv.setUint16(p + 12, Math.floor(rng() * 4000), true);
    dv.setUint8(p + 14, 0x19);                   // return number 1, 1 return
    dv.setUint8(p + 15, 1);                      // classification
    dv.setInt8(p + 16, 0);                       // scan angle
    dv.setUint8(p + 17, 0);                      // user data
    dv.setUint16(p + 18, 1, true);               // point source id
    dv.setFloat32(p + 20, pts[i].temp, true);    // extra: temperature
  }
  // Strip trailing zeros so the .las file is a clean binary blob.
  writeFileSync(lasFile, Buffer.from(buf));
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

// Wait until the app has booted and mounted its panels. Vite preview serves
// the ~630 KB main module lazily, so a fixed sleep after navigate can fire
// before the module executes (cold first request). Poll instead.
async function waitForApp(cdp, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await cdp
      .eval(`
        const a = window.__pci;
        const left = document.getElementById('leftTabs');
        const right = document.getElementById('rightTabs');
        return {
          app: typeof a === 'object' && a !== null,
          left: left ? left.children.length : 0,
          right: right ? right.children.length : 0,
        };
      `)
      .catch(() => ({ app: false, left: 0, right: 0 }));
    if (ready.app && ready.left >= 4 && ready.right >= 5) return;
    await sleep(250);
  }
  throw new Error('应用启动超时（window.__pci / 面板未挂载）');
}

/* ══════════ CDP client ══════════ */

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

  on(fn) {
    this.listeners.push(fn);
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
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  throw new Error('Chrome DevTools 端口未就绪');
}

async function main() {
  const profileDir = mkdtempSync(path.join(tmpdir(), 'pci-smoke-'));
  console.log(`Chrome: ${CHROME}`);
  console.log(`Target: ${TARGET}`);

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--enable-unsafe-swiftshader',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--hide-scrollbars',
      '--mute-audio',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profileDir}`,
      '--window-size=1600,1000',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  let cdp;
  const consoleErrors = [];
  const pageErrors = [];

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
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');

    cdp.on((msg) => {
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        pageErrors.push(d.exception?.description || d.text || 'unknown exception');
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        consoleErrors.push(
          msg.params.args.map((a) => a.description ?? a.value ?? '').join(' ')
        );
      }
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        consoleErrors.push(msg.params.entry.text);
      }
    });

    /* ══════════ 1. boot ══════════ */
    section('1. 启动与初始化');
    await cdp.send('Page.navigate', { url: TARGET });
    await waitForApp(cdp);

    const boot = await cdp.eval(`
      return {
        hasApp: typeof window.__pci === 'object' && window.__pci !== null,
        leftTabs: document.getElementById('leftTabs').children.length,
        rightTabs: document.getElementById('rightTabs').children.length,
        dockTabs: document.getElementById('dockTabs').children.length,
        leftBody: document.getElementById('leftBody').children.length,
        rightBody: document.getElementById('rightBody').children.length,
        dockBody: document.getElementById('dockBody').children.length,
        topbar: document.getElementById('topbarActions').children.length,
        status: document.getElementById('statusbar').textContent.trim().length,
        welcomeVisible: !document.getElementById('welcome').hidden,
        modeBtns: document.getElementById('modeSwitch').children.length,
        formats: document.getElementById('welcomeFormats').children.length,
      };
    `);
    ok('App 实例已创建', boot.hasApp);
    ok('左侧设置面板已挂载', boot.leftTabs >= 4 && boot.leftBody > 0,
      `${boot.leftTabs} 个 tab`);
    ok('右侧功能面板已挂载', boot.rightTabs >= 5 && boot.rightBody > 0,
      `${boot.rightTabs} 个 tab`);
    ok('底部数据面板已挂载', boot.dockTabs >= 5 && boot.dockBody > 0,
      `${boot.dockTabs} 个 tab`);
    ok('顶栏操作按钮已挂载', boot.topbar >= 4, `${boot.topbar} 个`);
    ok('状态栏有内容', boot.status > 0);
    ok('欢迎页可见', boot.welcomeVisible);
    ok('交互模式切换已挂载', boot.modeBtns === 2, `${boot.modeBtns} 个模式`);
    ok('格式标签已渲染', boot.formats >= 8, `${boot.formats} 种格式`);
    ok('启动无 JS 异常', pageErrors.length === 0, pageErrors[0] || '');
    ok('启动无 console 错误', consoleErrors.length === 0, consoleErrors[0] || '');

    /* ══════════ 2. load demo ══════════ */
    section('2. 载入示例点云');
    await cdp.eval(`document.getElementById('welcomeDemo').click();`);
    for (let i = 0; i < 60; i++) {
      const stage = await cdp.eval(`return window.__pci.state.stage;`);
      if (stage === 'ready') break;
      await sleep(500);
    }
    const demo = await cdp.eval(`
      const s = window.__pci.state;
      return {
        stage: s.stage,
        source: s.source ? s.source.count : 0,
        view: s.view ? s.view.count : 0,
        attrs: s.source ? s.source.scalarOrder : [],
        colorMode: s.render.colorMode,
        attribute: s.render.attribute,
        welcomeHidden: document.getElementById('welcome').hidden,
        statusText: document.getElementById('statusbar').textContent.replace(/\\s+/g,' ').trim().slice(0, 200),
        validation: s.validation ? s.validation.issues.length : 0,
      };
    `);
    ok('进入 ready 状态', demo.stage === 'ready', demo.stage);
    ok('源点云已载入', demo.source > 0, `${demo.source.toLocaleString()} 点`);
    ok('渲染视图已构建', demo.view > 0, `${demo.view.toLocaleString()} 点`);
    ok('识别出标量属性', demo.attrs.length >= 2, demo.attrs.join(', '));
    ok('自动按属性着色', demo.colorMode === 'attribute',
      `${demo.colorMode} / ${demo.attribute}`);
    ok('欢迎页已隐藏', demo.welcomeHidden);
    ok('合规校验已运行', demo.validation > 0, `${demo.validation} 条结论`);
    console.log(`     状态栏: ${demo.statusText}`);

    /* ══════════ 3. WebGL rendering ══════════ */
    section('3. 三维渲染');
    const gl = await cdp.eval(`
      const c = document.getElementById('gl');
      const ctx = c.getContext('webgl2') || c.getContext('webgl');
      const t = document.createElement('canvas');
      t.width = 96; t.height = 60;
      const g = t.getContext('2d');
      g.drawImage(c, 0, 0, 96, 60);
      const d = g.getImageData(0, 0, 96, 60).data;
      const seen = new Set();
      let lit = 0;
      for (let i = 0; i < d.length; i += 4) {
        seen.add((d[i] >> 3) + ',' + (d[i+1] >> 3) + ',' + (d[i+2] >> 3));
        // background is the dark app colour; anything notably brighter is a point
        if (d[i] + d[i+1] + d[i+2] > 150) lit++;
      }
      return {
        hasCtx: !!ctx,
        w: c.width, h: c.height,
        colors: seen.size,
        litFrac: lit / (96 * 60),
        renderer: window.__pci.viewer.renderer ? window.__pci.viewer.renderer.info.render.calls : -1,
      };
    `);
    ok('WebGL 上下文存在', gl.hasCtx);
    ok('画布尺寸有效', gl.w > 0 && gl.h > 0, `${gl.w}×${gl.h}`);
    ok('画面有内容（非纯背景）', gl.colors > 20, `${gl.colors} 种颜色`);
    ok('点云已绘制到画面', gl.litFrac > 0.005, `亮像素占比 ${(gl.litFrac * 100).toFixed(1)}%`);

    /* ══════════ 4. hover readout (real mouse) ══════════ */
    section('4. 悬停拾取（真实鼠标）');
    // Project a few view points to screen space so the synthetic mouse events
    // actually land on geometry.
    const pts = await cdp.eval(`
      const app = window.__pci;
      const v = app.state.view;
      const cam = app.viewer.camera;
      cam.updateMatrixWorld();
      const m = cam.matrixWorldInverse.elements;
      const pj = cam.projectionMatrix.elements;
      const rect = document.getElementById('gl').getBoundingClientRect();
      const out = [];
      for (let k = 0; k < v.count && out.length < 12; k += Math.max(1, Math.floor(v.count / 400))) {
        const p = v.positionAt(k);
        const cx = m[0]*p[0] + m[4]*p[1] + m[8]*p[2]  + m[12];
        const cy = m[1]*p[0] + m[5]*p[1] + m[9]*p[2]  + m[13];
        const cz = m[2]*p[0] + m[6]*p[1] + m[10]*p[2] + m[14];
        if (cz > -1e-4) continue;               // behind / on the camera plane
        const w = -cz;
        const ndcX = (pj[0]*cx + pj[8]*cz + pj[12]) / w;
        const ndcY = (pj[5]*cy + pj[9]*cz + pj[13]) / w;
        if (Math.abs(ndcX) > 0.85 || Math.abs(ndcY) > 0.85) continue;
        out.push({
          index: k,
          x: rect.left + (ndcX * 0.5 + 0.5) * rect.width,
          y: rect.top + (1 - (ndcY * 0.5 + 0.5)) * rect.height,
        });
      }
      return out;
    `);
    ok('可投影出屏幕坐标', pts.length > 0, `${pts.length} 个候选点`);

    let hovered = null;
    for (const p of pts.slice(0, 8)) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: p.x, y: p.y, button: 'none', buttons: 0,
      });
      await sleep(220);
      const h = await cdp.eval(`
        const app = window.__pci;
        return {
          has: !!app.hovered,
          viewIndex: app.hovered ? app.hovered.viewIndex : -1,
          cardHidden: document.getElementById('hoverCard').hidden,
          cardText: document.getElementById('hoverCard').textContent.trim().length,
          entryKeys: app.hovered ? app.hoverEntries(app.hovered.index).map(e => e.key) : [],
        };
      `);
      if (h.has) { hovered = h; break; }
    }
    ok('鼠标悬停拾取到点', !!hovered, hovered ? `视图索引 #${hovered.viewIndex}` : '未命中');
    if (hovered) {
      ok('悬停卡片已显示', !hovered.cardHidden && hovered.cardText > 0,
        `${hovered.cardText} 字符`);
      ok('悬停条目含坐标与属性',
        hovered.entryKeys.includes('X') && hovered.entryKeys.length >= 4,
        hovered.entryKeys.join(', '));
    }

    /* ══════════ 5. profile analysis (real clicks) ══════════ */
    section('5. 剖面线分析（真实点击取端点）');
    await cdp.eval(`window.__pci.setMode('measure');`);
    // Choose two endpoints that are far apart on screen.
    const pick2 = (() => {
      let best = [pts[0], pts[1] || pts[0]];
      let bestD = -1;
      for (const a of pts) for (const b of pts) {
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d > bestD) { bestD = d; best = [a, b]; }
      }
      return best;
    })();
    const clicked = [];
    for (const p of pick2) {
      if (clicked.length >= 2) break;
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1,
      });
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1,
      });
      await sleep(360);
      const diag = await cdp.eval(`
        const app = window.__pci;
        const c = document.getElementById('gl');
        const rect = c.getBoundingClientRect();
        return {
          a: !!app.state.measure.a,
          b: !!app.state.measure.b,
          downMoved: app.down ? app.down.moved : 'n/a',
          rectL: rect.left, rectT: rect.top,
          pickHere: !!app.viewer.pick(${p.x} - rect.left, ${p.y} - rect.top, 2),
        };
      `);
      const m = await cdp.eval(`const m = window.__pci.state.measure; return { a: !!m.a, b: !!m.b };`);
      console.log(`     click #${clicked.length + 1} @(${Math.round(p.x)},${Math.round(p.y)}) → a=${m.a} b=${m.b} pickHere=${diag.pickHere} downMoved=${diag.downMoved}`);
      if (m.a) clicked.push(p);
      if (m.a && m.b) { clicked.push(p); break; }
    }
    const measure = await cdp.eval(`
      const m = window.__pci.state.measure;
      const p = window.__pci.state.profile;
      return {
        a: !!m.a, b: !!m.b, field: m.field,
        hasProfile: !!p,
        sampled: p ? p.sampled : 0,
        length: p ? p.length : 0,
        bins: p ? p.t.length : 0,
        min: p ? p.stats.min : NaN,
        max: p ? p.stats.max : NaN,
        mean: p ? p.stats.mean : NaN,
        history: m.history ? m.history.length : 0,
      };
    `);
    ok('起点 A 已拾取', measure.a);
    ok('终点 B 已拾取', measure.b);
    ok('剖面自动计算', measure.hasProfile, `分析量 ${measure.field}`);
    ok('剖面采样到点', measure.sampled > 0, `${measure.sampled} 点`);
    ok('剖面长度正确', measure.length > 0, measure.length.toFixed(3));
    ok('分箱数正确', measure.bins > 0, `${measure.bins} 箱`);
    ok('统计量有限',
      Number.isFinite(measure.min) && Number.isFinite(measure.max) && Number.isFinite(measure.mean),
      `${measure.min?.toFixed(2)} / ${measure.mean?.toFixed(2)} / ${measure.max?.toFixed(2)}`);
    ok('剖面进入历史记录', measure.history > 0, `${measure.history} 条`);

    const chart = await cdp.eval(`
      const tabs = Array.from(document.getElementById('dockTabs').children);
      const t = tabs.find(x => x.textContent.includes('剖面曲线'));
      if (t) t.click();
      const cv = document.querySelector('#dockBody canvas');
      return { clicked: !!t, hasCanvas: !!cv, w: cv ? cv.width : 0, h: cv ? cv.height : 0 };
    `);
    ok('剖面曲线 tab 可切换', chart.clicked);
    ok('剖面图表已绘制', chart.hasCanvas && chart.w > 0 && chart.h > 0,
      `${chart.w}×${chart.h}`);
    await cdp.eval(`window.__pci.setMode('orbit');`);

    /* ══════════ 6. filters ══════════ */
    section('6. 筛选');
    const filt = await cdp.eval(`
      const app = window.__pci;
      const before = app.state.view.count;
      const stats = app.state.view.stats(app.state.render.attribute);
      app.addFilterRule(app.state.render.attribute);
      const rule = app.state.filters.rules[app.state.filters.rules.length - 1];
      app.updateFilterRule(rule.id, { min: stats.p50, max: stats.max });
      await new Promise(r => setTimeout(r, 700));
      const after = app.state.view.count;
      const kept = app.state.source.count ? after / app.state.source.count : 0;
      app.clearFilters();
      await new Promise(r => setTimeout(r, 700));
      const restored = app.state.view.count;
      return { before, after, restored, kept, rules: app.state.filters.rules.length };
    `);
    ok('筛选减少了点数', filt.after < filt.before,
      `${filt.before.toLocaleString()} → ${filt.after.toLocaleString()}`);
    ok('筛选保留合理比例', filt.kept > 0.05 && filt.kept < 0.95,
      `${(filt.kept * 100).toFixed(1)}%`);
    ok('清空筛选后恢复', filt.restored === filt.before && filt.rules === 0,
      `${filt.restored.toLocaleString()} 点`);

    /* ══════════ 7. downsample ══════════ */
    section('7. 降采样');
    const ds = await cdp.eval(`
      const app = window.__pci;
      const before = app.state.view.count;
      app.applyDownsample({ method: 'voxel', target: Math.floor(before / 4) });
      await new Promise(r => setTimeout(r, 900));
      const after = app.state.view.count;
      app.resetDownsample();
      await new Promise(r => setTimeout(r, 900));
      return { before, after, restored: app.state.view.count };
    `);
    ok('降采样生效', ds.after > 0 && ds.after < ds.before,
      `${ds.before.toLocaleString()} → ${ds.after.toLocaleString()}`);
    ok('还原降采样', ds.restored === ds.before, `${ds.restored.toLocaleString()} 点`);

    /* ══════════ 8. colormap ══════════ */
    section('8. 色卡与着色');
    const cm = await cdp.eval(`
      const app = window.__pci;
      const ids = ['viridis','turbo','thermal','terrain','inferno','coolwarm'];
      const applied = [];
      for (const id of ids) {
        app.setColormap(id);
        applied.push(app.state.render.colormapId === id ? id : ('MISS:' + id));
      }
      app.setRender({ colorMode: 'elevation' });
      const elev = app.state.render.colorMode;
      app.setRender({ colorMode: 'attribute' });
      return { applied, elev, lut: app.lut ? app.lut.length : 0 };
    `);
    ok('全部色卡可切换', cm.applied.every((x) => !x.startsWith('MISS')), cm.applied.join(', '));
    ok('高程着色模式可切换', cm.elev === 'elevation');
    ok('LUT 已烘焙', cm.lut === 768, `${cm.lut} 字节`);

    /* ══════════ 9. file upload ══════════ */
    section('9. 文件上传（真实 PLY）');
    // Reset to empty first so we load a fresh cloud.
    await cdp.eval(`if (window.__pci.closeCloud) window.__pci.closeCloud();`);
    await sleep(400);
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
    const q = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#fileInput' });
    await cdp.send('DOM.setFileInputFiles', { nodeId: q.nodeId, files: [uploadFile] });
    let uploaded = null;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      uploaded = await cdp.eval(`
        const app = window.__pci;
        return { stage: app.state.stage, count: app.state.source ? app.state.source.count : 0,
                 attrs: app.state.source ? app.state.source.scalarOrder : [],
                 format: app.state.fileInfo ? app.state.fileInfo.format : '' };
      `);
      if (uploaded.stage === 'ready') break;
    }
    ok('上传后进入 ready', uploaded.stage === 'ready', uploaded.stage);
    ok('上传点云已解析', uploaded.count > 0, `${uploaded.count} 点`);
    ok('格式嗅探为 PLY', uploaded.format === 'ply' || uploaded.format === 'PLY', uploaded.format);
    ok('上传文件属性识别', uploaded.attrs.includes('temperature'), uploaded.attrs.join(', '));

    /* ══════════ 9b. LAS upload (binary + extra bytes) ══════════ */
    section('9b. 文件上传（真实 LAS + 温度 Extra Bytes）');
    await cdp.eval(`if (window.__pci.closeCloud) window.__pci.closeCloud();`);
    await sleep(400);
    {
      const { root: r2 } = await cdp.send('DOM.getDocument', { depth: -1 });
      const q2 = await cdp.send('DOM.querySelector', { nodeId: r2.nodeId, selector: '#fileInput' });
      await cdp.send('DOM.setFileInputFiles', { nodeId: q2.nodeId, files: [lasFile] });
    }
    let las = null;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      las = await cdp.eval(`
        const app = window.__pci;
        return { stage: app.state.stage, count: app.state.source ? app.state.source.count : 0,
                 attrs: app.state.source ? app.state.source.scalarOrder : [],
                 format: app.state.fileInfo ? app.state.fileInfo.format : '',
                 tempRange: (() => { const v = app.state.view.stats('temperature');
                   return v ? [v.min, v.max] : null; })() };
      `);
      if (las.stage === 'ready') break;
    }
    ok('LAS 上传后进入 ready', las.stage === 'ready', las.stage);
    ok('LAS 点云已解析', las.count > 0, `${las.count} 点`);
    ok('格式嗅探为 LAS', (las.format || '').toUpperCase() === 'LAS', las.format);
    ok('LAS 温度 Extra Bytes 已读取', las.attrs.includes('temperature'),
      las.attrs.join(', '));
    if (las.tempRange) {
      ok('温度值已正确解码（非全零）',
        Number.isFinite(las.tempRange[0]) && las.tempRange[1] > las.tempRange[0],
        `${las.tempRange[0].toFixed(2)} → ${las.tempRange[1].toFixed(2)}`);
    }

    /* ══════════ 10. runtime health ══════════ */
    section('10. 运行时健康');
    // Filter out benign favicon / font network noise.
    const realErrors = consoleErrors.filter(
      (e) => !/favicon|fonts\.googleapis|fonts\.gstatic|ERR_INTERNET_DISCONNECTED|net::ERR_NAME/i.test(e)
    );
    ok('全流程无 JS 异常', pageErrors.length === 0,
      pageErrors.slice(0, 2).join(' | ') || '');
    ok('全流程无 console 错误', realErrors.length === 0,
      realErrors.slice(0, 2).join(' | ') || '');
  } finally {
    console.log(`\n${'═'.repeat(52)}`);
    console.log(`  浏览器冒烟：${checks - failures}/${checks} 通过` + (failures ? `，${failures} 项失败` : '，全部通过'));
    console.log('═'.repeat(52));
    if (pageErrors.length) console.log('\n异常:\n' + pageErrors.slice(0, 8).map((e) => '  ' + e.split('\n')[0]).join('\n'));
    if (consoleErrors.length) console.log('\n控制台错误:\n' + consoleErrors.slice(0, 8).map((e) => '  ' + e.slice(0, 300)).join('\n'));
    try { await cdp?.send('Browser.close'); } catch { /* ignore */ }
    chrome.kill('SIGKILL');
    await sleep(400);
    try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(probeDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\n浏览器冒烟失败：', err.message);
  process.exit(1);
});
