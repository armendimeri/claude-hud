// P2-01 look study: the scene drawn as light. Same inputs as src/web/cockpit/scene.mjs (the projection and the keyed
// layout from src/, unchanged); only the drawing is new.
//
//   createHolo({host, labels, overlay, textFor, onPick, motion}) -> api
//
// Everything is additive light on black: thin rings with tick marks and arc segments, an arc-reactor core at the hub,
// a hex grid floor that fades into depth, a radar sweep, drifting dust, edge-lit crystals floating over hex pads, and
// a bloom pass (post.mjs). Text stays HTML (crisp, selectable by the list, never in the canvas).
import * as THREE from '../../../../../../src/web/vendor/three/three.module.min.js';
import { estimateLabelWidth, placeLabels } from '../../../../../../src/web/cockpit/layout.mjs';
import { STATE } from '../../../../../../src/web/cockpit/projection.mjs';
import { glyph } from '../../../../../../src/web/components/status.mjs';
import { createPost } from './post.mjs';

THREE.ColorManagement.enabled = false;

const TAU = Math.PI * 2;
const OFF = new Set((new URLSearchParams(globalThis.location?.search || '').get('off') || '').split(',').filter(Boolean));   // profiling only
const HEX = { arc: 0x29e6ff, amber: 0xffb547, alert: 0xff4d5e, ok: 0x4dffa6, agent: 0xb28cff, dim: 0x6d8296, ink: 0xd6f3ff };
const OPENING = 2.4;                       // seconds; V2 allows 2.5
const HOME = { elev: 46, az: 0 };
const FOV = 30;
const ELEV = { min: 14, max: 78 }, AZ_LIMIT = 85, ZOOM = { min: 0.6, max: 3 };
const MAX_DPR = 1.25;   // measured: 1.5 sits on the 33 ms line on the Iris Xe, 1.25 leaves headroom
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const ease = k => 1 - (1 - clamp(k, 0, 1)) ** 3;
const easeInOut = k => { k = clamp(k, 0, 1); return k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2; };
const rad = d => d * Math.PI / 180;
const span = (t, a, b) => clamp((t - a) / (b - a), 0, 1);

// Per state: colour, light level, core height and pad radius.
const LOOK = {
  'needs-you': { c: 'alert', k: 1.25, h: 1.9, r: 1.05 },
  working: { c: 'amber', k: 1.0, h: 1.7, r: 0.92 },
  agents: { c: 'agent', k: 0.95, h: 1.7, r: 0.92 },
  done: { c: 'ok', k: 0.95, h: 1.6, r: 0.88 },
  idle: { c: 'arc', k: 0.62, h: 1.5, r: 0.85 },
  ended: { c: 'dim', k: 0.35, h: 1.2, r: 0.8 },
  sub: { c: 'agent', k: 0.9, h: 1.15, r: 0.56 },
  'sub-done': { c: 'ok', k: 0.6, h: 1.05, r: 0.52 },
  sat: { c: 'arc', k: 0.45, h: 0.9, r: 0.6 },
};

