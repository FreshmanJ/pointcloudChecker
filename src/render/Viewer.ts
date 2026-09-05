/**
 * WebGL viewport: point rendering with a custom shader, camera control,
 * spatial picking and measurement overlays.
 */

import * as THREE from 'three';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import type { Bounds, CloudView } from '../core/cloud';
import { LUT_SIZE } from '../core/colormap';

export type ColorMode = 'uniform' | 'attribute' | 'rgb' | 'elevation';
export type PointShape = 'square' | 'circle';
export type SizeMode = 'fixed' | 'world';
export type GridPlane = 'none' | 'xy' | 'xz' | 'yz';

export interface RenderSettings {
  colorMode: ColorMode;
  uniformColor: string;
  pointSize: number;
  sizeMode: SizeMode;
  shape: PointShape;
  opacity: number;
  lut: Uint8Array;
  min: number;
  max: number;
  background: string;
  showGrid: GridPlane;
  showBox: boolean;
  showAxes: boolean;
  /** Brightness multiplier applied to vertex colours. */
  colorGain: number;
}

const VERT = /* glsl */ `
  attribute float aValue;
  attribute vec3 aColor;

  uniform sampler2D uLut;
  uniform vec3 uUniformColor;
  uniform float uMin;
  uniform float uMax;
  uniform float uPointSize;
  uniform float uScale;       // viewportHeight / (2 * tan(fov/2))
  uniform float uDpr;
  uniform int uSizeMode;      // 0 = fixed px, 1 = world
  uniform int uColorMode;     // 0 uniform, 1 attribute, 2 rgb, 3 elevation
  uniform float uGain;

  varying vec3 vColor;
  varying float vFog;

  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;

    if (uSizeMode == 1) {
      gl_PointSize = clamp(uPointSize * uScale / max(-mv.z, 1e-6), 1.0, 128.0) * uDpr;
    } else {
      gl_PointSize = max(1.0, uPointSize) * uDpr;
    }

    if (uColorMode == 0) {
      vColor = uUniformColor;
    } else if (uColorMode == 1) {
      float t = clamp((aValue - uMin) / max(uMax - uMin, 1e-12), 0.0, 1.0);
      vColor = texture2D(uLut, vec2(t, 0.5)).rgb;
    } else if (uColorMode == 2) {
      vColor = aColor;
    } else {
      float t = clamp((position.z - uMin) / max(uMax - uMin, 1e-12), 0.0, 1.0);
      vColor = texture2D(uLut, vec2(t, 0.5)).rgb;
    }
    vColor *= uGain;

    float dist = -mv.z;
    vFog = dist;
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  uniform int uShape;      // 0 square, 1 circle
  uniform float uOpacity;
  varying vec3 vColor;
  varying float vFog;

  void main() {
    if (uShape == 1) {
      vec2 d = gl_PointCoord - vec2(0.5);
      float r2 = dot(d, d);
      if (r2 > 0.25) discard;
    }
    gl_FragColor = vec4(vColor, uOpacity);
  }
`;

/** Unit axes used by the plane-rotation buttons. */
const PLANE_AXES = {
  xy: new THREE.Vector3(0, 0, 1),
  yz: new THREE.Vector3(1, 0, 0),
  xz: new THREE.Vector3(0, 1, 0),
} as const;

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);

/**
 * Rotation speed expressed in the OrbitControls scale it replaced, so the feel
 * of a mouse drag is unchanged. `resize()` converts it to the TrackballControls
 * scale (which normalises drag distance against the viewport *width* instead of
 * the *height*, hence the π · aspect factor).
 */
const BASE_ROTATE_SPEED = 0.85;

/** Matches OrbitControls' `autoRotateSpeed = 0.9` → about 5.4°/s. */
const TURNTABLE_SPEED = 0.9;

/** Scratch objects reused by the per-frame spin so the loop stays allocation-free. */
const _spinQuat = new THREE.Quaternion();
const _spinOffset = new THREE.Vector3();

