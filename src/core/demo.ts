/**
 * Synthetic demo cloud: a solenoid-style motor winding with a temperature
 * field (including a local hot spot), wrapped by a cooler stator shell.
 * Handy for exploring the tool without a file at hand.
 */

import { createCloud, type PointCloudData } from './cloud';
import { t, tMeta } from '../i18n';

export interface DemoOptions {
  /** Approximate number of points. */
  count: number;
  seed: number;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createDemoCloud(opts: Partial<DemoOptions> = {}): PointCloudData {
  const total = opts.count ?? 620_000;
  const rnd = mulberry32(opts.seed ?? 20240917);

  const R = 1.0; // coil major radius
  const H = 1.9; // coil height
  const tube = 0.085; // conductor bundle radius
  const turns = 26;

  const nCoil = Math.floor(total * 0.56);
  const nStator = Math.floor(total * 0.24);
  const nPlate = total - nCoil - nStator;

  const positions = new Float32Array(total * 3);
  const colors = new Uint8Array(total * 3);
  const temperature = new Float32Array(total);
  const currentDensity = new Float32Array(total);
  const layer = new Float32Array(total);

  let w = 0;

  /* ── winding: solenoid of round conductor bundles ── */
  for (let i = 0; i < nCoil; i++) {
    const u = i / nCoil;
    const theta = u * turns * Math.PI * 2;
    const jitter = (rnd() - 0.5) * 0.004;
    // position along the bundle centreline
    const cx = R * Math.cos(theta + jitter);
    const cy = R * Math.sin(theta + jitter);
    const cz = (u - 0.5) * H;

    // tangent / normal / binormal frame
    const dTheta = turns * Math.PI * 2 / nCoil;
    const dCz = H / nCoil;
    let tx = -R * Math.sin(theta) * dTheta;
    let ty = R * Math.cos(theta) * dTheta;
    let tz = dCz;
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;

    // radial normal
    let nx = Math.cos(theta), ny = Math.sin(theta), nz = 0;
    const dot = nx * tx + ny * ty + nz * tz;
    nx -= tx * dot; ny -= ty * dot; nz -= tz * dot;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    const bx = ty * nz - tz * ny;
    const by = tz * nx - tx * nz;
    const bz = tx * ny - ty * nx;

    // point inside the circular cross-section
    const a = rnd() * Math.PI * 2;
    const rr = tube * Math.sqrt(rnd());
    const ox = Math.cos(a) * rr;
    const oy = Math.sin(a) * rr;

    const x = cx + nx * ox + bx * oy;
    const y = cy + ny * ox + by * oy;
    const z = cz + nz * ox + bz * oy;

    // temperature: global axial gradient + local hot spot + inner-surface gain
    const hotspot = Math.exp(-Math.pow((u - 0.63) / 0.055, 2)) * 46;
    const second = Math.exp(-Math.pow((u - 0.21) / 0.09, 2)) * 12;
    const radial = (1 - rr / tube) * 7;
    const t = 42 + 26 * u + hotspot + second + radial + (rnd() - 0.5) * 1.6;

    positions[w * 3] = x;
    positions[w * 3 + 1] = y;
    positions[w * 3 + 2] = z;
    temperature[w] = t;
    currentDensity[w] = 3.4 + 1.5 * Math.sin(u * Math.PI * 6) + hotspot / 26 + (rnd() - 0.5) * 0.25;
    layer[w] = 1;

    const shade = 0.72 + 0.28 * (1 - rr / tube);
    colors[w * 3] = Math.round(214 * shade);
    colors[w * 3 + 1] = Math.round(168 * shade);
    colors[w * 3 + 2] = Math.round(96 * shade);
    w++;
  }

  /* ── stator shell ── */
  for (let i = 0; i < nStator; i++) {
    const a = rnd() * Math.PI * 2;
    const z = (rnd() - 0.5) * H * 1.16;
    const r = R * 1.42 + (rnd() - 0.5) * 0.02;
    // cooling fin modulation
    const fin = 0.5 + 0.5 * Math.cos(a * 36);
    const x = r * Math.cos(a);
    const y = r * Math.sin(a);
    const t = 31 + 9 * fin + 6 * (0.5 + 0.5 * (z / (H * 0.58))) + (rnd() - 0.5) * 1.2;
    positions[w * 3] = x;
    positions[w * 3 + 1] = y;
    positions[w * 3 + 2] = z;
    temperature[w] = t;
    currentDensity[w] = (rnd() - 0.5) * 0.3;
    layer[w] = 2;
    const g = 118 + Math.round(fin * 34);
    colors[w * 3] = g;
    colors[w * 3 + 1] = g + 6;
    colors[w * 3 + 2] = g + 14;
    w++;
  }

  /* ── end plates + base ── */
  for (let i = 0; i < nPlate; i++) {
    const isPlate = rnd() < 0.5;
    let x: number, y: number, z: number;
    if (isPlate) {
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(rnd()) * R * 1.42;
      x = r * Math.cos(a);
      y = r * Math.sin(a);
      z = (rnd() < 0.5 ? -1 : 1) * H * 0.58;
    } else {
      x = (rnd() - 0.5) * 3.6;
      y = (rnd() - 0.5) * 3.6;
      z = -H * 0.58 - 0.12 - rnd() * 0.02;
    }
    const t = 26 + 4 * rnd() + (isPlate ? 3 : 0);
    positions[w * 3] = x;
    positions[w * 3 + 1] = y;
    positions[w * 3 + 2] = z;
    temperature[w] = t;
    currentDensity[w] = 0;
    layer[w] = isPlate ? 3 : 4;
    const g = 84 + Math.round(rnd() * 12);
    colors[w * 3] = g;
    colors[w * 3 + 1] = g + 4;
    colors[w * 3 + 2] = g + 10;
    w++;
  }

  const scalars = new Map<string, Float32Array>();
  scalars.set('temperature', temperature);
  scalars.set('current_density', currentDensity);
  scalars.set('layer', layer);

  const units = new Map<string, string>();
  units.set('temperature', '°C');
  units.set('current_density', 'A/mm²');

  return createCloud({
    name: 'demo_motor_winding',
    format: 'DEMO',
    count: total,
    positions,
    colors,
    scalars,
    scalarOrder: ['temperature', 'current_density', 'layer'],
    units,
    meta: {
      [tMeta('说明')]: t('demo.note'),
      [tMeta('点构成')]: t('demo.composition', { c: nCoil.toLocaleString(), s: nStator.toLocaleString(), p: nPlate.toLocaleString() }),
      [tMeta('热点')]: t('demo.hotspot'),
    },
    warnings: [],
  });
}
