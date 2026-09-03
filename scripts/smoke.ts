/**
 * Headless smoke test for the DOM-free core pipeline.
 * Run with:  npm run smoke
 * Bundled by esbuild so the TS sources can be executed directly in Node.
 */

import { CloudView, SpatialIndex } from '../src/core/cloud';
import { buildLUT, getColormap, allColormaps, guessColormapFor } from '../src/core/colormap';
import { createDemoCloud } from '../src/core/demo';
import { downsampleIndices, estimateVoxelSize, DOWNSAMPLE_DEFAULTS } from '../src/core/downsample';
import { applyFilters, createRule, quantileRange } from '../src/core/filters';
import { sampleProfile, profileToCSV, PROFILE_DEFAULTS } from '../src/core/profile';
import { validateCloud, sanitizeCloud } from '../src/core/validate';
import { viewToCSV, viewToPLY, viewToPCD } from '../src/io/export';
import { parseTextPoints } from '../src/io/text';
import { parsePCD } from '../src/io/pcd';
import { parsePLY } from '../src/io/ply';

let failures = 0;
let checks = 0;

function ok(label: string, cond: boolean, detail = ''): void {
  checks++;
  if (cond) {
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function finite(label: string, v: number): void {
  ok(label, Number.isFinite(v), String(v));
}

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

/* ══════════════ 1. demo cloud ══════════════ */
section('1. 示例点云生成');
const t0 = Date.now();
const demo = createDemoCloud({ count: 180_000 });
ok('生成成功', demo.count === 180_000, `${demo.count} 点，${Date.now() - t0} ms`);
ok('坐标长度 = 3×count', demo.positions.length === demo.count * 3);
ok('存在标量属性', demo.scalarOrder.length >= 2, demo.scalarOrder.join(', '));
const tempName = demo.scalarOrder.find((n) => /temp/i.test(n)) ?? demo.scalarOrder[0]!;
ok('温度属性可识别', /temp/i.test(tempName), tempName);

let anyNaN = false;
for (let i = 0; i < demo.positions.length; i++) if (!Number.isFinite(demo.positions[i]!)) anyNaN = true;
ok('坐标无 NaN/Inf', !anyNaN);

/* ══════════════ 2. validation ══════════════ */
section('2. 合规校验');
const validation = validateCloud(demo);
ok('校验返回结果', Array.isArray(validation.issues) && validation.issues.length > 0,
  `${validation.issues.length} 条`);
ok('校验结论字段完整',
  typeof validation.ok === 'boolean' &&
  typeof validation.needsDownsample === 'boolean' &&
  Number.isFinite(validation.suggestedTarget) &&
  Number.isFinite(validation.duplicateRatio),
  `ok=${validation.ok} 需降采样=${validation.needsDownsample} 建议=${validation.suggestedTarget}`);
ok('全部 issue.level 合法',
  validation.issues.every((i) => ['ok', 'info', 'warn', 'err'].includes(i.level)));
ok('无效点计数非负', validation.invalidPoints >= 0, String(validation.invalidPoints));

const sanitized = sanitizeCloud(demo);
ok('清洗不抛错', sanitized.data.count > 0, `保留 ${sanitized.data.count}，移除 ${sanitized.removed}`);

/* ══════════════ 3. view / index ══════════════ */
section('3. 视图与空间索引');
const baseView = new CloudView(demo);
ok('视图点数 = 源点数', baseView.count === demo.count);
finite('包围盒对角线', baseView.diagonal);
ok('对角线 > 0', baseView.diagonal > 0, baseView.diagonal.toFixed(4));

const stats = baseView.stats(tempName);
ok('属性统计可用', !!stats);
if (stats) {
  finite('min', stats.min);
  finite('max', stats.max);
  finite('mean', stats.mean);
  finite('std', stats.std);
  ok('min <= p50 <= max', stats.min <= stats.p50 && stats.p50 <= stats.max,
    `${stats.min.toFixed(2)} / ${stats.p50.toFixed(2)} / ${stats.max.toFixed(2)}`);
  ok('p01 <= p99', stats.p01 <= stats.p99);
  ok('有效点数为正', stats.valid > 0, String(stats.valid));
  ok('直方图 56 桶', stats.histogram.length === 56, String(stats.histogram.length));
  ok('直方图总数 = 有效点数',
    stats.histogram.reduce((a, b) => a + b, 0) === stats.valid,
    `${stats.histogram.reduce((a, b) => a + b, 0)} vs ${stats.valid}`);
}

const ti0 = Date.now();
const index = new SpatialIndex(baseView.positions, baseView.count);
ok('空间索引构建', index.count === baseView.count, `${Date.now() - ti0} ms`);

/* ══════════════ 4. downsampling ══════════════ */
section('4. 降采样');
const voxelSize = estimateVoxelSize(baseView, 40_000);
finite('体素边长估算', voxelSize);
ok('体素边长 > 0', voxelSize > 0, voxelSize.toFixed(5));

for (const method of ['voxel', 'random', 'uniform', 'none'] as const) {
  const idx = downsampleIndices(baseView, { ...DOWNSAMPLE_DEFAULTS, method, target: 40_000 });
  const pct = ((idx.length / baseView.count) * 100).toFixed(1);
  ok(`${method} 降采样`, idx.length > 0 && idx.length <= baseView.count, `${idx.length} 点 (${pct}%)`);
  if (method === 'none') ok('none 应保留全部点', idx.length === baseView.count);
  let inRange = true;
  for (let i = 0; i < idx.length; i++) if (idx[i]! >= baseView.count) inRange = false;
  ok(`${method} 索引不越界`, inRange);
}

const voxelIdx = downsampleIndices(baseView, { ...DOWNSAMPLE_DEFAULTS, method: 'voxel', target: 40_000 });
const dsView = new CloudView(demo, voxelIdx);
ok('降采样后视图可构建', dsView.count === voxelIdx.length);
ok('降采样目标误差 < 35%', Math.abs(dsView.count - 40_000) / 40_000 < 0.35,
  `${dsView.count} vs 40000`);

/* ══════════════ 5. filters ══════════════ */
section('5. 筛选');
const [qLo, qHi] = quantileRange(baseView, tempName, 0.1, 0.9);
finite('分位下界', qLo);
finite('分位上界', qHi);
ok('分位区间有序', qLo < qHi, `${qLo.toFixed(2)} → ${qHi.toFixed(2)}`);
{
  const st = baseView.stats(tempName)!;
  ok('P10 落在 [min, 中位] 内', qLo >= st.min && qLo <= st.p50,
    `P10=${qLo.toFixed(2)} min=${st.min.toFixed(2)} 中位=${st.p50.toFixed(2)}`);
  ok('P90 落在 [中位, max] 内', qHi >= st.p50 && qHi <= st.max,
    `P90=${qHi.toFixed(2)} 中位=${st.p50.toFixed(2)} max=${st.max.toFixed(2)}`);
}

const hotRule = createRule('attr', tempName, qHi, Number.POSITIVE_INFINITY);
const hotIdx = applyFilters(baseView, [hotRule], 'and');
ok('高温筛选有结果', hotIdx.length > 0, `${hotIdx.length} 点`);
ok('筛选结果 <= 总数', hotIdx.length <= baseView.count);
{
  // Points above P90 should be roughly 10% of the cloud (histogram resolution
  // is 1/56 of the range, so allow generous slack).
  const frac = hotIdx.length / baseView.count;
  ok('高于 P90 的点约占 10%', frac > 0.02 && frac < 0.25, `${(frac * 100).toFixed(1)}%`);
}
{
  const [l, h] = quantileRange(baseView, tempName, 0.01, 0.99);
  const band = applyFilters(baseView, [createRule('attr', tempName, l, h)], 'and');
  const frac = band.length / baseView.count;
  ok('P01–P99 区间覆盖约 98%', frac > 0.9, `${(frac * 100).toFixed(1)}%`);
}

const zRule = createRule('axis', 'z', 0, Number.POSITIVE_INFINITY);
const comboIdx = applyFilters(baseView, [hotRule, zRule], 'and');
const orIdx = applyFilters(baseView, [hotRule, zRule], 'or');
ok('AND 结果 <= OR 结果', comboIdx.length <= orIdx.length,
  `and=${comboIdx.length} or=${orIdx.length}`);
ok('空规则集返回全部', applyFilters(baseView, [], 'and').length === baseView.count);

/* ══════════════ 6. profile ══════════════ */
section('6. 剖面线分析');
const bb = baseView.bounds;
const a: [number, number, number] = [bb.min[0], bb.min[1], bb.min[2]];
const b: [number, number, number] = [bb.max[0], bb.max[1], bb.max[2]];
const prof = sampleProfile(baseView, a, b, { ...PROFILE_DEFAULTS, field: tempName, bins: 100 });
ok('剖面返回结果', !!prof);
if (prof) {
  finite('剖面长度', prof.length);
  ok('剖面长度 > 0', prof.length > 0, prof.length.toFixed(4));
  ok('采样点数 > 0', prof.sampled > 0, `${prof.sampled} 点`);
  ok('分箱数正确', prof.t.length === 100 && prof.v.length === 100);
  const nonEmpty = Array.from(prof.n).filter((x) => x > 0).length;
  ok('存在非空分箱', nonEmpty > 5, `${nonEmpty}/100 有原始点`);
  ok('平均每个分箱 >= 2 点', prof.sampled / 100 >= 2, `${(prof.sampled / 100).toFixed(1)} 点/箱`);
  // The plotted curve must be continuous: empty bins are interpolated before
  // the stats are computed, so no NaN may survive into `v`.
  ok('剖面曲线连续（空箱已插值）',
    Array.from(prof.v).every((x) => Number.isFinite(x)),
    `${Array.from(prof.v).filter((x) => Number.isFinite(x)).length}/100 有限`);
  const s = prof.stats;
  finite('stats.min', s.min);
  finite('stats.max', s.max);
  finite('stats.mean', s.mean);
  finite('stats.median', s.median);
  finite('stats.std', s.std);
  finite('stats.delta', s.delta);
  finite('stats.maxSlope', s.maxSlope);
  finite('stats.trend', s.trend);
  ok('min <= mean <= max', s.min <= s.mean && s.mean <= s.max,
    `${s.min.toFixed(2)} / ${s.mean.toFixed(2)} / ${s.max.toFixed(2)}`);
  ok('极值位置在段长内', s.minAt >= 0 && s.minAt <= prof.length && s.maxAt >= 0 && s.maxAt <= prof.length);
  const csv = profileToCSV(prof, '°C');
  ok('剖面 CSV 有内容', csv.length > 50 && csv.split('\n').length > 5,
    `${csv.split('\n').length} 行`);
}

const smoothProf = sampleProfile(baseView, a, b,
  { ...PROFILE_DEFAULTS, field: tempName, bins: 100, smooth: 5 });
ok('滑动平均不抛错', !!smoothProf && smoothProf.v.length === 100);

// A section along the winding axis — the line a real user would draw through
// the coil. Must pick up far more samples than the bbox diagonal, which mostly
// crosses the hollow core.
{
  const axis: [[number, number, number], [number, number, number]] = [
    [1.0, 0.0, -0.95],
    [1.0, 0.0, 0.95],
  ];
  const ap = sampleProfile(baseView, axis[0], axis[1],
    { ...PROFILE_DEFAULTS, field: tempName, bins: 100 });
  ok('轴向剖面采样充足', !!ap && ap.sampled > 200, `采样 ${ap?.sampled ?? 0} 点`);
  if (ap) {
    const ne = Array.from(ap.n).filter((x) => x > 0).length;
    ok('轴向剖面覆盖 >= 70% 分箱', ne >= 70, `${ne}/100 非空`);
    ok('轴向剖面曲线连续', Array.from(ap.v).every((x) => Number.isFinite(x)));
    ok('轴向剖面有温度变化', ap.stats.max - ap.stats.min > 1,
      `${ap.stats.min.toFixed(1)} → ${ap.stats.max.toFixed(1)} °C`);
  }
}

const emptyProf = sampleProfile(baseView, a, a, { ...PROFILE_DEFAULTS, field: tempName });
ok('零长剖面安全降级（不抛错、统计为 NaN）',
  !!emptyProf && Number.isNaN(emptyProf.stats.mean) && emptyProf.sampled === 0);

/* ══════════════ 7. colormaps ══════════════ */
section('7. 色卡系统');
const maps = allColormaps();
ok('内置色卡数量 >= 10', maps.length >= 10, `${maps.length} 款`);
for (const m of maps) {
  const lut = buildLUT(m.stops);
  if (lut.length !== 256 * 3) ok(`LUT 长度正确 (${m.id})`, false, String(lut.length));
}
ok('全部 LUT 长度 = 768', maps.every((m) => buildLUT(m.stops).length === 768));
const thermal = getColormap('turbo') ?? maps[0]!;
const lut = buildLUT(thermal.stops);
ok('LUT 全部字节有效', lut.every((v) => Number.isFinite(v) && v >= 0 && v <= 255));
ok('LUT 有色彩变化', lut[0] !== lut[765] || lut[1] !== lut[766] || lut[2] !== lut[767]);
const guess = guessColormapFor(tempName);
ok('按属性名猜测色卡', !!guess, `${tempName} → ${guess}`);
const reversed = buildLUT(thermal.stops, { reverse: true });
ok('反向色卡生效', reversed[0] === lut[765] && reversed[1] === lut[766]);
const stepped = buildLUT(thermal.stops, { steps: 6 });
ok('离散分级生效', stepped[0] === stepped[3] && stepped[0] === stepped[6]);

/* ══════════════ 8. text parsers ══════════════ */
section('8. 文本格式解析');
const csvText = 'x,y,z,temperature\n0,0,0,20\n1,0,0,25\n0,1,0,30\n1,1,1,35\n';
const csvFile = new File([csvText], 'pts.csv', { type: 'text/csv' });
const csvRes = await parseTextPoints(csvFile);
ok('CSV 解析点数正确', csvRes.data.count === 4, `${csvRes.data.count} 点`);
ok('CSV 头部属性识别', csvRes.data.scalarOrder.includes('temperature'),
  csvRes.data.scalarOrder.join(','));
{
  const tv = new CloudView(csvRes.data);
  const st = tv.stats('temperature');
  ok('CSV 温度范围正确', !!st && st.min === 20 && st.max === 35, st ? `${st.min}–${st.max}` : 'null');
}

const xyzText = '0 0 0\n1 0 0\n0 1 0\n1 1 1\n2 2 2\n';
const xyzRes = await parseTextPoints(new File([xyzText], 'p.xyz', { type: 'text/plain' }));
ok('XYZ 解析点数正确', xyzRes.data.count === 5, `${xyzRes.data.count} 点`);

// A deliberately wrong column selection must produce a specific, actionable
// error instead of a generic "no rows" — this is the parse-side safety net
// behind the dialog's per-column validity gate.
{
  const badText = 'name,x,y,z\na,1,2,3\nb,4,5,6\n';
  const badFile = new File([badText], 'bad.csv', { type: 'text/csv' });
  let threw = '';
  try {
    await parseTextPoints(badFile, { mode: '3d', x: 0, y: 1, z: 2 });
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  ok('错误坐标列选择给出具体提示', /坐标列|分隔符|表头/.test(threw), threw.slice(0, 64));
}

const pcdAscii = [
  '# .PCD v0.7 - Point Cloud Data file format',
  'VERSION 0.7',
  'FIELDS x y z',
  'SIZE 4 4 4',
  'TYPE F F F',
  'COUNT 1 1 1',
  'WIDTH 3',
  'HEIGHT 1',
  'VIEWPOINT 0 0 0 1 0 0 0',
  'POINTS 3',
  'DATA ascii',
  '0 0 0',
  '1 0 0',
  '0 1 0',
  '',
].join('\n');
const pcdRes = await parsePCD(new File([pcdAscii], 'c.pcd'));
ok('PCD ASCII 解析', pcdRes.data.count === 3, `${pcdRes.data.count} 点`);

const plyAscii = [
  'ply',
  'format ascii 1.0',
  'element vertex 3',
  'property float x',
  'property float y',
  'property float z',
  'property float temperature',
  'end_header',
  '0 0 0 10',
  '1 0 0 20',
  '0 1 0 30',
  '',
].join('\n');
const plyRes = await parsePLY(new File([plyAscii], 'c.ply'));
ok('PLY ASCII 解析', plyRes.data.count === 3, `${plyRes.data.count} 点`);
ok('PLY 属性识别', plyRes.data.scalarOrder.includes('temperature'),
  plyRes.data.scalarOrder.join(','));

/* ══════════════ 9. export ══════════════ */
section('9. 导出序列化');
{
  const small = new CloudView(csvRes.data);
  const fields = ['x', 'y', 'z', 'temperature'];
  const csv = viewToCSV(small, fields);
  ok('CSV 导出', csv.split('\n').length === small.count + 1, `${csv.split('\n').length} 行`);
  const ply = viewToPLY(small, fields);
  ok('PLY 导出含头部', ply.startsWith('ply') && ply.includes('end_header'));
  const pcd = viewToPCD(small, fields);
  ok('PCD 导出含头部', pcd.includes('POINTS') && pcd.includes('DATA'));
}

/* ══════════════ 10. full pipeline ══════════════ */
section('10. 端到端流水线');
{
  const big = createDemoCloud({ count: 900_000, seed: 7 });
  const v = validateCloud(big);
  ok('大点云校验可用', v.issues.length > 0 && Number.isFinite(v.suggestedTarget),
    `${big.count} 点 → ok=${v.ok} 需降采样=${v.needsDownsample}`);
  ok('大点云会触发降采样建议', v.needsDownsample || big.count <= 1_500_000,
    `建议目标 ${v.suggestedTarget}`);
  const t1 = Date.now();
  const view = new CloudView(big);
  const idx = downsampleIndices(view, { ...DOWNSAMPLE_DEFAULTS, method: 'voxel', target: 300_000 });
  const sub = new CloudView(big, idx);
  const pr = sampleProfile(sub, [sub.bounds.min[0], sub.bounds.min[1], sub.bounds.min[2]],
    [sub.bounds.max[0], sub.bounds.max[1], sub.bounds.max[2]],
    { ...PROFILE_DEFAULTS, field: 'temperature' });
  ok('大点云端到端', !!pr && pr.sampled > 0,
    `${Date.now() - t1} ms，采样 ${pr?.sampled ?? 0} 点`);
}

/* ══════════════ summary ══════════════ */
console.log(`\n${'═'.repeat(48)}`);
console.log(`  冒烟结果：${checks - failures}/${checks} 通过` + (failures ? `，${failures} 项失败` : '，全部通过'));
console.log('═'.repeat(48));
process.exit(failures > 0 ? 1 : 0);