/**
 * Pick/measure markers: a ring with a centre dot, drawn in device pixels and
 * depth-tested against the cloud so it sits *on* the surface instead of
 * floating above everything.
 *
 * The vertex stage nudges the marker a fraction of its distance toward the
 * camera — enough to win the depth tie against the very point it marks (a bare
 * depth test against a dense cloud shreds the ring), while geometry genuinely
 * in front still occludes it.
 */
const MARKER_VERT = /* glsl */ `
  uniform float uSize;
  uniform float uDpr;

  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    mv.z += max(-mv.z, 1e-6) * 0.004;
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * uDpr;
  }
`;

const MARKER_FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uColor;
  uniform vec3 uOutline;
  uniform float uSize;
  uniform float uOpacity;

  void main() {
    float r = length(gl_PointCoord - vec2(0.5)) * uSize;
    float s = uSize / 16.0;
    float aa = 0.65;

    float aDot = 1.0 - smoothstep(1.4 * s - aa, 1.4 * s + aa, r);
    float aRing = smoothstep(4.8 * s - aa, 4.8 * s + aa, r) * (1.0 - smoothstep(6.4 * s - aa, 6.4 * s + aa, r));
    float aEdge = smoothstep(6.9 * s - aa, 6.9 * s + aa, r) * (1.0 - smoothstep(7.9 * s - aa, 7.9 * s + aa, r));

    float a = max(aDot, max(aRing, aEdge));
    if (a < 0.01) discard;

    vec3 c = uColor * max(aDot, aRing);
    c = mix(c, uOutline, aEdge);
    gl_FragColor = vec4(c, a * uOpacity);
  }