// ---------------------------------------------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------------------------------------------
const FLOOR_VERT = /* glsl */`
out vec3 vWorld;
void main() { vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const FLOOR_FRAG = /* glsl */`
precision highp float;
in vec3 vWorld; out vec4 outColor;
uniform float uTime, uReveal, uEdge, uSweep, uSweepOn, uScanZ, uScanOn, uIntensity;
uniform vec3 uColor, uScanColor;
uniform vec3 uFocus;   // xz centre of the scene, fade radius
uniform vec3 uSel;     // xz centre of the selected cluster, radius (0 = none)
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
vec4 hexCoords(vec2 uv) {
  const vec2 s = vec2(1.0, 1.7320508);
  vec4 hC = floor(vec4(uv, uv - vec2(0.5, 1.0)) / s.xyxy) + 0.5;
  vec4 h = vec4(uv - hC.xy * s, uv - (hC.zw + 0.5) * s);
  return dot(h.xy, h.xy) < dot(h.zw, h.zw) ? vec4(h.xy, hC.xy) : vec4(h.zw, hC.zw + 0.5);
}
float hexEdge(vec2 p) { p = abs(p); return 0.5 - max(dot(p, vec2(0.5, 0.8660254)), p.x); }
void main() {
  vec2 p = vWorld.xz;
  float r = length(p);
  vec2 hp = p / 1.7;
  vec4 hc = hexCoords(hp);
  float e = hexEdge(hc.xy);
  float fw = length(fwidth(hp)) * 0.9;
  float line = 1.0 - smoothstep(0.0, fw, e);
  // Far lines melt together into a moire: fade them by their screen density.
  line *= 1.0 - smoothstep(0.08, 0.32, fw);
  float d = length(p - uFocus.xy);
  float fade = smoothstep(uFocus.z, uFocus.z * 0.1, d);
  // Range rings around the hub, every 12 units.
  float rr = abs(fract(r / 12.0 + 0.5) - 0.5) * 12.0;
  float ring = (1.0 - smoothstep(0.0, fwidth(r) * 1.1, rr)) * smoothstep(84.0, 30.0, r) * step(8.0, r);
  // A few cells breathe faintly.
  float hcell = hash(hc.zw);
  float cell = step(0.988, hcell) * (0.5 + 0.5 * sin(uTime * (0.4 + hcell * 1.5) + hcell * 50.0)) * smoothstep(0.0, 0.42, e) * (1.0 - smoothstep(0.42, 0.5, e));
  // Radar sweep around the hub (8 s), with a fading trail behind the beam.
  float ang = atan(p.y, p.x);
  float behind = mod(uSweep - ang, 6.2831853);
  float sweep = uSweepOn * (exp(-behind * 3.0) * 0.9 + exp(-behind * 40.0) * 1.2) * smoothstep(70.0, 6.0, r) * step(5.0, r);
  float sel = uSel.z > 0.0 ? smoothstep(uSel.z * 1.05, uSel.z * 0.5, length(p - uSel.xy)) : 0.0;
  float a = line * (0.085 + 0.22 * sweep + 0.16 * sel) + ring * (0.1 + 0.25 * sweep) + cell * 0.07 + sweep * 0.012;
  a += exp(-r * r / 260.0) * 0.05;  // light pool under the reactor
  // Opening: the grid draws outward with a bright leading edge.
  float rev = smoothstep(uReveal + 0.5, uReveal - 2.0, r);
  float edge = uEdge * exp(-pow((r - uReveal) / 1.4, 2.0)) * (0.25 + line * 1.6);
  // Opening: the materialising scan line crosses the floor.
  float scan = uScanOn * exp(-pow((p.y - uScanZ) / 0.35, 2.0)) * smoothstep(90.0, 10.0, r);
  float scanTrail = uScanOn * step(p.y, uScanZ) * exp((p.y - uScanZ) / 3.0) * line * 0.6;
  vec3 col = uColor * (a * rev + edge) * fade + uScanColor * (scan * 0.9 + scanTrail) * fade;
  outColor = vec4(col * uIntensity, 1.0);
}`;

const BEAM_VERT = /* glsl */`
out float vF; out float vY;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec3 n = normalize(mat3(modelMatrix) * normal);
  vec3 v = normalize(cameraPosition - wp.xyz);
  vF = clamp(1.0 - abs(dot(n, v)), 0.0, 1.0); vY = clamp(uv.y, 0.0, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const BEAM_FRAG = /* glsl */`
precision highp float;
in float vF; in float vY; out vec4 outColor;
uniform vec3 uColor; uniform float uOpacity; uniform float uTime; uniform float uBands; uniform float uUp;
void main() {
  float along = mix(1.0 - vY, vY, uUp);
  float bands = 1.0 - uBands * 0.5 * (0.5 + 0.5 * sin(vY * 38.0 - uTime * 4.0));
  float a = (pow(vF, 2.2) * 0.85 + 0.15) * pow(along, 1.4) * bands;
  outColor = vec4(uColor * a * uOpacity, 1.0);
}`;

const DUST_VERT = /* glsl */`
uniform float uTime; uniform float uScale; uniform float uMove;
in vec4 seed;
out float vA;
void main() {
  vec3 p = position;
  float t = uTime * uMove;
  p.y = mod(p.y + t * (0.15 + seed.x * 0.35), 16.0) + 0.3;
  p.x += sin(t * 0.21 + seed.y * 6.28) * 1.4;
  p.z += cos(t * 0.17 + seed.z * 6.28) * 1.4;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = (1.0 + seed.w * 2.2) * uScale / -mv.z;
  float edge = smoothstep(16.3, 13.5, p.y) * smoothstep(0.3, 2.0, p.y);
  vA = edge * (0.35 + 0.65 * (0.5 + 0.5 * sin(uTime * (0.7 + seed.y) + seed.x * 30.0)));
}`;
const DUST_FRAG = /* glsl */`
precision highp float;
in float vA; out vec4 outColor;
uniform vec3 uColor; uniform float uOpacity;
void main() { vec2 c = gl_PointCoord - 0.5; float d = dot(c, c); float a = smoothstep(0.25, 0.0, d); outColor = vec4(uColor * a * vA * uOpacity, 1.0); }`;

const FILL_FRAG = /* glsl */`
precision highp float;
in vec2 vUv; out vec4 outColor;
uniform vec3 uColor; uniform float uOpacity;
void main() {
  float r = length(vUv - 0.5) * 2.0;
  float a = smoothstep(0.35, 0.98, r) * 0.55 + smoothstep(0.9, 0.995, r) * (1.0 - smoothstep(0.995, 1.0, r)) * 0.6;
  a *= step(r, 1.0);
  outColor = vec4(uColor * a * uOpacity, 1.0);
}`;
const UV_VERT = /* glsl */`out vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const RIBBON_FRAG = /* glsl */`
precision highp float;
in vec2 vUv; out vec4 outColor;
uniform vec3 uColor; uniform float uOpacity; uniform float uTime; uniform float uLen; uniform float uFlow; uniform float uGrow;
void main() {
  if (vUv.x > uGrow) discard;
  float across = 1.0 - abs(vUv.y - 0.5) * 2.0;
  float core = smoothstep(0.0, 0.7, across);
  float x = vUv.x * uLen;
  float pulse = uFlow * smoothstep(0.88, 1.0, fract(x / 7.0 - uTime * 0.55)) * 2.2;
  float ends = smoothstep(0.0, 0.06, vUv.x) * smoothstep(1.0, 0.94, vUv.x);
  outColor = vec4(uColor * core * ends * (0.28 + pulse) * uOpacity, 1.0);
}`;

// ---------------------------------------------------------------------------------------------------------------
export function createHolo({ host, labels, overlay, textFor, onPick, motion }) {
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  const canvas = renderer.domElement;
  canvas.className = 'holo-gl';
  host.append(canvas);
  const post = createPost(THREE, renderer);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.5, 900);
  const ctx2d = overlay.getContext('2d');
  const disposables = [];
  const own = x => { disposables.push(x); return x; };

  // ---- shared resources ----------------------------------------------------------------------------------------
  const glowTex = own(makeGlowTexture());
  const colorOf = name => new THREE.Color(HEX[name] ?? HEX.arc);
  function lightMat(color, opacity, extra = {}) {
    const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true, ...extra });
    m.userData.base = opacity;
    return m;
  }
  function lineMat(color, opacity) {
    const m = new THREE.LineBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
    m.userData.base = opacity;
    return m;
  }
  function beamMat(color, opacity, { bands = 0, up = 0 } = {}) {
    const m = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, forceSinglePass: true,
      uniforms: { uColor: { value: new THREE.Color(color) }, uOpacity: { value: opacity }, uTime: { value: 0 }, uBands: { value: bands }, uUp: { value: up } } });
    m.userData.base = opacity;
    return m;
  }
  const geoCache = new Map();
  const cached = (key, make) => { if (!geoCache.has(key)) geoCache.set(key, own(make())); return geoCache.get(key); };
  const ringGeo = (r, w, seg = 128, start = 0, len = TAU) => cached(`ring${r}:${w}:${seg}:${start}:${len}`, () => new THREE.RingGeometry(r - w / 2, r + w / 2, seg, 1, start, len).rotateX(-Math.PI / 2));
  const ticksGeo = (r, len, n, majorEvery = 0, majorLen = 0, zs = 1) => cached(`ticks${r}:${len}:${n}:${majorEvery}:${majorLen}:${zs}`, () => {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = i / n * TAU, l = majorEvery && i % majorEvery === 0 ? majorLen : len;
      const c = Math.cos(a), s = Math.sin(a);
      pts.push(c * r, 0, s * r * zs, c * (r + l), 0, s * (r + l) * zs);
    }
    return new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  });
  const dashGeo = (r, n, duty, zs = 1) => cached(`dash${r}:${n}:${duty}:${zs}`, () => {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a0 = i / n * TAU, a1 = (i + duty) / n * TAU, steps = 4;
      for (let k = 0; k < steps; k++) {
        const u = a0 + (a1 - a0) * k / steps, v = a0 + (a1 - a0) * (k + 1) / steps;
        pts.push(Math.cos(u) * r, 0, Math.sin(u) * r * zs, Math.cos(v) * r, 0, Math.sin(v) * r * zs);
      }
    }
    return new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  });
  const hexLineGeo = (r, dashed) => cached(`hex${r}:${dashed}`, () => {
    const pts = [], corner = i => [Math.cos(i / 6 * TAU + Math.PI / 6) * r, Math.sin(i / 6 * TAU + Math.PI / 6) * r];
    for (let i = 0; i < 6; i++) {
      const [x0, z0] = corner(i), [x1, z1] = corner(i + 1);
      const parts = dashed ? [[0, 0.3], [0.45, 0.55], [0.7, 1]] : [[0, 1]];
      for (const [a, b] of parts) pts.push(x0 + (x1 - x0) * a, 0, z0 + (z1 - z0) * a, x0 + (x1 - x0) * b, 0, z0 + (z1 - z0) * b);
    }
    return new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  });
  const crystalGeo = cached('crystal', () => { const g = new THREE.EdgesGeometry(new THREE.OctahedronGeometry(1, 0)); g.scale(0.42, 0.78, 0.42); return g; });
  const crystalFaceGeo = cached('crystalFace', () => new THREE.OctahedronGeometry(1, 0).scale(0.42, 0.78, 0.42));
  const tetherGeo = cached('tether', () => new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 1, 0], 3)));
  const planeGeo = cached('plane', () => new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
  const unitRing = cached('unitRing', () => new THREE.RingGeometry(0.94, 1, 64).rotateX(-Math.PI / 2));

  // ---- floor ------------------------------------------------------------------------------------------------------
  const floorMat = own(new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: FLOOR_VERT, fragmentShader: FLOOR_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uReveal: { value: 400 }, uEdge: { value: 0 }, uSweep: { value: 0 }, uSweepOn: { value: 1 }, uScanZ: { value: 0 }, uScanOn: { value: 0 },
      uIntensity: { value: 1 }, uColor: { value: colorOf('arc') }, uScanColor: { value: new THREE.Color(0x9ff4ff) },
      uFocus: { value: new THREE.Vector3(0, 0, 120) }, uSel: { value: new THREE.Vector3(0, 0, 0) } },
  }));
  const floor = new THREE.Mesh(own(new THREE.PlaneGeometry(420, 420).rotateX(-Math.PI / 2)), floorMat);
  floor.renderOrder = -10;
  scene.add(floor);

  // ---- dust ------------------------------------------------------------------------------------------------------
  const DUST = 900;
  const dustGeo = own(new THREE.BufferGeometry());
  {
    const pos = new Float32Array(DUST * 3), seed = new Float32Array(DUST * 4);
    let s = 7;
    const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < DUST; i++) {
      const a = rnd() * TAU, r = Math.sqrt(rnd()) * 80;
      pos.set([Math.cos(a) * r, rnd() * 16, Math.sin(a) * r], i * 3);
      seed.set([rnd(), rnd(), rnd(), rnd() ** 3], i * 4);
    }
    dustGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    dustGeo.setAttribute('seed', new THREE.BufferAttribute(seed, 4));
  }
  const dustMat = own(new THREE.ShaderMaterial({ vertexShader: DUST_VERT, fragmentShader: DUST_FRAG, glslVersion: THREE.GLSL3,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uScale: { value: 300 }, uMove: { value: 1 }, uColor: { value: new THREE.Color(0x7fefff) }, uOpacity: { value: 0.45 } } }));
  const dust = new THREE.Points(dustGeo, dustMat);
  dust.frustumCulled = false;
  scene.add(dust);

  // ---- arc reactor at the hub ----------------------------------------------------------------------------------
  const reactor = buildReactor();
  scene.add(reactor.group);
  function buildReactor() {
    const g = new THREE.Group();
    const arc = colorOf('arc');
    const mats = [];
    const m = (mat) => { mats.push(mat); return own(mat); };
    const add = (geo, mat, parent = g) => { const o = new THREE.Mesh(geo, mat); parent.add(o); return o; };
    const addLine = (geo, mat, parent = g) => { const o = new THREE.LineSegments(geo, mat); parent.add(o); return o; };
    // Floor emitter: rings, ticks, rotating arc segments.
    const floorG = new THREE.Group(); floorG.position.y = 0.03; g.add(floorG);
    add(ringGeo(2.6, 0.07), m(lightMat(arc, 0.9)), floorG);
    add(ringGeo(3.4, 0.025), m(lightMat(arc, 0.55)), floorG);
    addLine(ticksGeo(3.9, 0.22, 120, 10, 0.5), m(lineMat(arc, 0.55)), floorG);
    add(ringGeo(5.3, 0.02), m(lightMat(arc, 0.4)), floorG);
    addLine(dashGeo(6.3, 72, 0.45), m(lineMat(arc, 0.35)), floorG);
    const arcsA = new THREE.Group(); floorG.add(arcsA);
    for (const [s, l, w] of [[0, 0.7, 0.16], [2.6, 1.1, 0.16], [4.3, 0.25, 0.16]]) add(ringGeo(4.75, w, 48, s, l), m(lightMat(arc, 0.75)), arcsA);
    const arcsB = new THREE.Group(); floorG.add(arcsB);
    for (const [s, l] of [[1.2, 0.5], [4.9, 0.8]]) add(ringGeo(5.8, 0.06, 48, s, l), m(lightMat(arc, 0.6)), arcsB);
    // Light cone from the emitter up to the hologram, and the core column.
    const coneMat = m(beamMat(arc, 0.32, { bands: 0.6, up: 0 }));
    const cone = add(own(new THREE.CylinderGeometry(1.25, 2.6, 2.2, 64, 1, true)), coneMat); cone.position.y = 1.1;
    const columnMat = m(beamMat(arc, 0.5, { bands: 0.3 }));
    const column = add(own(new THREE.CylinderGeometry(0.16, 0.16, 12, 16, 1, true)), columnMat); column.position.y = 6;
    // The core: segmented coil ring, gimbal rings with ticks, a wire icosahedron and the glow.
    const core = new THREE.Group(); core.position.y = 2.6; g.add(core);
    const coil = new THREE.Group(); core.add(coil);
    const coilMat = m(lightMat(arc.clone(), 0.9));
    for (let i = 0; i < 10; i++) add(ringGeo(1.18, 0.34, 6, i / 10 * TAU + 0.05, TAU / 10 - 0.1), coilMat, coil);
    add(ringGeo(1.48, 0.03, 96), m(lightMat(arc, 0.9)), coil);
    const gimbalA = new THREE.Group(); gimbalA.rotation.x = rad(72); core.add(gimbalA);
    add(ringGeo(1.95, 0.035, 128), m(lightMat(arc, 0.7)), gimbalA);
    addLine(ticksGeo(2.05, 0.1, 72, 6, 0.24), m(lineMat(arc, 0.6)), gimbalA);
    const gimbalB = new THREE.Group(); gimbalB.rotation.z = rad(64); core.add(gimbalB);
    for (const [s, l] of [[0.3, 1.4], [3.4, 0.9]]) add(ringGeo(2.45, 0.07, 64, s, l), m(lightMat(arc, 0.7)), gimbalB);
    const ico = addLine(own(new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(0.62, 0))), m(lineMat(arc.clone().multiplyScalar(1.6), 0.9)), core);
    const heartMat = m(new THREE.SpriteMaterial({ map: glowTex, color: new THREE.Color(0xbff8ff).multiplyScalar(1.15), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    heartMat.userData.base = 1;
    const heart = new THREE.Sprite(heartMat); heart.scale.setScalar(1.6); core.add(heart);
    const auraMat = m(new THREE.SpriteMaterial({ map: glowTex, color: arc.clone(), transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false }));
    auraMat.userData.base = 0.45;
    const aura = new THREE.Sprite(auraMat); aura.scale.setScalar(9); core.add(aura);
    const halo = add(planeGeo, m(lightMat(arc, 0.35, { map: glowTex }))); halo.scale.setScalar(13); halo.position.y = 0.02;
    return { group: g, floorG, arcsA, arcsB, core, coil, gimbalA, gimbalB, ico, heart, aura, coilMat, coneMat, columnMat, mats, cone, column };
  }

  // ---- reconciled objects --------------------------------------------------------------------------------------
  const clusters = new Map();   // groupKey -> cluster record
  const nodes = new Map();      // entity key -> node record
  const links = new Map();      // link key -> link record
  const effects = [];           // transient pulses
  let model = null, world = null, lastSetSig = '';
  let selectedKey = null, selectedGroup = null, hoverKey = null;
  let discreet = false;
  let rect = { x: 0, y: 0, w: 1, h: 1 };
  let W = 0, H = 0, dpr = 1;
  let effectsOn = true;
  let quality = 0, qualityMode = 'auto';
  let t0 = performance.now(), now = 0;
  let openingAt = null, openingT = OPENING, openingFrozen = null;

  function buildCluster(key) {
    const g = new THREE.Group();
    const arc = colorOf('arc');
    const mats = [];
    const m = mat => { mats.push(mat); return mat; };
    const rec = { key, group: g, mats, R: 0, appear: 0, born: now };
    rec.base = new THREE.Mesh(ringGeo(1, 0.006, 160), m(lightMat(arc, 0.85)));
    rec.edgeMat = m(lightMat(arc, 0));
    rec.edge = new THREE.Mesh(ringGeo(1, 0.03, 160), rec.edgeMat);
    rec.fill = new THREE.Mesh(planeGeo, m(new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: UV_VERT, fragmentShader: FILL_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uColor: { value: arc.clone() }, uOpacity: { value: 0.08 } } })));
    rec.fill.material.userData.base = 0.08;
    rec.ticks = new THREE.LineSegments(ticksGeo(1.02, 0.025, 120, 10, 0.06), m(lineMat(arc, 0.5)));
    rec.orbit = new THREE.LineSegments(dashGeo(1, 64, 0.5, 0.82), m(lineMat(arc, 0.22)));
    rec.arcs = new THREE.Group();
    for (const [s, l] of [[0.4, 0.9], [3.6, 0.35]]) rec.arcs.add(new THREE.Mesh(ringGeo(1.1, 0.012, 48, s, l), m(lightMat(arc, 0.7))));
    rec.arcs2 = new THREE.Group();
    for (const [s, l] of [[2.0, 0.6], [5.1, 0.2]]) rec.arcs2.add(new THREE.Mesh(ringGeo(1.16, 0.005, 48, s, l), m(lightMat(arc, 0.5))));
    for (const o of [rec.base, rec.edge, rec.fill, rec.ticks, rec.arcs, rec.arcs2]) g.add(o);
    rec.spokeMat = m(new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: UV_VERT, fragmentShader: RIBBON_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, forceSinglePass: true,
      uniforms: { uColor: { value: arc.clone() }, uOpacity: { value: 0.8 }, uTime: { value: 0 }, uLen: { value: 10 }, uFlow: { value: 0 }, uGrow: { value: 1 } } }));
    rec.spokeMat.userData.base = 0.8;
    rec.spoke = new THREE.Mesh(own(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0.5, 0, 0)), rec.spokeMat);
    rec.spoke.position.y = 0.025;
    scene.add(g, rec.spoke, rec.orbit);
    return rec;
  }
  function placeCluster(rec, g) {
    const R = g.radius - 0.6;
    rec.R = R; rec.x = g.x; rec.z = g.z;
    rec.group.position.set(g.x, 0.02, g.z);
    for (const o of [rec.base, rec.edge, rec.ticks, rec.arcs, rec.arcs2]) o.scale.setScalar(R);
    rec.fill.scale.set(R * 2, 1, R * 2);
    rec.orbit.position.set(g.x, 0.03, g.z);
    rec.orbit.scale.setScalar(5.4);
    // Spoke from the reactor's outer ring to the cluster ring.
    const len = Math.hypot(g.x, g.z), from = 6.4, to = len - R * 1.12;
    rec.spoke.position.set(g.x / len * from, 0.025, g.z / len * from);
    rec.spoke.rotation.y = -Math.atan2(g.z, g.x);
    rec.spoke.scale.set(Math.max(0.1, to - from), 1, 0.14);
    rec.spokeMat.uniforms.uLen.value = to - from;
  }
  function dropCluster(rec) { scene.remove(rec.group, rec.spoke, rec.orbit); rec.mats.forEach(x => x.dispose()); }

  function buildNode(e) {
    const g = new THREE.Group();
    const rec = { key: e.key, group: g, state: null, mats: [], born: now, x: 0, z: 0, tx: 0, tz: 0, flash: 0, appear: 0, spin: Math.random() * TAU };
    const m = mat => { rec.mats.push(mat); return mat; };
    rec.pad = new THREE.Mesh(ringGeo(1, 0.12, 6, Math.PI / 6), m(lightMat(HEX.arc, 0.9)));
    rec.pad.position.y = 0.04;
    rec.padInner = new THREE.LineSegments(hexLineGeo(0.7, false), m(lineMat(HEX.arc, 0.35)));
    rec.padInner.position.y = 0.04;
    rec.dashed = new THREE.LineSegments(hexLineGeo(1, true), m(lineMat(HEX.arc, 0.8)));
    rec.dashed.position.y = 0.04;
    rec.pool = new THREE.Mesh(planeGeo, m(lightMat(HEX.arc, 0.32, { map: glowTex })));
    rec.pool.position.y = 0.015;
    rec.tether = new THREE.LineSegments(tetherGeo, m(lineMat(HEX.arc, 0.4)));
    rec.crystal = new THREE.LineSegments(crystalGeo, m(lineMat(HEX.arc, 1)));
    rec.face = new THREE.Mesh(crystalFaceGeo, m(lightMat(HEX.arc, 0.07)));
    const glowMat = m(new THREE.SpriteMaterial({ map: glowTex, color: new THREE.Color(HEX.arc), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
    rec.glow = new THREE.Sprite(glowMat);
    rec.spinner = new THREE.Group();
    rec.spinMat = m(lightMat(HEX.amber, 0.95));
    rec.spinner.add(new THREE.Mesh(ringGeo(1.3, 0.08, 32, 0, TAU * 0.28), rec.spinMat), new THREE.Mesh(ringGeo(1.3, 0.08, 16, Math.PI, TAU * 0.08), rec.spinMat));
    rec.spinner.position.y = 0.05;
    rec.ticks = new THREE.LineSegments(ticksGeo(1.42, 0.14, 24, 0, 0), m(lineMat(HEX.arc, 0.35)));
    rec.ticks.position.y = 0.04;
    rec.beamMat = m(beamMat(HEX.alert, 0.45, { bands: 0.5 }));
    rec.beam = new THREE.Mesh(cached('beamGeo', () => new THREE.CylinderGeometry(0.28, 0.28, 9, 20, 1, true).translate(0, 4.5, 0)), rec.beamMat);
    rec.ping = new THREE.Mesh(unitRing, m(lightMat(HEX.alert, 0.8)));
    rec.ping.position.y = 0.05;
    rec.ping2 = new THREE.Mesh(unitRing, m(lightMat(HEX.alert, 0.8)));
    rec.ping2.position.y = 0.05;
    g.add(rec.pad, rec.padInner, rec.dashed, rec.pool, rec.tether, rec.crystal, rec.face, rec.glow, rec.spinner, rec.ticks, rec.beam, rec.ping, rec.ping2);
    scene.add(g);
    return rec;
  }
  function styleNode(rec, e) {
    const look = LOOK[e.state] || LOOK.idle;
    rec.look = look;
    rec.state = e.state;
    rec.kind = e.kind;
    const col = colorOf(look.c);
    for (const mat of rec.mats) if (mat !== rec.beamMat && mat !== rec.ping.material && mat !== rec.ping2.material && mat !== rec.spinMat) (mat.color || mat.uniforms?.uColor?.value)?.copy(col);
    rec.spinMat.color.copy(col);
    const r = look.r;
    rec.r = r; rec.h = look.h;
    rec.pad.scale.setScalar(r);
    rec.padInner.scale.setScalar(r);
    rec.dashed.scale.setScalar(r);
    rec.pool.scale.setScalar(r * 4);
    rec.tether.scale.set(1, look.h - 0.5, 1);
    rec.tether.position.y = 0.05;
    const cs = e.kind === 'sub' || e.state === 'sub-done' ? 0.7 : e.state === 'needs-you' ? 1.2 : 1;
    rec.crystal.scale.setScalar(cs);
    rec.face.scale.setScalar(cs);
    rec.crystal.position.y = rec.face.position.y = rec.glow.position.y = look.h;
    rec.glow.scale.setScalar((e.kind === 'sub' ? 1.8 : 2.8) * (e.state === 'needs-you' ? 1.3 : 1));
    rec.spinner.scale.setScalar(r);
    rec.ticks.scale.setScalar(r);
    const sat = e.kind === 'sat', ended = e.state === 'ended';
    rec.pad.visible = !sat && !ended;
    rec.dashed.visible = sat || ended;
    rec.padInner.visible = !sat;
    rec.crystal.visible = rec.face.visible = !sat;
    rec.glow.visible = !ended;
    rec.tether.visible = !sat;
    rec.spinner.visible = e.state === 'working' || e.state === 'sub' || e.state === 'agents';
    rec.ticks.visible = e.state === 'working' || e.state === 'needs-you';
    rec.beam.visible = rec.ping.visible = rec.ping2.visible = e.state === 'needs-you';
  }
  function dropNode(rec) { scene.remove(rec.group); rec.mats.forEach(x => x.dispose()); }

  const linkMats = { delegation: own(lineMat(HEX.agent, 0.55)), done: own(lineMat(HEX.ok, 0.28)), shell: own(new THREE.LineDashedMaterial({ color: HEX.arc, dashSize: 0.5, gapSize: 0.35, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false })) };
  function linkCurve(a, b, ha, hb, lift = 1.1) {
    const p0 = new THREE.Vector3(a.x, ha, a.z), p2 = new THREE.Vector3(b.x, hb, b.z);
    const p1 = p0.clone().lerp(p2, 0.5); p1.y = Math.max(ha, hb) + lift;
    return new THREE.QuadraticBezierCurve3(p0, p1, p2);
  }

  // ---- data in -------------------------------------------------------------------------------------------------
  function setModel(nextModel, nextWorld) {
    model = nextModel; world = nextWorld;
    const visible = new Set(model.visible);
    const groupsShown = new Set();
    for (const key of model.visible) groupsShown.add(model.byKey.get(key).groupKey);
    for (const [key, rec] of clusters) if (!groupsShown.has(key)) { dropCluster(rec); clusters.delete(key); }
    for (const key of groupsShown) {
      const g = world.groups.get(key); if (!g) continue;
      let rec = clusters.get(key);
      if (!rec) { rec = buildCluster(key); clusters.set(key, rec); }
      const meta = model.groups.find(x => x.key === key);
      rec.working = meta ? meta.working : 0;
      rec.waiting = meta ? meta.waiting : 0;
      placeCluster(rec, g);
    }
    for (const [key, rec] of nodes) if (!visible.has(key)) { dropNode(rec); nodes.delete(key); }
    for (const key of model.visible) {
      const e = model.byKey.get(key), place = world.nodes.get(key);
      if (!place) continue;
      let rec = nodes.get(key);
      if (!rec) { rec = buildNode(e); nodes.set(key, rec); rec.x = rec.tx = place.x; rec.z = rec.tz = place.z; }
      rec.tx = place.x; rec.tz = place.z;
      rec.e = e;
      if (rec.state !== e.state || rec.kind !== e.kind) styleNode(rec, e);
    }
    // Links are rebuilt only when relationships or targets change.
    const wanted = new Set();
    for (const l of model.links) {
      if (!nodes.has(l.from) || !nodes.has(l.to)) continue;
      wanted.add(l.key);
      const to = model.byKey.get(l.to);
      const done = to.state === 'sub-done' || to.kind === 'sat';
      const a = nodes.get(l.from), b = nodes.get(l.to);
      const sig = `${a.tx},${a.tz},${b.tx},${b.tz},${done},${a.h},${b.h}`;
      let rec = links.get(l.key);
      if (rec && rec.sig === sig) { rec.to = l.to; continue; }
      if (rec) { scene.remove(rec.line); rec.line.geometry.dispose(); }
      const curve = l.kind === 'shell' ? linkCurve({ x: a.tx, z: a.tz }, { x: b.tx, z: b.tz }, 0.1, 0.1, 0.4) : linkCurve({ x: a.tx, z: a.tz }, { x: b.tx, z: b.tz }, a.h, b.h);
      const geo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(28));
      const line = l.kind === 'shell' ? new THREE.Line(geo, linkMats.shell) : new THREE.Line(geo, done ? linkMats.done : linkMats.delegation);
      if (l.kind === 'shell') line.computeLineDistances();
      scene.add(line);
      links.set(l.key, { key: l.key, line, curve, sig, from: l.from, to: l.to, kind: l.kind, running: to.state === 'sub', startedAt: to.sortKey });
    }
    for (const [key, rec] of links) if (!wanted.has(key)) { scene.remove(rec.line); rec.line.geometry.dispose(); links.delete(key); }
    // Flowing dots on the three newest running children only (DESIGN.md calm rule).
    const flowing = [...links.values()].filter(l => l.running && l.kind === 'delegation').sort((a, b) => b.startedAt - a.startedAt).slice(0, 3);
    for (const l of links.values()) l.flow = flowing.includes(l);
    const setSig = [...clusters.keys()].join('|') + '#' + [...nodes.keys()].join('|');
    if (setSig !== lastSetSig) { lastSetSig = setSig; if (!userMoved) needsFit = true; }
    labelsDirty = true;
  }

  /** A subagent or session finished: green ring at the node, a pulse travelling back to the parent. */
  function pulse(key) {
    const rec = nodes.get(key);
    if (!rec) return;
    rec.flash = 1;
    addEffect('ring', rec, HEX.ok, 1.3);
    const link = [...links.values()].find(l => l.to === key && l.kind === 'delegation');
    if (link) addEffect('return', link, HEX.ok, 0.75);
  }
  /** A tool call: a small ripple on the node. */
  function packet(key) {
    const rec = nodes.get(key);
    if (!rec) return;
    addEffect('ripple', rec, HEX[rec.look?.c] ?? HEX.amber, 0.7);
  }
  function addEffect(kind, target, color, dur) {
    if (effects.length > 24) return;
    const mat = lightMat(color, 1);
    let obj;
    if (kind === 'return') {
      const sm = new THREE.SpriteMaterial({ map: glowTex, color: new THREE.Color(color).multiplyScalar(2), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
      obj = new THREE.Sprite(sm); obj.scale.setScalar(1.6);
      mat.dispose();
      effects.push({ kind, target, obj, mat: sm, t0: now, dur });
    } else {
      obj = new THREE.Mesh(unitRing, mat);
      effects.push({ kind, target, obj, mat, t0: now, dur });
    }
    scene.add(obj);
  }

  // ---- camera ---------------------------------------------------------------------------------------------------
  const view = { az: HOME.az, elev: HOME.elev, zoom: 1, cx: 0, cz: 0, fit: 90 };
  let userMoved = false, needsFit = true, fitted = false, tween = null;
  const drift = { az: 0, elev: 0, dist: 0 }, parallax = { x: 0, y: 0, tx: 0, ty: 0 };
  const v3 = new THREE.Vector3();
  function applyCamera(distance, az = view.az, elev = view.elev) {
    const e = rad(clamp(elev, 5, 85)), a = rad(az);
    camera.position.set(view.cx + distance * Math.cos(e) * Math.sin(a), distance * Math.sin(e), view.cz + distance * Math.cos(e) * Math.cos(a));
    camera.lookAt(view.cx, 0, view.cz);
    camera.aspect = W / Math.max(1, H);
    // Centre the projection on the scene rectangle (left of the inspector, between the bars).
    camera.setViewOffset(W, H, W / 2 - (rect.x + rect.w / 2), H / 2 - (rect.y + rect.h / 2), W, H);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
  }
  function toScreen(x, y, z) {
    v3.set(x, y, z).project(camera);
    return { x: (v3.x + 1) / 2 * W, y: (1 - v3.y) / 2 * H, behind: v3.z > 1 };
  }
  function worldBounds() {
    const b = { minX: -7, maxX: 7, minZ: -7, maxZ: 7 };
    const grow = (x, z, r) => { b.minX = Math.min(b.minX, x - r); b.maxX = Math.max(b.maxX, x + r); b.minZ = Math.min(b.minZ, z - r); b.maxZ = Math.max(b.maxZ, z + r); };
    for (const c of clusters.values()) grow(c.x, c.z, c.R * 1.15);
    for (const n of nodes.values()) grow(n.tx, n.tz, 1.6);
    return b;
  }
  function fitDistance(b) {
    const save = { az: view.az, elev: view.elev, cx: view.cx, cz: view.cz };
    view.az = HOME.az; view.elev = HOME.elev; view.cx = (b.minX + b.maxX) / 2; view.cz = (b.minZ + b.maxZ) / 2;
    const pts = [];
    for (const x of [b.minX, b.maxX, view.cx]) for (const z of [b.minZ, b.maxZ, view.cz]) pts.push([x, 0, z], [x, 2.4, z]);
    pts.push([0, 4.6, 0]);
    const mx = 36, mt = 30, mb = 22;
    const fits = d => {
      applyCamera(d);
      for (const [x, y, z] of pts) {
        const p = toScreen(x, y, z);
        if (p.behind || p.x < rect.x + mx || p.x > rect.x + rect.w - mx || p.y < rect.y + mt || p.y > rect.y + rect.h - mb) return false;
      }
      return true;
    };
    let lo = 8, hi = 1500;
    for (let i = 0; i < 30 && hi - lo > 0.05; i++) { const mid = (lo + hi) / 2; if (fits(mid)) hi = mid; else lo = mid; }
    Object.assign(view, save);
    return hi;
  }
  function refit(animate) {
    if (!W || !H) return;
    const b = worldBounds();
    const target = { cx: (b.minX + b.maxX) / 2, cz: (b.minZ + b.maxZ) / 2, az: HOME.az, elev: HOME.elev, zoom: 1 };
    const fit = fitDistance(b);
    needsFit = false; fitted = true;
    if (animate && !motion.rm) tween = { from: { ...view }, to: { ...target, fit }, t0: now, dur: 0.6 };
    else Object.assign(view, target, { fit });
  }
  function stepTween() {
    if (!tween) return;
    const k = easeInOut((now - tween.t0) / tween.dur);
    for (const key of ['cx', 'cz', 'az', 'elev', 'zoom', 'fit']) view[key] = tween.from[key] + (tween.to[key] - tween.from[key]) * k;
    if (k >= 1) tween = null;
  }

  // ---- size --------------------------------------------------------------------------------------------------
  function resize() {
    const r = host.getBoundingClientRect();
    const w = Math.round(r.width), h = Math.round(r.height);
    const want = quality >= 2 ? 1 : Math.min(window.devicePixelRatio || 1, MAX_DPR);
    if (w === W && h === H && want === dpr) return false;
    W = w; H = h; dpr = want;
    renderer.setPixelRatio(dpr);
    renderer.setSize(W, H, false);
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    overlay.width = Math.round(W * dpr); overlay.height = Math.round(H * dpr);
    overlay.style.width = W + 'px'; overlay.style.height = H + 'px';
    post.setSize(canvas.width, canvas.height);
    dustMat.uniforms.uScale.value = 120 * dpr * (H / 900);
    needsFit = true;
    return true;
  }
  function setRect(next) {
    const changed = Math.abs(next.x - rect.x) + Math.abs(next.y - rect.y) + Math.abs(next.w - rect.w) + Math.abs(next.h - rect.h) > 0.5;
    rect = next;
    if (changed) { if (userMoved) { const keep = { ...view }; refit(false); Object.assign(view, { az: keep.az, elev: keep.elev, zoom: keep.zoom }); } else refit(fitted && !opening()); }
  }

  // ---- opening ---------------------------------------------------------------------------------------------------
  const opening = () => openingAt !== null && openingT < OPENING;
  function playOpening() {
    if (motion.rm || !effectsOn) { openingAt = null; openingT = OPENING; return false; }
    openingAt = now; openingT = 0; openingFrozen = null;
    for (const rec of nodes.values()) rec.typed = 0;
    labelsDirty = true;
    return true;
  }
  function skipOpening() { if (opening()) { openingT = OPENING; openingAt = null; labelsDirty = true; } }

  // ---- labels (HTML) -------------------------------------------------------------------------------------------
  const labelEls = new Map(), groupEls = new Map(), badgeEls = new Map();
  let labelsDirty = true, lastPlaced = new Map(), hiddenCount = 0;
  const reactorLabel = el('div', 'hr-core');
  const reactorNum = el('div', 'hr-num'), reactorWord = el('div', 'hr-word');
  reactorLabel.append(reactorNum, reactorWord);
  labels.append(reactorLabel);
  const reticle = el('div', 'h-reticle');
  reticle.innerHTML = '<i></i><i></i><i></i><i></i>';
  labels.append(reticle);
  const focusRing = el('div', 'h-focus');
  labels.append(focusRing);
  function el(tag, cls) { const x = document.createElement(tag); x.className = cls; return x; }
  function labelFor(key) {
    let rec = labelEls.get(key);
    if (rec) return rec;
    const root = el('div', 'hl');
    const title = el('div', 'hl-title'), row = el('div', 'hl-row');
    const icon = el('span', 'hl-icon'), word = el('span', 'hl-word'), tool = el('span', 'hl-tool'), time = el('span', 'hl-time');
    row.append(icon, word, tool, time);
    root.append(title, row);
    labels.append(root);
    rec = { root, title, icon, word, tool, time, glyph: null, text: '', last: '' };
    labelEls.set(key, rec);
    return rec;
  }
  function fillLabel(rec, e, typed = 1) {
    const t = textFor(e), st = STATE[e.state] || STATE.idle, look = LOOK[e.state] || LOOK.idle;
    const full = t.title || '';
    const shown = typed >= 1 ? full : full.slice(0, Math.ceil(full.length * typed)) + (typed > 0 ? '▍' : '');
    const detail = '';
    const sig = `${shown}|${st.word}|${detail}|${look.c}|${typed >= 1}`;
    if (sig === rec.text) return;
    rec.text = sig;
    rec.root.dataset.c = look.c;
    rec.root.dataset.s = e.state;
    if (rec.glyph !== st.glyph) { rec.glyph = st.glyph; rec.icon.replaceChildren(glyph(st.glyph)); }
    rec.title.textContent = shown;
    rec.word.textContent = typed >= 1 ? st.word : '';
    rec.tool.textContent = typed >= 1 ? detail : '';
  }
  function groupFor(key) {
    let rec = groupEls.get(key);
    if (rec) return rec;
    const root = el('div', 'hg'), name = el('div', 'hg-name'), counts = el('div', 'hg-counts');
    root.append(name, counts);
    labels.append(root);
    rec = { root, name, counts, last: '' };
    groupEls.set(key, rec);
    return rec;
  }
  const screen = new Map();
  function computeScreen() {
    screen.clear();
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    for (const [key, rec] of nodes) {
      const p = toScreen(rec.x, rec.h, rec.z);
      const q = toScreen(rec.x + right.x * rec.r * 1.25, rec.h, rec.z + right.z * rec.r * 1.25);
      const base = toScreen(rec.x, 0, rec.z);
      screen.set(key, { x: p.x, y: p.y, r: Math.max(8, Math.hypot(q.x - p.x, q.y - p.y)), bx: base.x, by: base.y, behind: p.behind });
    }
  }
  function placeAll(fmtTime) {
    const blocks = [];
    // Reactor number.
    const rp = toScreen(0, 0, 8.2);
    const reactorBox = { x: rp.x - 90, y: rp.y, w: 180, h: 52 };
    reactorLabel.style.transform = `translate(${rp.x.toFixed(1)}px,${rp.y.toFixed(1)}px) translate(-50%,0)`;
    blocks.push(reactorBox);
    // Project names at the front of each ring.
    const wantedGroups = new Set();
    const taken = [{ ...reactorBox }];
    const hits = b => taken.some(o => b.x < o.x + o.w + 6 && o.x < b.x + b.w + 6 && b.y < o.y + o.h + 4 && o.y < b.y + b.h + 4);
    const groupOrder = [...clusters.entries()].sort(([ka, a], [kb, b2]) => (kb === selectedGroup) - (ka === selectedGroup) || (b2.waiting || 0) - (a.waiting || 0) || (b2.z - a.z));
    for (const [key, c] of groupOrder) {
      wantedGroups.add(key);
      const rec = groupFor(key), meta = model.groups.find(x => x.key === key);
      const name = discreet ? textFor({ kind: 'group', groupKey: key }).group : key;
      const total = meta ? meta.sessions + meta.idleFolded : 0;
      const counts = meta ? [`${total} ${total === 1 ? 'session' : 'sessions'}`, meta.waiting ? `${meta.waiting} needs you` : '', meta.working ? `${meta.working} working` : '', meta.idleFolded ? `${meta.idleFolded} idle` : ''].filter(Boolean).join(' · ') : '';
      const sig = name + '|' + counts;
      if (rec.last !== sig) { rec.name.textContent = name; rec.counts.textContent = counts; rec.last = sig; }
      rec.root.classList.toggle('is-sel', key === selectedGroup);
      rec.root.classList.toggle('is-dim', !!selectedGroup && key !== selectedGroup);
      rec.root.dataset.wait = meta?.waiting ? '1' : '';
      // Front of the ring first, then behind it; with neither free, the name alone at the front.
      const front = toScreen(c.x, 0, c.z + c.R * 1.16), back = toScreen(c.x, 0, c.z - c.R * 1.12);
      const full = Math.max(name.length * 10 + 24, counts.length * 6.6 + 16), short = name.length * 10 + 24;
      const box = (p, w, hh, above) => ({ x: clamp(p.x - w / 2, rect.x + 4, rect.x + rect.w - w - 4), y: clamp(above ? p.y - hh - 2 : p.y + 2, rect.y + 4, rect.y + rect.h - hh - 4), w, h: hh });
      let pick = [box(front, full, 34, false), box(back, full, 34, true)].find(b => !hits(b));
      let compact = false;
      if (!pick) { compact = true; pick = [box(front, short, 16, false), box(back, short, 16, true)].find(b => !hits(b)) || box(front, short, 16, false); }
      taken.push(pick);
      rec.counts.hidden = compact;
      const { x, y, w, h: hgt } = pick;
      rec.root.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`;
      rec.root.style.width = w + 'px';
      const appear = clusterAppear(c);
      rec.root.style.opacity = appear < 1 ? appear.toFixed(2) : '';
      blocks.push({ x: x - rect.x, y: y - rect.y, w, h: hgt });
    }
    for (const [key, rec] of groupEls) if (!wantedGroups.has(key)) { rec.root.remove(); groupEls.delete(key); }
    reactorBox.x -= rect.x; reactorBox.y -= rect.y;
    // Node labels: the shared placement from layout.mjs, in scene-rectangle coordinates.
    const items = [];
    for (const key of model.visible) {
      const s = screen.get(key), e = model.byKey.get(key), rec = nodes.get(key);
      if (!s || !rec || s.behind) continue;
      const prio = key === selectedKey ? 0 : e.state === 'needs-you' ? 1 : e.tool && e.state === 'working' ? 2 : STATE[e.state]?.prio ?? 6;
      const t = textFor(e);
      items.push({ key, x: s.x - rect.x, y: s.y - rect.y, r: s.r, w: Math.min(204, Math.round(estimateLabelWidth(t.title, e.state) * 1.16)), prio, must: e.state === 'needs-you', selected: key === selectedKey, label: e.kind !== 'sat' && rec.appear > 0.6 });
    }
    const result = placeLabels(items, { w: rect.w, h: rect.h }, blocks);
    hiddenCount = result.hidden.length;
    const keep = new Set(result.placed.keys());
    for (const [key, rec] of labelEls) if (!keep.has(key)) rec.root.hidden = true;
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2d.clearRect(0, 0, W, H);
    for (const [key, box] of result.placed) {
      const e = model.byKey.get(key), rec = labelFor(key), node = nodes.get(key), s = screen.get(key);
      const typed = opening() ? span(openingT, 1.55 + (node.typeDelay || 0), 2.15 + (node.typeDelay || 0)) : 1;
      fillLabel(rec, e, typed);
      rec.root.hidden = false;
      const op8 = typed > 0 ? (typed < 1 ? 0.9 : 1) : 0;
      if (rec.op !== op8) { rec.root.style.opacity = op8 === 1 ? '' : String(op8); rec.op = op8; }
      const x = box.x + rect.x, y = box.y + rect.y;
      const tr = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`;
      if (rec.last !== tr) { rec.root.style.transform = tr; rec.last = tr; }
      rec.root.style.width = box.w + 'px';
      rec.root.dataset.side = box.side;
      rec.root.classList.toggle('is-sel', key === selectedKey);
      rec.root.classList.toggle('is-hover', key === hoverKey);
      rec.root.classList.toggle('is-dim', !!selectedGroup && e.groupKey !== selectedGroup && e.state !== 'needs-you');
      const time = fmtTime(e);
      const recent = e.endedAt && (Date.now() - e.endedAt) < 15 * 60_000;
      const shownTime = typed >= 1 && (e.state === 'needs-you' || ((e.state === 'done' || e.state === 'sub-done') && recent)) ? time : '';
      if (rec.time.textContent !== shownTime) rec.time.textContent = shownTime;
      // Leader: from the crystal to the nearest point of the label's edge, with a short elbow.
      drawLeader(s, { x, y, w: box.w, h: 38 }, LOOK[e.state]?.c || 'arc', typed, !!selectedGroup && e.groupKey !== selectedGroup && e.state !== 'needs-you');
    }
    for (const key of [...labelEls.keys()]) if (!nodes.has(key)) { labelEls.get(key).root.remove(); labelEls.delete(key); }
    // Folded groups: a "+n" count on the dashed pad.
    const sats = new Set();
    for (const key of model.visible) {
      const e = model.byKey.get(key), s = screen.get(key);
      if (e.kind !== 'sat' || !s) continue;
      sats.add(key);
      let b = badgeEls.get(key);
      if (!b) { b = el('div', 'h-badge'); labels.append(b); badgeEls.set(key, b); }
      b.textContent = `+${e.count}`;
      b.style.transform = `translate(${s.bx.toFixed(1)}px,${s.by.toFixed(1)}px) translate(-50%,-50%)`;
      b.style.opacity = String(nodes.get(key).appear);
    }
    for (const [key, b] of badgeEls) if (!sats.has(key)) { b.remove(); badgeEls.delete(key); }
    // Selection reticle and keyboard focus ring (HTML, so the brackets stay pixel-crisp).
    const sel = selectedKey && screen.get(selectedKey);
    reticle.hidden = !sel;
    if (sel) { const size = Math.max(34, sel.r * 2.6); reticle.style.transform = `translate(${sel.x.toFixed(1)}px,${sel.y.toFixed(1)}px) translate(-50%,-50%)`; reticle.style.width = reticle.style.height = size + 'px'; }
    const foc = focusKey && screen.get(focusKey);
    focusRing.hidden = !foc;
    if (foc) { const size = Math.max(30, foc.r * 2.2); focusRing.style.transform = `translate(${foc.x.toFixed(1)}px,${foc.y.toFixed(1)}px) translate(-50%,-50%)`; focusRing.style.width = focusRing.style.height = size + 'px'; }
  }
  const CSS_COL = { arc: '41,230,255', amber: '255,181,71', alert: '255,77,94', ok: '77,255,166', agent: '178,140,255', dim: '109,130,150' };
  function drawLeader(s, box, c, typed, dim) {
    const cx = clamp(s.x, box.x, box.x + box.w), cy = clamp(s.y, box.y, box.y + box.h);
    const anchorX = s.x < box.x ? box.x : s.x > box.x + box.w ? box.x + box.w : cx;
    const anchorY = s.x >= box.x && s.x <= box.x + box.w ? (s.y < box.y ? box.y : box.y + box.h) : box.y + 13;
    const dx = anchorX - s.x, dy = anchorY - s.y, d = Math.hypot(dx, dy);
    if (d < s.r * 0.9 + 4) return;
    const sx = s.x + dx / d * (s.r * 0.55), sy = s.y + dy / d * (s.r * 0.55);
    ctx2d.strokeStyle = `rgba(${CSS_COL[c]},${(dim ? 0.18 : 0.5) * typed})`;
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    ctx2d.moveTo(sx, sy);
    // Elbow: go diagonally, then flat into the label.
    const ex = anchorX - Math.sign(dx || 1) * Math.min(10, Math.abs(dx) * 0.4);
    ctx2d.lineTo(ex, anchorY);
    ctx2d.lineTo(anchorX, anchorY);
    ctx2d.stroke();
    ctx2d.fillStyle = `rgba(${CSS_COL[c]},${(dim ? 0.3 : 0.9) * typed})`;
    ctx2d.fillRect(sx - 1.5, sy - 1.5, 3, 3);
  }

  // ---- frame ---------------------------------------------------------------------------------------------------
  let rafId = 0, running = true, frames = 0, lastFrame = 0;
  let focusKey = null;
  const samples = [];   // rAF intervals
  const seg = { update: [], render: [], labels: [] };
  const cpu = [];
  let recording = null;
  let fmtTime = () => '';
  const clusterAppear = c => opening() ? ease(span(openingT, 0.55 + (c.order || 0) * 0.09, 1.15 + (c.order || 0) * 0.09)) : 1;

  function frame(time) {
    rafId = 0;
    if (!running || document.hidden) return;
    const started = performance.now();
    if (lastFrame) {
      const dt = time - lastFrame;
      samples.push(dt); if (samples.length > 240) samples.shift();
      if (recording) recording.intervals.push(dt);
    }
    lastFrame = time;
    const prevNow = now;
    now = (performance.now() - t0) / 1000;
    const dt = Math.min(0.1, now - prevNow);
    if (openingAt !== null) {
      openingT = openingFrozen ?? (now - openingAt);
      if (openingT >= OPENING && openingFrozen === null) { openingAt = null; openingT = OPENING; }
    }
    resize();
    if (!W || !H || !model) { schedule(); return; }
    if (needsFit && !userMoved) refit(fitted && !opening());
    stepTween();
    const ambient = effectsOn && !motion.rm;
    const at = ambient ? now : 0;
    const op = opening() ? openingT : OPENING;

    // Camera: home, slow drift, gentle mouse parallax; the opening flies in from higher and to the side.
    parallax.x += (parallax.tx - parallax.x) * Math.min(1, dt * 2.5);
    parallax.y += (parallax.ty - parallax.y) * Math.min(1, dt * 2.5);
    if (ambient && !recording?.manual) { drift.az = Math.sin(at * TAU / 48) * 6 + parallax.x * 2.5; drift.elev = Math.sin(at * TAU / 33) * 2.2 - parallax.y * 1.6; drift.dist = Math.sin(at * TAU / 27) * 0.018; }
    else { drift.az = drift.elev = drift.dist = 0; }
    const fly = 1 - easeInOut(span(op, 0, OPENING));
    const az = view.az + drift.az + (userMoved ? 0 : -32 * fly);
    const elev = view.elev + drift.elev + (userMoved ? 0 : 30 * fly);
    const dist = view.fit / view.zoom * (1 + drift.dist + 0.55 * fly);
    applyCamera(dist, az, elev);

    // Floor.
    const fu = floorMat.uniforms;
    fu.uTime.value = at;
    fu.uSweep.value = ambient ? (now * TAU / 8) % TAU : 0;
    fu.uSweepOn.value = ambient ? (opening() ? span(op, 1.9, OPENING) : 1) : 0;
    fu.uReveal.value = opening() ? ease(span(op, 0, 1.1)) * 150 : 400;
    fu.uEdge.value = opening() ? (1 - span(op, 0.9, 1.4)) : 0;
    const b = worldBounds();
    fu.uFocus.value.set((b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2, Math.max(60, (b.maxX - b.minX) * 0.95));
    const scanK = span(op, 0.95, 1.85);
    const scanZ = b.minZ - 6 + (b.maxZ - b.minZ + 12) * easeInOut(scanK);
    fu.uScanOn.value = opening() && scanK > 0 && scanK < 1 ? Math.sin(scanK * Math.PI) : 0;
    fu.uScanZ.value = scanZ;
    const selC = selectedGroup && clusters.get(selectedGroup);
    fu.uSel.value.set(selC ? selC.x : 0, selC ? selC.z : 0, selC ? selC.R : 0);

    // Dust.
    dustMat.uniforms.uTime.value = now;
    dustMat.uniforms.uMove.value = ambient ? 1 : 0;
    dust.visible = quality < 3;
    dustMat.uniforms.uOpacity.value = 0.45 * (opening() ? span(op, 0.4, 1.6) : 1);

    // Reactor.
    const anyWait = model.entities.some(e => e.state === 'needs-you');
    const ignite = opening() ? span(op, 0.12, 0.7) : 1;
    const spinBoost = opening() ? 1 + 14 * (1 - ease(span(op, 0.15, 1.6))) : 1;
    const rs = (ambient || opening() ? 1 : 0) * dt * spinBoost;
    reactor.arcsA.rotation.y += rs * 0.18;
    reactor.arcsB.rotation.y -= rs * 0.11;
    reactor.coil.rotation.y += rs * 0.45;
    reactor.gimbalA.rotation.y -= rs * 0.3;
    reactor.gimbalB.rotation.x += rs * 0.22;
    reactor.ico.rotation.y += rs * 0.5; reactor.ico.rotation.x += rs * 0.2;
    const heartbeat = ambient ? Math.max(0, Math.sin(now * TAU / 5)) ** 12 * 0.35 : 0;
    const breathe = anyWait && !motion.rm ? 0.5 + 0.5 * Math.sin(now * TAU / 1.6) : anyWait ? 1 : 0;
    reactor.coilMat.color.set(anyWait ? HEX.alert : HEX.arc).multiplyScalar(anyWait ? 0.8 + 0.6 * breathe : 1.0);
    const flare = opening() ? Math.max(0, 1 - Math.abs(op - 0.42) / 0.3) : 0;
    reactor.heart.scale.setScalar(1.6 * (0.2 + 0.8 * ease(ignite)) * (1 + heartbeat + flare * 1.6));
    reactor.aura.scale.setScalar(9 * (0.3 + 0.7 * ease(ignite)) * (1 + flare * 0.8));
    reactor.core.scale.setScalar(0.4 + 0.6 * ease(ignite));
    reactor.floorG.scale.setScalar(0.3 + 0.7 * ease(span(op, 0.05, 0.6)));
    for (const mat of reactor.mats) {
      const base = mat.userData.base ?? 1;
      if (mat.uniforms?.uOpacity) { mat.uniforms.uOpacity.value = base * ease(ignite); mat.uniforms.uTime.value = now; }
      else mat.opacity = base * ease(ignite) * (selectedGroup ? 0.75 : 1);
    }

    // Clusters.
    let order = 0;
    const sorted = [...clusters.values()].sort((a, b2) => Math.hypot(a.x, a.z) - Math.hypot(b2.x, b2.z));
    for (const c of sorted) {
      c.order = order++;
      const appear = clusterAppear(c);
      const isSel = c.key === selectedGroup, dim = selectedGroup && !isSel ? 0.42 : 1;
      const lit = isSel ? 2.1 : 1;
      c.group.scale.setScalar(0.75 + 0.25 * appear);
      c.arcs.rotation.y += (ambient || opening() ? 1 : 0) * dt * (isSel ? 0.5 : 0.12) * (opening() ? 1 + 10 * (1 - appear) : 1);
      c.arcs2.rotation.y -= (ambient || opening() ? 1 : 0) * dt * (isSel ? 0.35 : 0.08);
      for (const mat of c.mats) {
        const base = mat.userData.base ?? 1;
        const v = base * appear * dim * (mat === c.spokeMat ? (isSel ? 1.8 : 1) : lit);
        if (mat.uniforms?.uOpacity) mat.uniforms.uOpacity.value = v; else mat.opacity = Math.min(1, v);
      }
      c.edgeMat.opacity = isSel ? 0.55 * appear : 0;
      const su = c.spokeMat.uniforms;
      su.uTime.value = now;
      su.uFlow.value = (c.working || isSel) && !motion.rm ? 1 : 0;
      su.uGrow.value = opening() ? ease(span(op, 0.5 + c.order * 0.09, 1.0 + c.order * 0.09)) : 1;
      su.uColor.value.set(c.waiting ? HEX.alert : HEX.arc);
    }

    // Nodes.
    let idx = 0;
    for (const [key, rec] of nodes) {
      rec.x += (rec.tx - rec.x) * Math.min(1, dt * 6);
      rec.z += (rec.tz - rec.z) * Math.min(1, dt * 6);
      rec.group.position.set(rec.x, 0, rec.z);
      const e = rec.e, look = rec.look;
      // Opening: materialise when the scan line passes; later arrivals fade in over 0.5 s.
      let appear = 1;
      if (opening()) appear = span(scanZ, rec.z - 1.5, rec.z + 2.5) * (scanK > 0 ? 1 : 0);
      else appear = span(now, rec.born, rec.born + 0.5);
      if (opening() && openingT < 1.0) appear = 0;
      const flicker = appear > 0 && appear < 1 ? (Math.sin(now * 90 + idx) > 0 ? 1 : 0.35) : 1;
      rec.appear = appear;
      rec.typeDelay = Math.min(0.3, idx * 0.012);
      idx++;
      const isSelGroup = !selectedGroup || e.groupKey === selectedGroup;
      const dim = isSelGroup || e.state === 'needs-you' ? 1 : 0.38;   // needs-you is never dimmed
      const sweepPing = ambient ? sweepHit(rec.x, rec.z, now) : 0;
      rec.flash = Math.max(0, rec.flash - dt / 1.4);
      const wait = e.state === 'needs-you';
      const breatheN = wait ? (motion.rm ? 1 : 0.55 + 0.45 * Math.sin(now * TAU / 1.6)) : 1;
      const k = look.k * appear * flicker * dim * (wait ? 0.75 + 0.5 * breatheN : 1) * (1 + sweepPing * 0.6 + rec.flash * 1.2) * (key === hoverKey ? 1.3 : 1) * (key === selectedKey ? 1.25 : 1);
      for (const mat of rec.mats) {
        const base = mat.userData.base ?? 1;
        if (mat.uniforms?.uOpacity) mat.uniforms.uOpacity.value = base * k;
        else mat.opacity = Math.min(1, base * k);
      }
      if (rec.flash > 0) { const okc = colorOf('ok'); rec.glow.material.color.copy(colorOf(look.c)).lerp(okc, rec.flash); }
      rec.group.scale.setScalar(0.6 + 0.4 * ease(appear));
      rec.crystal.rotation.y = rec.face.rotation.y = (rec.spin += dt * (ambient ? 0.6 : 0));
      const bob = ambient ? Math.sin(now * 1.3 + idx * 1.7) * 0.06 : 0;
      rec.crystal.position.y = rec.face.position.y = rec.glow.position.y = rec.h + bob;
      if (rec.spinner.visible) rec.spinner.rotation.y -= dt * (motion.rm ? 0 : 3.2);
      if (rec.ticks.visible) rec.ticks.rotation.y += dt * (motion.rm ? 0 : 0.4);
      if (wait) {
        rec.beamMat.uniforms.uTime.value = now;
        const cyc = motion.rm ? 0.35 : (now % 1.6) / 1.6, cyc2 = motion.rm ? 0.7 : ((now + 0.8) % 1.6) / 1.6;
        rec.ping.scale.setScalar(rec.r * (1.15 + cyc * 1.9)); rec.ping.material.opacity = (1 - cyc) * 0.85 * appear * dim;
        rec.ping2.scale.setScalar(rec.r * (1.15 + cyc2 * 1.9)); rec.ping2.material.opacity = (1 - cyc2) * 0.85 * appear * dim;
      }
    }
    // Links: dim with their cluster, flowing dots on the newest running children.
    for (const l of links.values()) {
      const to = nodes.get(l.to);
      l.line.visible = !!to && to.appear > 0.2;
    }
    const linkDim = selectedGroup ? 0.5 : 1;
    linkMats.delegation.opacity = 0.55 * linkDim * (opening() ? span(op, 1.4, 2.0) : 1);
    linkMats.done.opacity = 0.28 * linkDim * (opening() ? span(op, 1.4, 2.0) : 1);
    updateFlows();
    updateEffects();

    const tA = performance.now();
    // Render with bloom.
    const bloomFlash = opening() ? Math.max(0, 1 - Math.abs(op - 0.4) / 0.25) * 0.12 : 0;
    if (OFF.size) { floor.visible = !OFF.has('floor'); if (OFF.has('dust')) dust.visible = false; for (const r of nodes.values()) r.pool.visible = !OFF.has('pools'); for (const c of clusters.values()) c.fill.visible = !OFF.has('fill'); }
    post.render(scene, camera, { time: now, strength: 1.25, flash: bloomFlash, effects: ambient });
    frames++;
    const tB = performance.now();

    // HTML labels and the leader overlay.
    computeScreen();
    placeAll(fmtTime);
    const count = model.entities.filter(e => e.state === 'working' || e.state === 'needs-you' || e.state === 'sub').length;
    reactorNum.textContent = String(opening() ? Math.round(count * ease(span(op, 0.6, 1.6))) : count);
    reactorWord.textContent = anyWait ? 'AGENTS WORKING · 1 NEEDS YOU'.replace('1', String(model.entities.filter(e => e.state === 'needs-you').length)) : 'AGENTS WORKING';
    reactorLabel.dataset.wait = anyWait ? '1' : '';
    reactorLabel.style.opacity = String(ease(span(op, 0.5, 1.2)) * (selectedGroup ? 0.6 : 1));
    const tC = performance.now();
    seg.update.push(tA - started); seg.render.push(tB - tA); seg.labels.push(tC - tB);
    for (const l of Object.values(seg)) if (l.length > 240) l.shift();
    cpu.push(performance.now() - started); if (cpu.length > 240) cpu.shift();
    if (recording) recording.cpu.push(performance.now() - started);
    autoQuality();
    if (onFrame) onFrame({ opening: opening(), t: openingT });
    schedule();
  }
  let onFrame = null;
  const flowSprites = [];
  function updateFlows() {
    let i = 0;
    for (const l of links.values()) {
      if (!l.flow || motion.rm || !l.line.visible) continue;
      for (let d = 0; d < 2; d++) {
        let s = flowSprites[i];
        if (!s) {
          s = new THREE.Sprite(own(new THREE.SpriteMaterial({ map: glowTex, color: new THREE.Color(HEX.agent).multiplyScalar(1.8), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })));
          s.scale.setScalar(0.7); scene.add(s); flowSprites.push(s);
        }
        const k = ((now / 1.5) + d * 0.5) % 1;
        l.curve.getPoint(k, s.position);
        s.material.opacity = Math.sin(k * Math.PI) * (selectedGroup && nodes.get(l.to)?.e.groupKey !== selectedGroup ? 0.3 : 1);
        s.visible = true;
        i++;
      }
    }
    for (; i < flowSprites.length; i++) flowSprites[i].visible = false;
  }
  function updateEffects() {
    for (let i = effects.length - 1; i >= 0; i--) {
      const fx = effects[i], k = (now - fx.t0) / fx.dur;
      if (k >= 1 || (fx.kind !== 'return' && !nodes.has(fx.target.key))) {
        scene.remove(fx.obj); fx.mat.dispose(); effects.splice(i, 1);
        if (fx.kind === 'return' && k >= 1) { const parent = nodes.get(fx.target.from); if (parent) { parent.flash = 0.8; addEffect('ring', parent, HEX.ok, 0.9); } }
        continue;
      }
      if (fx.kind === 'return') { fx.target.curve.getPoint(1 - ease(k), fx.obj.position); fx.mat.opacity = 1; }
      else {
        const n = fx.target;
        fx.obj.position.set(n.x, 0.06, n.z);
        const grow = fx.kind === 'ring' ? 1 + ease(k) * 3.2 : 1 + ease(k) * 1.4;
        fx.obj.scale.setScalar(n.r * grow);
        fx.mat.opacity = (1 - k) * (fx.kind === 'ring' ? 1 : 0.6);
      }
    }
  }
  function sweepHit(x, z, t) {
    const sweep = (t * TAU / 8) % TAU;
    let a = Math.atan2(z, x); if (a < 0) a += TAU;
    const behind = ((sweep - a) % TAU + TAU) % TAU;
    return behind < 0.5 ? (1 - behind / 0.5) : 0;
  }
  function schedule() { if (!rafId && running) rafId = requestAnimationFrame(frame); }

  // ---- automatic quality: step down, never to the old look -------------------------------------------------------
  let qualityCheckAt = 0;
  function autoQuality() {
    if (qualityMode !== 'auto' || recording || opening() || now < 3) return;
    if (now - qualityCheckAt < 2) return;
    qualityCheckAt = now;
    const p = pct(samples.slice(-90), 0.95);
    if (p > 34 && quality < 3) setQuality(quality + 1);   // the 33 ms budget, past the 2-vsync line
  }
  function setQuality(level) {
    quality = clamp(level, 0, 3);
    post.setQuality(Math.min(2, quality));
    resize();
  }

  // ---- pointer -----------------------------------------------------------------------------------------------------
  const pointers = new Map();
  let drag = null;
  const ac = new AbortController();
  const on = (t, type, fn, o) => t.addEventListener(type, fn, { ...o, signal: ac.signal });
  const localPt = ev => { const r = host.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
  function pick(x, y) {
    let best = null, bestD = Infinity;
    for (const [key, s] of screen) {
      const d = Math.min(Math.hypot(s.x - x, s.y - y), Math.hypot(s.bx - x, s.by - y));
      if (d <= Math.max(22, s.r * 1.3) && d < bestD) { best = key; bestD = d; }
    }
    return best;
  }
  on(host, 'pointerdown', ev => {
    if (ev.button > 0) return;
    pointers.set(ev.pointerId, localPt(ev));
    try { host.setPointerCapture(ev.pointerId); } catch { /* optional */ }
    drag = { id: ev.pointerId, sx: ev.clientX, sy: ev.clientY, lx: ev.clientX, ly: ev.clientY, moved: false };
  });
  on(host, 'pointermove', ev => {
    const p = localPt(ev);
    parallax.tx = clamp((p.x - W / 2) / (W / 2), -1, 1); parallax.ty = clamp((p.y - H / 2) / (H / 2), -1, 1);
    if (drag && drag.id === ev.pointerId) {
      const dx = ev.clientX - drag.lx, dy = ev.clientY - drag.ly;
      if (!drag.moved && Math.hypot(ev.clientX - drag.sx, ev.clientY - drag.sy) >= 6) drag.moved = true;
      if (drag.moved) { tween = null; userMoved = true; view.az = clamp(view.az - dx * 0.3, -AZ_LIMIT, AZ_LIMIT); view.elev = clamp(view.elev + dy * 0.25, ELEV.min, ELEV.max); }
      drag.lx = ev.clientX; drag.ly = ev.clientY;
    } else if (ev.pointerType === 'mouse') {
      const k = pick(p.x, p.y);
      if (k !== hoverKey) { hoverKey = k; host.style.cursor = k ? 'pointer' : ''; }
    }
  });
  const end = (ev, cancelled) => {
    if (!pointers.has(ev.pointerId)) return;
    pointers.delete(ev.pointerId);
    const was = drag && drag.id === ev.pointerId ? drag : null;
    drag = null;
    if (was && !was.moved && !cancelled) { const p = localPt(ev); onPick(pick(p.x, p.y)); }
  };
  on(host, 'pointerup', ev => end(ev, false));
  on(host, 'pointercancel', ev => end(ev, true));
  on(host, 'wheel', ev => { ev.preventDefault(); tween = null; userMoved = true; view.zoom = clamp(view.zoom * Math.exp(-ev.deltaY * 0.0015), ZOOM.min, ZOOM.max); }, { passive: false });
  on(document, 'visibilitychange', () => { if (!document.hidden) { lastFrame = 0; schedule(); } });
  on(canvas, 'webglcontextlost', ev => { ev.preventDefault(); running = false; });

  const pct = (list, q) => { if (!list.length) return 0; const s = list.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
  const summary = list => ({ n: list.length, over33: +(list.filter(x => x > 34).length / Math.max(1, list.length) * 100).toFixed(1), mean: +(list.reduce((a, b) => a + b, 0) / Math.max(1, list.length)).toFixed(2), p50: +pct(list, 0.5).toFixed(2), p95: +pct(list, 0.95).toFixed(2), p99: +pct(list, 0.99).toFixed(2), max: +Math.max(0, ...list).toFixed(2) });
  let rendererName = null;
  function glRenderer() {
    if (rendererName) return rendererName;
    try { const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info'); rendererName = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); return rendererName; } catch { return null; }
  }

  resize();
  schedule();

  return {
    setModel, pulse, packet, setRect, playOpening, skipOpening,
    opening,
    setOpeningTime(t) { openingAt = now; openingFrozen = t; openingT = t; },
    releaseOpening() { openingFrozen = null; openingAt = null; openingT = OPENING; },
    setSelected(key, groupKey) { selectedKey = key; selectedGroup = key ? groupKey : null; },
    setFocus(key) { focusKey = key; },
    setDiscreet(on) { discreet = on; for (const rec of labelEls.values()) rec.text = ''; for (const rec of groupEls.values()) rec.last = ''; },
    setEffects(on) { effectsOn = on; if (!on) skipOpening(); },
    setTimeFormatter(fn) { fmtTime = fn; },
    setQualityMode(mode) { qualityMode = mode; if (mode !== 'auto') setQuality(Number(mode)); },
    onFrame(fn) { onFrame = fn; },
    reset() { userMoved = false; tween = null; refit(true); },
    orbitBy(daz, delev) { tween = null; userMoved = true; view.az = clamp(view.az + daz, -AZ_LIMIT, AZ_LIMIT); view.elev = clamp(view.elev + delev, ELEV.min, ELEV.max); },
    zoomBy(f) { tween = null; userMoved = true; view.zoom = clamp(view.zoom * f, ZOOM.min, ZOOM.max); },
    screenOf: key => screen.get(key) || null,
    viewInfo: () => ({ view: { ...view }, interval: summary(samples), quality }),
    /** Orbit the dense scene programmatically for `seconds` and report rAF interval percentiles. */
    async benchOrbit(seconds = 8) {
      const saved = { ...view, userMoved };
      recording = { intervals: [], cpu: [], manual: true };
      userMoved = true; tween = null;
      const start = performance.now();
      await new Promise(resolve => {
        const step = () => {
          const k = (performance.now() - start) / 1000;
          view.az = Math.sin(k * TAU / 4) * 55;
          view.elev = HOME.elev + Math.sin(k * TAU / 3) * 18;
          view.zoom = 1 + Math.sin(k * TAU / 5) * 0.25;
          if (k < seconds) requestAnimationFrame(step); else resolve();
        };
        requestAnimationFrame(step);
      });
      const out = { intervalMs: summary(recording.intervals.slice(5)), cpuMs: summary(recording.cpu.slice(5)) };
      recording = null;
      Object.assign(view, saved); userMoved = saved.userMoved;
      return out;
    },
    startRecording() { recording = { intervals: [], cpu: [], manual: false }; },
    stopRecording() { const r = recording; recording = null; return r ? { intervalMs: summary(r.intervals.slice(3)), cpuMs: summary(r.cpu.slice(3)) } : null; },
    stats: () => ({ frames, quality, qualityMode, dpr, size: [W, H], post: post.info(), renderer: glRenderer(), calls: renderer.info.render.calls, triangles: renderer.info.render.triangles,
      geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures, programs: renderer.info.programs?.length ?? 0,
      nodes: nodes.size, clusters: clusters.size, links: links.size, hiddenLabels: hiddenCount, opening: opening(), interval: summary(samples), cpu: summary(cpu), seg: { update: summary(seg.update), render: summary(seg.render), labels: summary(seg.labels) }, view: { ...view } }),
    dispose() {
      running = false; if (rafId) cancelAnimationFrame(rafId); ac.abort();
      for (const rec of nodes.values()) dropNode(rec);
      for (const rec of clusters.values()) dropCluster(rec);
      for (const rec of links.values()) rec.line.geometry.dispose();
      for (const fx of effects) fx.mat.dispose();
      reactor.mats.forEach(m => m.dispose());
      disposables.forEach(x => x.dispose?.());
      post.dispose(); renderer.dispose(); canvas.remove();
    },
  };
}

function makeGlowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.08, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.22, 'rgba(255,255,255,0.32)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.08)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}
