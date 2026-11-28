// Compact post-processing for the look study: a physically-styled bloom (downsample / tent upsample mip chain, as in
// "Next Generation Post Processing in Call of Duty", Jimenez 2014) and a film composite (vignette, faint scan lines,
// grain, a hint of chromatic fringe at the edges). Written for this study; nothing here is copied from three/examples.
//
// The scene renders into a multisampled half-float target, so thin lines stay antialiased and bright cores can go
// above 1.0 and feed the bloom. Colour management is off for the whole study: DESIGN.md hex values are used as-is.

const VERT = /* glsl */`
out vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const DOWN = /* glsl */`
precision highp float;
in vec2 vUv; out vec4 outColor;
uniform sampler2D src; uniform vec2 texel; uniform float threshold; uniform float knee; uniform bool prefilter;
vec3 s(vec2 o) { return texture(src, vUv + o * texel).rgb; }
void main() {
  // 13-tap downsample: a box of boxes, weighted so the result does not flicker as things move.
  vec3 a = s(vec2(-2, 2)), b = s(vec2(0, 2)), c = s(vec2(2, 2));
  vec3 d = s(vec2(-2, 0)), e = s(vec2(0, 0)), f = s(vec2(2, 0));
  vec3 g = s(vec2(-2, -2)), h = s(vec2(0, -2)), i = s(vec2(2, -2));
  vec3 j = s(vec2(-1, 1)), k = s(vec2(1, 1)), l = s(vec2(-1, -1)), m = s(vec2(1, -1));
  vec3 col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  if (prefilter) {
    // Soft-knee threshold on brightness, so the faint grid does not bloom but lines and cores do.
    float br = max(col.r, max(col.g, col.b));
    float soft = clamp(br - threshold + knee, 0.0, 2.0 * knee);
    soft = soft * soft / (4.0 * knee + 1e-4);
    col *= max(soft, br - threshold) / max(br, 1e-4);
  }
  outColor = vec4(max(col, vec3(0.0)), 1.0);
}`;

const UP = /* glsl */`
precision highp float;
in vec2 vUv; out vec4 outColor;
uniform sampler2D src; uniform vec2 texel; uniform float radius;
vec3 s(vec2 o) { return texture(src, vUv + o * texel * radius).rgb; }
void main() {
  // 9-tap tent filter.
  vec3 col = s(vec2(0)) * 4.0 + (s(vec2(-1, 0)) + s(vec2(1, 0)) + s(vec2(0, -1)) + s(vec2(0, 1))) * 2.0
           + s(vec2(-1, -1)) + s(vec2(1, -1)) + s(vec2(-1, 1)) + s(vec2(1, 1));
  outColor = vec4(col / 16.0, 1.0);
}`;

const COMPOSITE = /* glsl */`
precision highp float;
in vec2 vUv; out vec4 outColor;
uniform sampler2D scene; uniform sampler2D bloom; uniform float strength; uniform float time; uniform vec2 res;
uniform float scan; uniform float grain; uniform float flash; uniform float fringe; uniform float exposure;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec2 c = vUv - 0.5;
  float r2 = dot(c, c);
  // Chromatic fringe grows towards the edges only (film lens), invisible in the middle where people read.
  vec2 off = c * r2 * fringe;
  vec3 base = vec3(texture(scene, vUv + off).r, texture(scene, vUv).g, texture(scene, vUv - off).b);
  vec3 col = base * exposure + texture(bloom, vUv).rgb * strength;
  col += vec3(0.16, 0.9, 1.0) * flash;
  // Gentle shoulder: hot cores go white instead of clipping to a flat colour.
  col = col / (1.0 + max(vec3(0.0), col - 1.0) * 0.55);
  // Faint horizontal scan lines and one slow band moving down the screen.
  float line = 0.5 + 0.5 * sin(gl_FragCoord.y * 3.14159);
  float band = exp(-pow((fract(vUv.y - time * 0.045) - 0.5) * 9.0, 2.0));
  col *= 1.0 - scan * (0.5 - 0.5 * line);
  col += vec3(0.16, 0.9, 1.0) * band * scan * 0.18 * (0.4 + col.g);
  // Vignette to the void colour.
  float v = smoothstep(0.95, 0.18, r2 * 1.6);
  col = mix(vec3(0.016, 0.027, 0.051), col, 0.35 + 0.65 * v);
  col += (hash(gl_FragCoord.xy + fract(time) * 91.0) - 0.5) * grain;
  outColor = vec4(col, 1.0);
}`;

const MSAA = Number(new URLSearchParams(globalThis.location?.search || "").get("msaa") ?? 2);
export function createPost(THREE, renderer) {
  const gl = renderer.getContext();
  const isGL2 = renderer.capabilities.isWebGL2;
  const type = THREE.HalfFloatType;
  // The scene target is 8-bit: half the bandwidth of half-float under 4x MSAA on integrated GPUs. Hot cores clip at 1.0
  // and still feed the bloom, which runs in half-float.
  const sceneType = THREE.UnsignedByteType;
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  quad.frustumCulled = false;
  const qScene = new THREE.Scene(); qScene.add(quad);
  const qCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const mat = (frag, uniforms, extra = {}) => new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false, ...extra });
  const down = mat(DOWN, { src: { value: null }, texel: { value: new THREE.Vector2() }, threshold: { value: 0.42 }, knee: { value: 0.35 }, prefilter: { value: false } });
  const up = mat(UP, { src: { value: null }, texel: { value: new THREE.Vector2() }, radius: { value: 1 } },
    { blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation, transparent: true });
  const comp = mat(COMPOSITE, { scene: { value: null }, bloom: { value: null }, strength: { value: 1.0 }, time: { value: 0 }, res: { value: new THREE.Vector2() },
    scan: { value: 0.05 }, grain: { value: 0.018 }, flash: { value: 0 }, fringe: { value: 0.012 }, exposure: { value: 1 } });

  let sceneRT = null, mips = [], w = 0, h = 0, levels = 5, startDiv = 2, samples = isGL2 ? MSAA : 0;
  function makeTargets() {
    sceneRT?.dispose(); mips.forEach(m => m.dispose()); mips = [];
    sceneRT = new THREE.WebGLRenderTarget(w, h, { type: sceneType, samples, depthBuffer: true, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    let mw = Math.max(1, Math.floor(w / startDiv)), mh = Math.max(1, Math.floor(h / startDiv));
    for (let i = 0; i < levels; i++) {
      mips.push(new THREE.WebGLRenderTarget(mw, mh, { type, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }));
      mw = Math.max(1, mw >> 1); mh = Math.max(1, mh >> 1);
    }
  }
  function setSize(width, height) {
    if (width === w && height === h && sceneRT) return;
    w = width; h = height; makeTargets();
  }
  function pass(material, target) { quad.material = material; renderer.setRenderTarget(target); renderer.render(qScene, qCam); }

  function render(scene, camera, { time = 0, strength = 1, flash = 0, effects = true } = {}) {
    renderer.setRenderTarget(sceneRT);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);
    // Downsample chain.
    let src = sceneRT;
    for (let i = 0; i < mips.length; i++) {
      down.uniforms.src.value = src.texture;
      down.uniforms.texel.value.set(1 / src.width, 1 / src.height);
      down.uniforms.prefilter.value = i === 0;
      pass(down, mips[i]);
      src = mips[i];
    }
    // Upsample back, adding each level onto the next larger one.
    renderer.autoClear = false;
    for (let i = mips.length - 1; i > 0; i--) {
      up.uniforms.src.value = mips[i].texture;
      up.uniforms.texel.value.set(1 / mips[i].width, 1 / mips[i].height);
      pass(up, mips[i - 1]);
    }
    renderer.autoClear = true;
    comp.uniforms.scene.value = sceneRT.texture;
    comp.uniforms.bloom.value = mips[0].texture;
    comp.uniforms.strength.value = strength;
    comp.uniforms.time.value = time;
    comp.uniforms.flash.value = flash;
    comp.uniforms.scan.value = effects ? 0.05 : 0.03;
    comp.uniforms.grain.value = effects ? 0.018 : 0;
    comp.uniforms.res.value.set(w, h);
    pass(comp, null);
  }
  return {
    setSize, render,
    /** Quality steps: 0 full, 1 bloom from quarter resolution, 2 also no MSAA. */
    setQuality(level) {
      const nextDiv = level >= 1 ? 4 : 2, nextSamples = level >= 2 ? 0 : (isGL2 ? MSAA : 0), nextLevels = level >= 1 ? 4 : 5;
      if (nextDiv === startDiv && nextSamples === samples && nextLevels === levels) return;
      startDiv = nextDiv; samples = nextSamples; levels = nextLevels;
      if (w && h) makeTargets();
    },
    info: () => ({ samples, startDiv, levels, w, h }),
    dispose() { sceneRT?.dispose(); mips.forEach(m => m.dispose()); [down, up, comp].forEach(m => m.dispose()); quad.geometry.dispose(); },
  };
}