`;

export interface PickResult {
  viewIndex: number;
  sourceIndex: number;
  position: [number, number, number];
  distance: number;
}

export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: TrackballControls;
  readonly canvas: HTMLCanvasElement;

  /** Auto-rotation (TrackballControls has no `autoRotate` of its own). */
  private turntable = false;
  /** True between the controls' `start` and `end` events; pauses auto-rotation. */
  private interacting = false;

  private points: THREE.Points | null = null;
  private geometry: THREE.BufferGeometry | null = null;
  private material: THREE.ShaderMaterial;
  private lutTexture: THREE.DataTexture;

  private grid: THREE.GridHelper | null = null;
  private boxHelper: THREE.LineSegments | null = null;
  private axes: THREE.AxesHelper | null = null;

  private markerGroup = new THREE.Group();
  private hoverMarker: THREE.Points;
  private endpointMarkers: THREE.Points[] = [];
  /** Every marker material, so dpr and outline colour stay in sync. */
  private markerMaterials: THREE.ShaderMaterial[] = [];
  private measureLine: THREE.Mesh | null = null;
  private measureGroup = new THREE.Group();

  private view: CloudView | null = null;
  private raycaster = new THREE.Raycaster();
  private frameId = 0;
  private needsRender = true;
  private dpr = 1;
  /** Upper bound for the device pixel ratio (user configurable). */
  dprCap = 2;
  /** State saved by `renderTo` for `renderRestore` (null when on-screen). */
  private renderUndo: {
    prevRatio: number;
    prevBg: THREE.Color;
    prevAlpha: number;
    prevAspect: number;
    prevDpr: number;
    prevScale: number;
  } | null = null;

  onFrame?: (fps: number) => void;
  fps = 0;
  private lastT = 0;
  private frameCount = 0;
  private fpsAccum = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      // alpha:true so image export can render onto a transparent background;
      // on-screen rendering stays opaque because the clear alpha is 1.
      alpha: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    this.dpr = Math.min(window.devicePixelRatio || 1, this.dprCap);
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setClearColor(0x06080b, 1);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.001, 100000);
    this.camera.position.set(3, 2.4, 3.4);

    // TrackballControls instead of OrbitControls: it carries `camera.up` along
    // with every rotation, so the view can roll straight over the poles with no
    // clamp. OrbitControls keeps a fixed world up and hard-clamps the polar
    // angle to [EPS, PI-EPS] (Spherical.makeSafe), which is what made rotation
    // "hit a wall" at the zenith/nadir.
    this.controls = new TrackballControls(this.camera, canvas);
    // Damping: TrackballControls has no `enableDamping` flag — it damps whenever
    // `staticMoving` is false, and `dynamicDampingFactor` is the strength. 0.2
    // coasts for ~9.5× the last frame's step, which is what OrbitControls did
    // with `dampingFactor = 0.09`; smaller values glide noticeably further.
    this.controls.staticMoving = false;
    this.controls.dynamicDampingFactor = 0.2;
    this.controls.zoomSpeed = 2.0;
    this.controls.panSpeed = 0.8;
    this.controls.minDistance = 1e-6;
    this.controls.maxDistance = Infinity;
    // The app owns the keyboard shortcuts; drop the built-in A/S/D modifiers.
    this.controls.keys = ['', '', ''];
    this.controls.addEventListener('start', () => {
      this.interacting = true;
    });
    this.controls.addEventListener('end', () => {
      this.interacting = false;
    });
    this.controls.addEventListener('change', () => this.invalidate());

    const lutData = new Uint8Array(LUT_SIZE * 4).fill(255);
    this.lutTexture = new THREE.DataTexture(lutData, LUT_SIZE, 1, THREE.RGBAFormat);
    this.lutTexture.minFilter = THREE.LinearFilter;
    this.lutTexture.magFilter = THREE.LinearFilter;
    this.lutTexture.wrapS = THREE.ClampToEdgeWrapping;
    this.lutTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.lutTexture.needsUpdate = true;

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: true,
      depthTest: true,
      uniforms: {
        uLut: { value: this.lutTexture },
        uUniformColor: { value: new THREE.Color(0x9fb4d0) },
        uMin: { value: 0 },
        uMax: { value: 1 },
        uPointSize: { value: 2 },
        uScale: { value: 500 },
        uDpr: { value: this.dpr },
        uSizeMode: { value: 0 },
        uColorMode: { value: 0 },
        uShape: { value: 1 },
        uOpacity: { value: 1 },
        uGain: { value: 1 },
      },
    });

    this.hoverMarker = makeMarker(0x06b6d4, 16, this.markerMaterials);
    this.hoverMarker.visible = false;
    this.markerGroup.add(this.hoverMarker);
    for (let i = 0; i < 2; i++) {
      const m = makeMarker(i === 0 ? 0x35d07f : 0xff6b6b, 19, this.markerMaterials);
      m.visible = false;
      this.endpointMarkers.push(m);
      this.markerGroup.add(m);
    }
    this.markerGroup.renderOrder = 10;
    this.scene.add(this.markerGroup);
    this.scene.add(this.measureGroup);
    this.setMarkerOutline('#06080b');

    this.resize();
    this.loop();
  }

  /* ────────── lifecycle ────────── */

  private loop = (): void => {
    this.frameId = requestAnimationFrame(this.loop);
    const now = performance.now();
    // Clamped so a backgrounded tab does not spin the camera by a huge step.
    const dt = this.lastT ? Math.min((now - this.lastT) / 1000, 0.1) : 0;
    if (this.lastT) {
      this.frameCount++;
      this.fpsAccum += now - this.lastT;
      if (this.fpsAccum > 500) {
        this.fps = (this.frameCount * 1000) / this.fpsAccum;
        this.frameCount = 0;
        this.fpsAccum = 0;
        this.onFrame?.(this.fps);
      }
    }
    this.lastT = now;

    if (this.turntable && !this.interacting) this.spin(dt);

    this.controls.update();
    if (this.needsRender) {
      this.needsRender = false;
      this.renderer.render(this.scene, this.camera);
    }
  };

  invalidate(): void {
    this.needsRender = true;
  }

  dispose(): void {
    cancelAnimationFrame(this.frameId);
    this.controls.dispose();
    this.geometry?.dispose();
    this.material.dispose();
    this.lutTexture.dispose();
    this.renderer.dispose();
  }

  resize(): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const w = Math.max(1, parent.clientWidth);
    const h = Math.max(1, parent.clientHeight);
    this.dpr = Math.min(window.devicePixelRatio || 1, this.dprCap);
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // TrackballControls caches the element rect and uses it to normalise pointer
    // motion, so it has to be refreshed whenever the viewport changes size.
    this.controls.handleResize();
    this.controls.rotateSpeed = Math.PI * (w / h) * BASE_ROTATE_SPEED;
    this.material.uniforms.uDpr.value = this.dpr;
    for (const m of this.markerMaterials) m.uniforms.uDpr.value = this.dpr;
    this.material.uniforms.uScale.value =
      h / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    this.invalidate();
  }

  /** Cap the device pixel ratio used for rendering (perf escape hatch). */
  setPixelRatioCap(cap: number): void {
    this.dprCap = Math.max(0.4, Math.min(3, cap));
    this.resize();
  }

  /* ────────── data ────────── */

  setView(view: CloudView | null): void {
    this.clearView();
    this.view = view;
    if (!view || view.count === 0) {
      this.invalidate();
      return;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(view.positions, 3));
    geo.setAttribute('aValue', new THREE.BufferAttribute(new Float32Array(view.count), 1));
    const colors = view.colors;
    geo.setAttribute(
      'aColor',
      new THREE.BufferAttribute(
        colors ?? new Float32Array(view.count * 3).fill(0.75),
        3,
        colors ? true : false
      )
    );
    geo.computeBoundingSphere();

    this.geometry = geo;
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.scene.add(this.points);
    this.invalidate();
  }

  /** Upload the values of the attribute currently used for colouring. */
  setValueAttribute(values: Float32Array | null): void {
    if (!this.geometry) return;
    const attr = this.geometry.getAttribute('aValue') as THREE.BufferAttribute | undefined;
    if (!attr) return;
    const arr = attr.array as Float32Array;
    if (values && values.length === arr.length) {
      arr.set(values);
      attr.needsUpdate = true;
    } else if (!values) {
      arr.fill(0);
      attr.needsUpdate = true;
    }
    this.invalidate();
  }

  private clearView(): void {
    if (this.points) {
      this.scene.remove(this.points);
      this.points = null;
    }
    this.geometry?.dispose();
    this.geometry = null;
  }

  /* ────────── appearance ────────── */

  applySettings(s: RenderSettings): void {
    const u = this.material.uniforms;
    const lut = new Uint8Array(LUT_SIZE * 4);
    for (let i = 0; i < LUT_SIZE; i++) {
      lut[i * 4] = s.lut[i * 3];
      lut[i * 4 + 1] = s.lut[i * 3 + 1];
      lut[i * 4 + 2] = s.lut[i * 3 + 2];
      lut[i * 4 + 3] = 255;
    }
    (this.lutTexture.image as { data: Uint8Array }).data = lut;
    this.lutTexture.needsUpdate = true;

    u.uUniformColor.value.set(s.uniformColor);
    u.uMin.value = s.min;
    u.uMax.value = s.max;
    u.uPointSize.value = s.pointSize;
    u.uSizeMode.value = s.sizeMode === 'world' ? 1 : 0;
    u.uColorMode.value =
      s.colorMode === 'attribute' ? 1 : s.colorMode === 'rgb' ? 2 : s.colorMode === 'elevation' ? 3 : 0;
    u.uShape.value = s.shape === 'circle' ? 1 : 0;
    u.uOpacity.value = s.opacity;
    u.uGain.value = s.colorGain;
    this.material.transparent = s.opacity < 1;
    this.material.depthWrite = s.opacity >= 0.99;

    this.renderer.setClearColor(new THREE.Color(s.background), 1);
    this.setMarkerOutline(s.background);
    this.invalidate();
  }

  /**
   * Marker outlines must contrast with whatever is behind them: white on a dark
   * background, near-black on a light one. Picked from the clear colour.
   */
  private setMarkerOutline(background: string): void {
    const bg = new THREE.Color(background);
    const lum = 0.2126 * bg.r + 0.7152 * bg.g + 0.0722 * bg.b;
    const outline = lum > 0.45 ? 0x22303c : 0xf1f5f9;
    for (const m of this.markerMaterials) m.uniforms.uOutline.value = new THREE.Color(outline);
  }

  /* ────────── helpers (grid / box / axes) ────────── */

  setHelpers(bounds: Bounds | null, opts: { grid: GridPlane; box: boolean; axes: boolean }): void {
    this.grid?.removeFromParent();
    this.boxHelper?.removeFromParent();
    this.axes?.removeFromParent();
    this.grid = null;
    this.boxHelper = null;
    this.axes = null;
    if (!bounds) {
      this.invalidate();
      return;
    }

    const size = Math.max(
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2]
    ) || 1;
    const cx = (bounds.min[0] + bounds.max[0]) / 2;
    const cy = (bounds.min[1] + bounds.max[1]) / 2;
    const cz = (bounds.min[2] + bounds.max[2]) / 2;

    if (opts.grid !== 'none') {
      const divisions = 10;
      const g = new THREE.GridHelper(size * 1.6, divisions, 0x2a3646, 0x18202b);
      g.position.set(cx, cy, cz);
      if (opts.grid === 'xy') g.rotation.x = Math.PI / 2;
      else if (opts.grid === 'yz') g.rotation.z = Math.PI / 2;
      (g.material as THREE.Material).transparent = true;
      (g.material as THREE.Material).opacity = 0.7;
      g.renderOrder = -1;
      this.grid = g;
      this.scene.add(g);
    }

    if (opts.box) {
      const box = new THREE.Box3(
        new THREE.Vector3(bounds.min[0], bounds.min[1], bounds.min[2]),
        new THREE.Vector3(bounds.max[0], bounds.max[1], bounds.max[2])
      );
      const helper = new THREE.Box3Helper(box, 0x3d5170);
      (helper.material as THREE.Material).transparent = true;
      (helper.material as THREE.Material).opacity = 0.75;
      this.boxHelper = helper;
      this.scene.add(helper);
    }

    if (opts.axes) {
      const a = new THREE.AxesHelper(size * 0.65);
      a.position.set(bounds.min[0], bounds.min[1], bounds.min[2]);
      (a.material as THREE.Material).depthTest = false;
      a.renderOrder = 5;
      this.axes = a;
      this.scene.add(a);
    }
    this.invalidate();
  }

  /* ────────── camera ────────── */

  frameBounds(bounds: Bounds, animate = false): void {
    const cx = (bounds.min[0] + bounds.max[0]) / 2;
    const cy = (bounds.min[1] + bounds.max[1]) / 2;
    const cz = (bounds.min[2] + bounds.max[2]) / 2;
    const sx = bounds.max[0] - bounds.min[0];
    const sy = bounds.max[1] - bounds.min[1];
    const sz = bounds.max[2] - bounds.min[2];
    const radius = Math.max(Math.hypot(sx, sy, sz) / 2, 1e-4);
    const dist = (radius / Math.tan((this.camera.fov * Math.PI) / 360)) * 1.5;

    const dir = new THREE.Vector3(0.62, 0.46, 0.72).normalize();
    const target = new THREE.Vector3(cx, cy, cz);
    const pos = target.clone().addScaledVector(dir, dist);

    // The framing direction is a fixed iso vector, so it only reads correctly
    // with the world-Y up vector. This also resets any roll picked up while
    // tumbling freely.
    this.setUp(WORLD_UP, dir);

    if (!animate) {
      this.camera.position.copy(pos);
      this.controls.target.copy(target);
      this.camera.near = Math.max(dist / 5000, 1e-5);
      this.camera.far = dist * 50 + radius * 10;
      this.camera.updateProjectionMatrix();
      this.controls.update();
      this.invalidate();
      return;
    }
    const from = this.camera.position.clone();
    const fromTarget = this.controls.target.clone();
    const t0 = performance.now();
    const dur = 420;
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      this.camera.position.lerpVectors(from, pos, e);
      this.controls.target.lerpVectors(fromTarget, target, e);
      this.camera.near = Math.max(dist / 5000, 1e-5);
      this.camera.far = dist * 50 + radius * 10;
      this.camera.updateProjectionMatrix();
      this.invalidate();
      if (k < 1) requestAnimationFrame(step);
    };
    step();
  }

  setViewAxis(axis: 'x' | 'y' | 'z' | '-x' | '-y' | '-z' | 'iso'): void {
    if (!this.view) return;
    const c = this.view.center;
    const target = new THREE.Vector3(c[0], c[1], c[2]);
    const r = this.view.diagonal / 2;
    const d = (r / Math.tan((this.camera.fov * Math.PI) / 360)) * 1.5;
    const dirs: Record<string, [number, number, number]> = {
      x: [1, 0, 0], '-x': [-1, 0, 0],
      y: [0, 1, 0], '-y': [0, -1, 0],
      z: [0, 0, 1], '-z': [0, 0, -1],
      iso: [0.62, 0.46, 0.72],
    };
    const d0 = dirs[axis];
    this.camera.position.set(
      target.x + d0[0] * d,
      target.y + d0[1] * d,
      target.z + d0[2] * d
    );
    this.controls.target.copy(target);
    // Preset views reset the roll to world up.
    this.setUp(WORLD_UP, new THREE.Vector3(d0[0], d0[1], d0[2]).normalize());
    this.camera.lookAt(target);
    this.controls.update();
    this.invalidate();
  }

  /**
   * Set the camera's up vector, guarding against it landing (nearly) parallel to
   * the view direction — both `lookAt` and the trackball's sideways axis need
   * those two to be distinct, and a parallel pair collapses the rotation axis
   * and makes the camera lurch. The fallback is the world axis furthest from the
   * view direction, so the result is stable rather than arbitrary: looking
   * straight down +Y resolves to up = −Z, which keeps +X on screen-right.
   */
  private setUp(up: THREE.Vector3, eyeDir: THREE.Vector3): void {
    if (Math.abs(eyeDir.dot(up)) < 0.999) {
      this.camera.up.copy(up);
      return;
    }
    const ax = Math.abs(eyeDir.x);
    const ay = Math.abs(eyeDir.y);
    const az = Math.abs(eyeDir.z);
    const helper = ax <= ay && ax <= az ? AXIS_X : ay <= az ? AXIS_Y : AXIS_Z;
    this.camera.up.crossVectors(eyeDir, helper).normalize();
  }

  /**
   * Rotate the camera around the target **within** the given coordinate plane.
   *
   *   xy → about the Z axis   ·   yz → about the X axis   ·   xz → about the Y axis
   *
   * The eye offset and the up vector are rotated by the same quaternion — the
   * "camera on a ring" motion, identical to what a mouse drag produces. Because
   * up travels with the eye, the angle between them is preserved, so the step
   * never degenerates and rotation passes cleanly through every pole (24 × 15°
   * steps bring the camera back to exactly where it started).
   */
  rotateInPlane(plane: 'xy' | 'yz' | 'xz', deg: number): void {
    const target = this.controls.target;
    const rad = (deg * Math.PI) / 180;
    const q = new THREE.Quaternion().setFromAxisAngle(PLANE_AXES[plane], rad);

    const offset = this.camera.position.clone().sub(target);
    offset.applyQuaternion(q);
    this.camera.position.copy(target).add(offset);
    this.camera.up.applyQuaternion(q);

    // Let the controls re-aim the camera at the target from its new position.
    this.controls.update();
    this.invalidate();
  }

  /**
   * Auto-rotation about the world Y axis. TrackballControls ships no
   * `autoRotate`, so the turntable is driven from the render loop instead.
   * Rotating `up` by the same quaternion keeps whatever roll the user has
   * dialled in, so the picture spins rather than tumbling.
   */
  private spin(dt: number): void {
    if (dt <= 0) return;
    const rad = ((2 * Math.PI) / 60) * TURNTABLE_SPEED * dt;
    _spinQuat.setFromAxisAngle(WORLD_UP, rad);
    _spinOffset.subVectors(this.camera.position, this.controls.target).applyQuaternion(_spinQuat);
    this.camera.position.copy(this.controls.target).add(_spinOffset);
    this.camera.up.applyQuaternion(_spinQuat);
    this.invalidate();
  }

  /* ────────── picking ────────── */

  /**
   * Nearest rendered point under the given **canvas-relative** pixel
   * coordinates (origin at the canvas top-left — i.e. what a pointer event's
   * `clientX - rect.left` yields). `radiusScale` grows the search tube for
   * easier hovering.
   */
  pick(px: number, py: number, radiusScale = 1): PickResult | null {
    if (!this.view || this.view.count === 0) return null;
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      (px / rect.width) * 2 - 1,
      -(py / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const o = this.raycaster.ray.origin;
    const d = this.raycaster.ray.direction;

    const radius = this.pickRadius(radiusScale);
    const hit = this.view.index.raycast(
      this.view.positions,
      o.x, o.y, o.z,
      d.x, d.y, d.z,
      radius
    );
    if (!hit) return null;
    return {
      viewIndex: hit.index,
      sourceIndex: this.view.sourceIndex(hit.index),
      position: this.view.positionAt(hit.index),
      distance: hit.t,
    };
  }

  /** World-space radius used for ray-based picking. */
  pickRadius(scale = 1): number {
    const base = this.view ? this.view.diagonal * 0.0015 : 0.01;
    const sizeMode = this.material.uniforms.uSizeMode.value as number;
    if (sizeMode === 1) {
      const ps = this.material.uniforms.uPointSize.value as number;
      return Math.max(base, ps * 1.2) * scale;
    }
    const d = this.camera.position.distanceTo(this.controls.target);
    const worldPerPixel =
      (2 * Math.tan((this.camera.fov * Math.PI) / 360) * d) / Math.max(1, this.canvas.clientHeight);
    const px = this.material.uniforms.uPointSize.value as number;
    return Math.max(base, worldPerPixel * px * 0.9) * scale;
  }

  /* ────────── overlays ────────── */

  setHover(pick: PickResult | null): void {
    if (!pick) {
      this.hoverMarker.visible = false;
      this.invalidate();
      return;
    }
    setMarkerPosition(this.hoverMarker, pick.position[0], pick.position[1], pick.position[2]);
    this.hoverMarker.visible = true;
    this.invalidate();
  }

  setEndpoints(a: [number, number, number] | null, b: [number, number, number] | null): void {
    setMarkerVisible(this.endpointMarkers[0], a);
    setMarkerVisible(this.endpointMarkers[1], b);
    this.updateMeasureLine(a, b);
    this.invalidate();
  }

  private updateMeasureLine(a: [number, number, number] | null, b: [number, number, number] | null): void {
    if (this.measureLine) {
      this.measureGroup.remove(this.measureLine);
      this.measureLine.geometry.dispose();
      (this.measureLine.material as THREE.Material).dispose();
      this.measureLine = null;
    }
    if (!a || !b) return;
    const va = new THREE.Vector3(a[0], a[1], a[2]);
    const vb = new THREE.Vector3(b[0], b[1], b[2]);
    const len = va.distanceTo(vb);
    if (!(len > 0)) return;
    const radius = (this.view?.diagonal ?? 1) * 0.0016;
    const geo = new THREE.CylinderGeometry(radius, radius, len, 10, 1, true);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x4dd2ff,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(va).add(vb).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      vb.clone().sub(va).normalize()
    );
    mesh.renderOrder = 20;
    this.measureLine = mesh;
    this.measureGroup.add(mesh);
  }

  /** Highlight a set of points (e.g. filtered-out neighbours) — reserved. */
  clearOverlays(): void {
    this.setHover(null);
    this.setEndpoints(null, null);
  }

  /* ────────── output ────────── */

  /**
   * Render the scene at an arbitrary **logical** size and pixel scale — used
   * by the image-export dialog for both its live thumbnail and the final PNG.
   *
   * After the call the WebGL canvas holds a `width × height × pixelScale`
   * buffer; the caller must consume it synchronously (`drawImage` / toDataURL,
   * valid thanks to `preserveDrawingBuffer`) and then call `renderRestore()`.
   * The camera aspect is switched to the target size, so an export with a
   * different aspect ratio than the on-screen viewport is framed correctly
   * instead of being stretched. `background: null` renders transparent
   * (clear alpha 0), a string paints that colour, undefined keeps the current.
   */
  renderTo(w: number, h: number, pixelScale: number, background?: string | null): void {
    const prevRatio = this.renderer.getPixelRatio();
    const prevBg = new THREE.Color();
    this.renderer.getClearColor(prevBg);
    const prevAspect = this.camera.aspect;
    const u = this.material.uniforms;
    const prevDpr = u.uDpr.value as number;
    const prevScale = u.uScale.value as number;
    const prevAlpha = this.renderer.getClearAlpha();

    if (background === null) this.renderer.setClearColor(0x000000, 0);
    else if (background) this.renderer.setClearColor(new THREE.Color(background), 1);
    this.renderer.setPixelRatio(pixelScale);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // World-size mode derives point size from the viewport height; fixed-size
    // mode needs uDpr so points scale up with the export resolution exactly
    // like they do with the device pixel ratio on screen.
    u.uDpr.value = pixelScale;
    u.uScale.value = h / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    this.renderer.render(this.scene, this.camera);

    this.renderUndo = { prevRatio, prevBg, prevAlpha, prevAspect, prevDpr, prevScale };
  }

  /** Undo a `renderTo` and put the on-screen viewport back the way it was. */
  renderRestore(): void {
    const undo = this.renderUndo;
    if (!undo) return;
    this.renderUndo = null;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.renderer.setPixelRatio(undo.prevRatio);
    this.renderer.setSize(w, h, false);
    this.renderer.setClearColor(undo.prevBg, undo.prevAlpha);
    this.camera.aspect = undo.prevAspect;
    this.camera.updateProjectionMatrix();
    const u = this.material.uniforms;
    u.uDpr.value = undo.prevDpr;
    u.uScale.value = undo.prevScale;
    this.invalidate();
  }

  /** Largest square texture the GPU can render (caps export resolution). */
  get maxRenderSize(): number {
    return this.renderer.capabilities.maxTextureSize || 4096;
  }

  screenshot(scale = 2, background?: string): string {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.renderTo(w, h, scale, background);
    const url = this.canvas.toDataURL('image/png');
    this.renderRestore();
    return url;
  }

  /* ────────── misc ────────── */

  get cameraPosition(): [number, number, number] {
    const p = this.camera.position;
    return [p.x, p.y, p.z];
  }

  setTurntable(on: boolean): void {
    this.turntable = on;
    this.invalidate();
  }

  enableControls(on: boolean): void {
    this.controls.enabled = on;
  }
}

/* ────────── marker helpers ────────── */

function makeMarker(color: number, size: number, materials: THREE.ShaderMaterial[]): THREE.Points {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
  const mat = new THREE.ShaderMaterial({
    vertexShader: MARKER_VERT,
    fragmentShader: MARKER_FRAG,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      // Overwritten from the background colour whenever the theme changes.
      uOutline: { value: new THREE.Color(0x22303c) },
      uSize: { value: size },
      uOpacity: { value: 1 },
      uDpr: { value: 1 },
    },
  });
  materials.push(mat);
  const p = new THREE.Points(geo, mat);
  p.renderOrder = 30;
  p.frustumCulled = false;
  return p;
}

function setMarkerPosition(marker: THREE.Points, x: number, y: number, z: number): void {
  const attr = marker.geometry.getAttribute('position') as THREE.BufferAttribute;
  (attr.array as Float32Array)[0] = x;
  (attr.array as Float32Array)[1] = y;
  (attr.array as Float32Array)[2] = z;
  attr.needsUpdate = true;
  marker.geometry.computeBoundingSphere();
}

function setMarkerVisible(marker: THREE.Points, p: [number, number, number] | null): void {
  if (!p) {
    marker.visible = false;
    return;
  }
  setMarkerPosition(marker, p[0], p[1], p[2]);
  marker.visible = true;
}
