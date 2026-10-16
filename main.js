// PS1-style viewer for the HFTC campus snow globe built by ../blender/build.py.
// Adapted from lab/ps1-dragon-globe/web/main.js.
//
// PS1 mode: the scene renders to a 240-line target with a custom material
// that snaps vertices to that pixel grid, interpolates UVs without
// perspective correction (affine warp), lights per vertex, and fogs to the
// sky. A final pass dithers to 15-bit colour and scales up with no filtering.
//
// Weather: snow (falls and settles on the ground and roofs), smoke (ash
// drifting up and sideways, glowing embers, smoke columns from the B5 and B8
// burn buildings, orange-brown haze), or none.
//
// URL params: ?weather=snow|smoke|none, ?t=<seconds> fast-forwards the clock,
// ?ps1=0, ?az=<deg>&el=<deg>&dist=<n> place the camera, ?focus=<B1..B9> orbits
// a building instead of the centre, ?spin=<n> auto-orbit speed, ?shake=<s>
// shows a shake that far in, ?freeze draws one frame and stops. ?record
// exposes __step(dt), __shake() and __weather(w) for checks/record.mjs
// instead of running the loop.
// document.title gets a JSON status line once the model is loaded.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const params = new URLSearchParams(location.search);
const FF = parseFloat(params.get('t') || '0');
const LOW_H = 240;
const WEATHERS = ['snow', 'smoke', 'none'];

// Two moods: winter dusk (snow, none) and burn-day haze (smoke). Colours are
// display values set raw (a hex THREE.Color would be converted to linear).
const rgb = (r, g, b) => new THREE.Color().setRGB(r, g, b);
const MOOD = {
  clear: {
    skyTop: rgb(0.36, 0.42, 0.7), skyBottom: rgb(0.07, 0.08, 0.2), fog: rgb(0.2, 0.23, 0.42),
    light: rgb(0.95, 0.9, 0.82), ambient: rgb(0.46, 0.49, 0.64), fogRange: [7, 15],
  },
  haze: {
    skyTop: rgb(0.66, 0.44, 0.25), skyBottom: rgb(0.24, 0.13, 0.07), fog: rgb(0.48, 0.32, 0.2),
    light: rgb(0.95, 0.68, 0.45), ambient: rgb(0.52, 0.4, 0.32), fogRange: [3.5, 10],
  },
};

const state = {
  ps1: params.get('ps1') !== '0',
  weather: WEATHERS.includes(params.get('weather')) ? params.get('weather') : 'snow',
  haze: 0,               // 0 = clear mood, 1 = smoke haze; eases toward the weather's target
  shakeT: -1,            // seconds since the last shake, -1 = none
};
state.haze = state.weather === 'smoke' ? 1 : 0;

// ------------------------------------------------------------ renderer

const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;   // everything stays in display space, like the PS1
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 100);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.1, 0);
controls.enableDamping = true;
controls.enablePan = false;
controls.minDistance = 0.8;
controls.maxDistance = 11;
controls.maxPolarAngle = 1.45;
controls.autoRotate = !params.has('az');
controls.autoRotateSpeed = parseFloat(params.get('spin') || '0.5');

function placeCamera(defDist) {
  const az = THREE.MathUtils.degToRad(parseFloat(params.get('az') ?? '-20'));
  const el = THREE.MathUtils.degToRad(parseFloat(params.get('el') ?? '38'));
  const d = parseFloat(params.get('dist') ?? String(defDist));
  const c = controls.target;
  camera.position.set(c.x + Math.sin(az) * Math.cos(el) * d, c.y + Math.sin(el) * d, c.z + Math.cos(az) * Math.cos(el) * d);
  controls.update();
}
placeCamera(5.4);

const lowTarget = new THREE.WebGLRenderTarget(1, 1, {
  minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true,
});

// Final pass: Bayer-dither the low-res frame down to 5 bits per channel.
const post = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
  uniforms: { tFrame: { value: lowTarget.texture }, uRes: { value: new THREE.Vector2() } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }`,
  fragmentShader: `
    uniform sampler2D tFrame; uniform vec2 uRes; varying vec2 vUv;
    float bayer(vec2 p){
      int x = int(mod(p.x, 4.)), y = int(mod(p.y, 4.));
      int m[16] = int[16](0,8,2,10, 12,4,14,6, 3,11,1,9, 15,7,13,5);
      return float(m[y * 4 + x]) / 16. - 0.5;
    }
    void main(){
      vec2 px = floor(vUv * uRes);
      vec3 c = texture2D(tFrame, (px + .5) / uRes).rgb;
      c = floor(c * 31. + 0.5 + bayer(px) * 0.9) / 31.;
      gl_FragColor = vec4(clamp(c, 0., 1.), 1.);
    }`,
  depthTest: false, depthWrite: false,
}));
const postScene = new THREE.Scene();
postScene.add(post);
const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

// ------------------------------------------------------------ PS1 material

const shared = {
  uSnap: { value: new THREE.Vector2(320, 240) },
  uAffine: { value: 1 },
  uLightDir: { value: new THREE.Vector3(0.55, 0.9, 0.65).normalize() },
  uLight: { value: MOOD.clear.light.clone() },
  uAmbient: { value: MOOD.clear.ambient.clone() },
  uPointPos: { value: new THREE.Vector3() },
  uPoint: { value: new THREE.Color(0, 0, 0) },
  uFog: { value: MOOD.clear.fog.clone() },
  uFogRange: { value: new THREE.Vector2(...MOOD.clear.fogRange) },
  uTime: { value: 0 },
};

const SNAP_GLSL = `
  vec4 snapClip(vec4 clip){
    if (uSnap.x > 0.) {                       // wobble: snap to the low-res pixel grid
      vec2 ndc = clip.xy / clip.w;
      ndc = (floor((ndc * .5 + .5) * uSnap) + .5) / uSnap * 2. - 1.;
      clip.xy = ndc * clip.w;
    }
    return clip;
  }`;

const PS1_VERT = `
  uniform vec2 uSnap; uniform float uAffine, uDouble;
  uniform vec3 uLightDir, uLight, uAmbient, uPointPos, uPoint;
  uniform vec2 uFogRange;
  varying vec3 vUvw; varying vec3 vLight; varying float vFog;
  ${SNAP_GLSL}
  void main(){
    vec4 world = modelMatrix * vec4(position, 1.);
    vec4 mv = viewMatrix * world;
    vec4 clip = snapClip(projectionMatrix * mv);
    vec3 n = normalize(mat3(modelMatrix) * normal);
    float d = dot(n, uLightDir);
    d = uDouble > .5 ? abs(d) : max(d, 0.);
    vec3 toP = uPointPos - world.xyz;
    float pd = max(dot(n, normalize(toP)), uDouble > .5 ? .6 : 0.);
    float att = 1. / (1. + dot(toP, toP) * 5.);
    vLight = uAmbient + uLight * d * .75 + uPoint * pd * att;
    vFog = smoothstep(uFogRange.x, uFogRange.y, -mv.z);
    float w = mix(1., clip.w, uAffine);       // affine: interpolate uv*w and w, divide per pixel
    vUvw = vec3(uv * w, w);
    gl_Position = clip;
  }`;

const PS1_FRAG = `
  uniform sampler2D map; uniform vec3 uFog;
  varying vec3 vUvw; varying vec3 vLight; varying float vFog;
  void main(){
    vec4 t = texture2D(map, vUvw.xy / vUvw.z);
    if (t.a < .5) discard;                    // chain-link fence
    gl_FragColor = vec4(mix(t.rgb * vLight, uFog, vFog), 1.);
  }`;

function ps1Material(map, doubleSided) {
  return new THREE.ShaderMaterial({
    uniforms: { ...shared, map: { value: map }, uDouble: { value: doubleSided ? 1 : 0 } },
    vertexShader: PS1_VERT, fragmentShader: PS1_FRAG,
    side: doubleSided ? THREE.DoubleSide : THREE.FrontSide,
  });
}

// Map-chip labels: unlit, unfogged, drawn over everything so they always read.
// They go in their own scene, rendered after the dither pass at full
// resolution (like a PS1 game's 2D text layer): at 1:1 texels on the
// 240-line target, nearest sampling dropped glyph columns.
const labelScene = new THREE.Scene();
const LABEL_PX = 12;          // label height in 240-line pixels
function labelMaterial(map) {
  return new THREE.ShaderMaterial({
    uniforms: { map: { value: map } },
    vertexShader: `varying vec2 vUv;
      void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
    fragmentShader: `uniform sampler2D map; varying vec2 vUv;
      void main(){ gl_FragColor = vec4(texture2D(map, vUv).rgb, 1.); }`,
    side: THREE.DoubleSide, depthTest: false, depthWrite: false,
  });
}

const textures = new Set();
function applyFilter() {
  for (const t of textures) {
    t.colorSpace = THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.generateMipmaps = false;
    t.minFilter = t.magFilter = state.ps1 || t.userData.keepNearest ? THREE.NearestFilter : THREE.LinearFilter;
    t.needsUpdate = true;
  }
}

// ------------------------------------------------------------ sky, stars

const skyMat = new THREE.ShaderMaterial({
  uniforms: { top: { value: MOOD.clear.skyTop.clone() }, bottom: { value: MOOD.clear.skyBottom.clone() } },
  vertexShader: `varying float vH; void main(){ vH = normalize(position).y;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
  fragmentShader: `uniform vec3 top, bottom; varying float vH;
    void main(){ gl_FragColor = vec4(mix(bottom, top, smoothstep(-.75, .45, vH)), 1.); }`,
  side: THREE.BackSide, depthWrite: false,
});
scene.add(new THREE.Mesh(new THREE.SphereGeometry(40, 16, 12), skyMat));

let stars;
{
  const n = 220, pos = new Float32Array(n * 3);
  const r = mulberry(11);
  for (let i = 0; i < n; i++) {
    const a = r() * Math.PI * 2, y = 0.1 + r() * 0.9, s = Math.sqrt(1 - y * y);
    pos.set([Math.cos(a) * s * 35, y * 35, Math.sin(a) * s * 35], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  stars = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xc8d0ff, size: 1, sizeAttenuation: false }));
  scene.add(stars);
}

function mulberry(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function applyMood(h) {
  const A = MOOD.clear, B = MOOD.haze;
  skyMat.uniforms.top.value.lerpColors(A.skyTop, B.skyTop, h);
  skyMat.uniforms.bottom.value.lerpColors(A.skyBottom, B.skyBottom, h);
  shared.uFog.value.lerpColors(A.fog, B.fog, h);
  shared.uLight.value.lerpColors(A.light, B.light, h);
  shared.uAmbient.value.lerpColors(A.ambient, B.ambient, h);
  shared.uFogRange.value.set(A.fogRange[0] + (B.fogRange[0] - A.fogRange[0]) * h,
    A.fogRange[1] + (B.fogRange[1] - A.fogRange[1]) * h);
  stars.visible = h < 0.5;
}

// ------------------------------------------------------------ scene data

let SCENE = null;     // scene.json: buildings, labels, smoke sources, height grid
let R = 2.2;          // disc radius, units

// Ground or roof height under (x, z) from the baked grid; below the rim outside the disc.
function groundAt(x, z) {
  if (Math.hypot(x, z) > R) return -0.3;
  const g = SCENE.heightgrid, n = g.n, e = g.extent;
  const j = Math.min(n - 1, Math.max(0, Math.floor((x + e) / (2 * e) * n)));
  const i = Math.min(n - 1, Math.max(0, Math.floor((z + e) / (2 * e) * n)));
  return g.rows[i][j];
}

// ------------------------------------------------------------ particles

// Points shader shared by snow, ash and embers: per-point colour and size in
// low-res pixels at distance 6, snapped like the geometry, fogged.
const pxPerUnit = { value: 300 };
function pointsMaterial({ additive = false, glow = false } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: { uSnap: shared.uSnap, uResY: { value: LOW_H }, uFog: shared.uFog, uFogRange: shared.uFogRange,
      uTime: shared.uTime, uGlow: { value: glow ? 1 : 0 } },
    vertexShader: `uniform vec2 uSnap; uniform float uResY, uTime, uGlow; uniform vec2 uFogRange;
      attribute vec3 aColor; attribute float aSize;
      varying vec3 vColor; varying float vFog;
      ${SNAP_GLSL}
      void main(){
        vec4 mv = modelViewMatrix * vec4(position, 1.);
        gl_Position = snapClip(projectionMatrix * mv);
        gl_PointSize = clamp(aSize * (uResY / 240.) * 6. / -mv.z, aSize > 0. ? 1. : 0., 4. * uResY / 240.);
        float flick = uGlow > .5 ? .75 + .25 * sin(uTime * 23. + position.x * 91. + position.z * 57.) : 1.;
        vColor = aColor * flick;
        vFog = uGlow > .5 ? 0. : smoothstep(uFogRange.x, uFogRange.y, -mv.z);
      }`,
    fragmentShader: `uniform vec3 uFog; varying vec3 vColor; varying float vFog;
      void main(){ gl_FragColor = vec4(mix(vColor, uFog, vFog * .7), 1.); }`,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    transparent: additive, depthWrite: !additive,
  });
}

function makeCloud(n, opts) {
  const c = {
    n, pos: new Float32Array(n * 3), vel: new Float32Array(n * 3), col: new Float32Array(n * 3),
    size: new Float32Array(n), phase: new Float32Array(n), rest: new Float32Array(n), life: new Float32Array(n),
    rnd: mulberry(opts.seed || 5),
  };
  c.geo = new THREE.BufferGeometry();
  c.geo.setAttribute('position', new THREE.BufferAttribute(c.pos, 3));
  c.geo.setAttribute('aColor', new THREE.BufferAttribute(c.col, 3));
  c.geo.setAttribute('aSize', new THREE.BufferAttribute(c.size, 1));
  c.points = new THREE.Points(c.geo, pointsMaterial(opts));
  c.points.frustumCulled = false;
  c.points.renderOrder = 5;
  scene.add(c.points);
  return c;
}
function dirty(c) {
  c.geo.attributes.position.needsUpdate = true;
  c.geo.attributes.aColor.needsUpdate = true;
  c.geo.attributes.aSize.needsUpdate = true;
}
function randDisc(r, rad) {
  const a = r() * Math.PI * 2, d = Math.sqrt(r()) * rad;
  return [Math.cos(a) * d, Math.sin(a) * d];
}

const TOP = 2.4;

// Snow: falls, drifts, settles on the ground and roofs for a few seconds.
let snow;
function spawnFlake(i, anywhere) {
  const r = snow.rnd, [x, z] = randDisc(r, R * 0.97);
  snow.pos.set([x, anywhere ? groundAt(x, z) + r() * TOP : TOP, z], i * 3);
  snow.vel.set([0, -(0.25 + r() * 0.2), 0], i * 3);
  snow.phase[i] = r() * 100;
  snow.rest[i] = 0;
  const w = 0.88 + r() * 0.12;
  snow.col.set([w, w + 0.02, 1], i * 3);
  snow.size[i] = 0.9 + r() * 0.5;
}
function stepSnow(dt, t) {
  const p = snow.pos, v = snow.vel, Rr = R * 0.97;
  for (let i = 0; i < snow.n; i++) {
    const k = i * 3;
    if (snow.rest[i] > 0) {                    // settled: sit, then melt away
      snow.rest[i] -= dt;
      if (snow.rest[i] <= 0) spawnFlake(i, false);
      continue;
    }
    const ph = snow.phase[i];
    const tx = Math.sin(t * 0.7 + ph) * 0.1, ty = -0.3, tz = Math.cos(t * 0.6 + ph * 1.3) * 0.1;
    const ease = 1 - Math.exp(-dt * 1.1);
    v[k] += (tx - v[k]) * ease; v[k + 1] += (ty - v[k + 1]) * ease; v[k + 2] += (tz - v[k + 2]) * ease;
    p[k] += v[k] * dt; p[k + 1] += v[k + 1] * dt; p[k + 2] += v[k + 2] * dt;
    const r = Math.hypot(p[k], p[k + 2]);
    if (r > Rr) {   // keep flakes inside the invisible globe
      p[k] *= Rr / r; p[k + 2] *= Rr / r;
      v[k] *= -0.3; v[k + 2] *= -0.3;
    }
    if (p[k + 1] > TOP + 0.4) { p[k + 1] = TOP + 0.4; v[k + 1] = Math.min(v[k + 1], 0); }
    const g = groundAt(p[k], p[k + 2]);
    if (p[k + 1] < g + 0.003) {
      p[k + 1] = g + 0.003;
      snow.rest[i] = 2 + snow.rnd() * 4;
    }
  }
  dirty(snow);
}
function kickSnow() {
  const r = snow.rnd, p = snow.pos, v = snow.vel;
  for (let i = 0; i < snow.n; i++) {
    const k = i * 3;
    snow.rest[i] = 0;
    if (r() < 0.4) {
      const [x, z] = randDisc(r, R * 0.97);
      p[k] = x; p[k + 2] = z; p[k + 1] = groundAt(x, z) + 0.05;
    }
    const swirl = 1.2 + r() * 1.2, rr = Math.hypot(p[k], p[k + 2]) || 1;
    v[k] = -p[k + 2] / rr * swirl + (r() - 0.5);
    v[k + 2] = p[k] / rr * swirl + (r() - 0.5);
    v[k + 1] = 1.2 + r() * 2.5;
  }
}

// Ash: grey-black flakes riding a slow wind that lifts and pushes east.
const WIND = new THREE.Vector3(0.16, 0.05, -0.05);
let ash;
function spawnAsh(i, anywhere) {
  const r = ash.rnd, [x, z] = randDisc(r, R * 0.97);
  ash.pos.set([x, anywhere ? groundAt(x, z) + r() * TOP : groundAt(x, z) + 0.02 + r() * 0.3, z], i * 3);
  ash.vel.set([WIND.x, WIND.y, WIND.z], i * 3);
  ash.phase[i] = r() * 100;
  ash.rest[i] = 0;
  const g = 0.08 + r() * 0.3;
  ash.col.set([g * 1.05, g, g * 0.95], i * 3);
  ash.size[i] = 0.8 + r() * 0.7;
}
function stepAsh(dt, t) {
  const p = ash.pos, v = ash.vel, Rr = R * 0.97;
  for (let i = 0; i < ash.n; i++) {
    const k = i * 3, ph = ash.phase[i];
    if (ash.rest[i] > 0) { ash.rest[i] -= dt; if (ash.rest[i] <= 0) spawnAsh(i, false); continue; }
    const tx = WIND.x + Math.sin(t * 0.9 + ph) * 0.12;
    const ty = WIND.y + Math.sin(t * 1.7 + ph * 2.1) * 0.09;
    const tz = WIND.z + Math.cos(t * 0.8 + ph * 1.3) * 0.12;
    const ease = 1 - Math.exp(-dt * 0.9);
    v[k] += (tx - v[k]) * ease; v[k + 1] += (ty - v[k + 1]) * ease; v[k + 2] += (tz - v[k + 2]) * ease;
    p[k] += v[k] * dt; p[k + 1] += v[k + 1] * dt; p[k + 2] += v[k + 2] * dt;
    const r = Math.hypot(p[k], p[k + 2]);
    if (r > Rr) {          // carried out of the globe: re-enter on the upwind side
      p[k] = -p[k] * 0.96; p[k + 2] = -p[k + 2] * 0.96;
    }
    if (p[k + 1] > TOP + 0.3) spawnAsh(i, false);
    const g = groundAt(p[k], p[k + 2]);
    if (p[k + 1] < g + 0.003) { p[k + 1] = g + 0.003; ash.rest[i] = 1 + ash.rnd() * 2; }
  }
  dirty(ash);
}

// Embers: rise hot from the burn buildings, cool from yellow to red, die.
let embers;
function spawnEmber(i) {
  const r = embers.rnd, src = SCENE.smoke[Math.floor(r() * SCENE.smoke.length)].pos;
  embers.pos.set([src[0] + (r() - 0.5) * 0.05, src[1], src[2] + (r() - 0.5) * 0.05], i * 3);
  embers.vel.set([(r() - 0.5) * 0.35, 0.2 + r() * 0.3, (r() - 0.5) * 0.35], i * 3);
  embers.phase[i] = r() * 100;
  embers.life[i] = 1.5 + r() * 2.5;
  embers.rest[i] = embers.life[i];
}
function stepEmbers(dt, t) {
  const p = embers.pos, v = embers.vel;
  for (let i = 0; i < embers.n; i++) {
    const k = i * 3;
    embers.rest[i] -= dt;
    if (embers.rest[i] <= 0) spawnEmber(i);
    const ph = embers.phase[i];
    v[k] += (WIND.x * 1.6 + Math.sin(t * 3 + ph) * 0.2 - v[k]) * dt;
    v[k + 2] += (WIND.z * 1.6 + Math.cos(t * 2.6 + ph) * 0.2 - v[k + 2]) * dt;
    v[k + 1] *= 1 - dt * 0.3;
    p[k] += v[k] * dt; p[k + 1] += v[k + 1] * dt; p[k + 2] += v[k + 2] * dt;
    const a = Math.max(0, embers.rest[i] / embers.life[i]);       // 1 fresh -> 0 dead
    embers.col.set([1.0 * Math.min(1, a * 2 + 0.3), 0.25 + 0.6 * a * a, 0.05 + 0.25 * a * a * a], i * 3);
    embers.size[i] = a > 0.05 ? 1.8 + a * 1.2 : 0;
  }
  dirty(embers);
}

// Smoke columns: big billboard puffs, screen-door transparency (dithered
// discard, PS1-style), rising from B5 and B8 and leaning with the wind.
let smoke;
const SMOKE_PER = 40;
const smokeMat = new THREE.ShaderMaterial({
  uniforms: { uSnap: shared.uSnap, uPx: pxPerUnit, uFog: shared.uFog, uFogRange: shared.uFogRange },
  vertexShader: `uniform vec2 uSnap; uniform float uPx; uniform vec2 uFogRange;
    attribute float aSize; attribute float aAlpha; attribute float aShade; attribute float aSeed;
    varying float vAlpha; varying float vShade; varying float vSeed; varying float vFog;
    ${SNAP_GLSL}
    void main(){
      vec4 mv = modelViewMatrix * vec4(position, 1.);
      gl_Position = snapClip(projectionMatrix * mv);
      gl_PointSize = clamp(aSize * uPx / -mv.z, 1., 160.);
      vAlpha = aAlpha; vShade = aShade; vSeed = aSeed;
      vFog = smoothstep(uFogRange.x, uFogRange.y, -mv.z);
    }`,
  fragmentShader: `uniform vec3 uFog; varying float vAlpha; varying float vShade; varying float vSeed; varying float vFog;
    float bayer(vec2 p){
      int x = int(mod(p.x, 4.)), y = int(mod(p.y, 4.));
      int m[16] = int[16](0,8,2,10, 12,4,14,6, 3,11,1,9, 15,7,13,5);
      return (float(m[y * 4 + x]) + .5) / 16.;
    }
    void main(){
      vec2 q = gl_PointCoord - .5;
      float r = length(q) * 2.;
      float lump = .82 + .18 * sin(atan(q.y, q.x) * 5. + vSeed * 6.283);
      float a = vAlpha * smoothstep(lump, lump * .55, r);
      if (a < bayer(gl_FragCoord.xy + floor(vSeed * 4.))) discard;
      vec3 c = vec3(vShade) * vec3(1.05, .98, .92) * (1. - .25 * q.y);
      gl_FragColor = vec4(mix(c, uFog, vFog * .6), 1.);
    }`,
  depthWrite: false,
});
function initSmoke() {
  const srcs = SCENE.smoke, n = srcs.length * SMOKE_PER;
  smoke = { n, pos: new Float32Array(n * 3), age: new Float32Array(n), life: new Float32Array(n),
    size: new Float32Array(n), alpha: new Float32Array(n), shade: new Float32Array(n), seed: new Float32Array(n),
    drift: new Float32Array(n * 2), rnd: mulberry(23) };
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(smoke.pos, 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(smoke.size, 1));
  g.setAttribute('aAlpha', new THREE.BufferAttribute(smoke.alpha, 1));
  g.setAttribute('aShade', new THREE.BufferAttribute(smoke.shade, 1));
  g.setAttribute('aSeed', new THREE.BufferAttribute(smoke.seed, 1));
  smoke.geo = g;
  smoke.points = new THREE.Points(g, smokeMat);
  smoke.points.frustumCulled = false;
  smoke.points.renderOrder = 6;
  scene.add(smoke.points);
  for (let i = 0; i < n; i++) { spawnPuff(i); smoke.age[i] = smoke.rnd() * smoke.life[i]; }
}
function spawnPuff(i) {
  const r = smoke.rnd;
  smoke.age[i] = 0;
  smoke.life[i] = 7 + r() * 3;
  smoke.seed[i] = r();
  smoke.drift[i * 2] = (r() - 0.5) * 0.06;
  smoke.drift[i * 2 + 1] = (r() - 0.5) * 0.06;
}
function stepSmoke(dt, t) {
  const srcs = SCENE.smoke;
  for (let i = 0; i < smoke.n; i++) {
    smoke.age[i] += dt;
    if (smoke.age[i] > smoke.life[i]) spawnPuff(i);
    const s = srcs[Math.floor(i / SMOKE_PER)].pos, a = smoke.age[i], f = a / smoke.life[i];
    const rise = 0.11 * a, lean = a * a * 0.012 + a * 0.03;
    smoke.pos[i * 3] = s[0] + WIND.x / 0.16 * lean + smoke.drift[i * 2] * a + Math.sin(t * 0.7 + i) * 0.01 * a;
    smoke.pos[i * 3 + 1] = s[1] + rise;
    smoke.pos[i * 3 + 2] = s[2] + WIND.z / 0.16 * lean + smoke.drift[i * 2 + 1] * a;
    smoke.size[i] = 0.08 + 0.6 * Math.sqrt(f);
    smoke.alpha[i] = Math.min(1, a * 2.5) * Math.pow(1 - f, 0.7);
    smoke.shade[i] = 0.08 + 0.32 * f + 0.06 * smoke.seed[i];
  }
  for (const k of ['position', 'aSize', 'aAlpha', 'aShade', 'aSeed']) smoke.geo.attributes[k].needsUpdate = true;
}

function setWeather(w) {
  state.weather = w;
  snow.points.visible = w === 'snow';
  ash.points.visible = embers.points.visible = smoke.points.visible = w === 'smoke';
  if (w === 'snow') for (let i = 0; i < snow.n; i++) spawnFlake(i, true);
  btn('weather').textContent = `weather: ${w}`;
}

function stepWeather(dt, t) {
  const target = state.weather === 'smoke' ? 1 : 0;
  state.haze += (target - state.haze) * (1 - Math.exp(-dt * 2));
  applyMood(state.haze);
  if (state.weather === 'snow') stepSnow(dt, t);
  if (state.weather === 'smoke') { stepAsh(dt, t); stepEmbers(dt, t); stepSmoke(dt, t); }
  // burn glow: an orange point light flickering over B5, faded with the haze
  const fl = 0.8 + 0.2 * Math.sin(t * 13) * Math.sin(t * 7.3 + 1);
  shared.uPoint.value.setRGB(1.0, 0.5, 0.15).multiplyScalar(state.haze * fl);
}

// ------------------------------------------------------------ the model

const labels = [];
const loaded = Promise.all([
  new GLTFLoader().loadAsync('assets/hftc_globe.glb'),
  fetch('assets/scene.json').then((r) => r.json()),
]).then(([gltf, sceneData]) => {
  SCENE = sceneData;
  R = SCENE.units.disc_radius;
  let tris = 0;
  const parts = [];
  gltf.scene.traverse((o) => {
    if (o.name) parts.push(o.name);
    if (!o.isMesh) return;
    tris += o.geometry.index ? o.geometry.index.count / 3 : o.geometry.attributes.position.count / 3;
    const map = o.material.map;
    if (map) textures.add(map);
    if (o.name.startsWith('Label_')) {
      o.material = labelMaterial(map);
      o.renderOrder = 1000;
      o.userData.h = 0.06;            // label quad height in the GLB (build.py LH)
      o.geometry.computeBoundingBox();
      const bb = o.geometry.boundingBox;
      o.userData.aspect = (bb.max.x - bb.min.x) / (bb.max.y - bb.min.y);
      labels.push(o);
      map.magFilter = map.minFilter = THREE.NearestFilter;
      map.userData.keepNearest = true;
    } else {
      o.material = ps1Material(map, o.material.side === THREE.DoubleSide);
    }
  });
  scene.add(gltf.scene);
  for (const o of labels) {           // move the labels to the overlay scene, keeping world transforms
    o.updateWorldMatrix(true, false);
    o.matrixWorld.decompose(o.position, o.quaternion, o.scale);
    labelScene.add(o);
  }

  // Blob shadows under the buildings, PS1-game style, nudged away from the light.
  const blobMat = new THREE.ShaderMaterial({
    vertexShader: `varying vec2 vP; void main(){ vP = position.xy;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
    fragmentShader: `varying vec2 vP; void main(){
      gl_FragColor = vec4(0.03, 0.03, 0.08, .5 * smoothstep(1., .55, length(vP))); }`,
    transparent: true, depthWrite: false,
  });
  const L = shared.uLightDir.value;
  for (const b of Object.values(SCENE.buildings)) {
    const [x0, z0, x1, z1] = b.bbox, h = b.top[1];
    const m = new THREE.Mesh(new THREE.CircleGeometry(1, 14), blobMat);
    m.rotation.x = -Math.PI / 2;
    m.scale.set((x1 - x0) * 0.6 + h * 0.3, (z1 - z0) * 0.6 + h * 0.3, 1);
    m.position.set((x0 + x1) / 2 - L.x * h * 0.5, 0.024, (z0 + z1) / 2 - L.z * h * 0.5);
    m.renderOrder = 1;
    scene.add(m);
  }

  initLeaders();
  snow = makeCloud(750, { seed: 5 });
  for (let i = 0; i < snow.n; i++) spawnFlake(i, true);
  ash = makeCloud(650, { seed: 9 });
  for (let i = 0; i < ash.n; i++) spawnAsh(i, true);
  embers = makeCloud(70, { seed: 13, additive: true, glow: true });
  for (let i = 0; i < embers.n; i++) { spawnEmber(i); embers.rest[i] *= embers.rnd(); }
  initSmoke();

  // burn glow sits just above the Victorian's roof
  const b5 = SCENE.smoke.find((s) => s.building === 'B5').pos;
  shared.uPointPos.value.set(b5[0], b5[1] + 0.12, b5[2]);
  const focus = params.get('focus');
  if (focus && SCENE.buildings[focus]) {
    const b = SCENE.buildings[focus];
    controls.target.set(b.centre[0], b.top[1] * 0.5, b.centre[2]);
    placeCamera(1.4);
  }
  applyFilter();
  return { tris, labels: labels.length, parts: parts.length };
});

// ------------------------------------------------------------ labels

// Fixed size on screen (LABEL_PX of 240 lines tall), facing the camera.
// Declutter: nearest label keeps its spot; a farther one that would overlap
// a placed label slides up the screen until it clears (eased, so no popping).
const _v = new THREE.Vector3(), _up = new THREE.Vector3();
// Leader lines from each label down to its roof, drawn in the 240-line pass
// (so they're chunky) but over the geometry.
let leaders;
function initLeaders() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(labels.length * 6), 3));
  leaders = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x5a0c08, depthTest: false, depthWrite: false }));
  leaders.frustumCulled = false;
  leaders.renderOrder = 900;
  scene.add(leaders);
}
function updateLabels(dt = 1 / 30) {
  // narrow (portrait) screens: shrink labels with the width, down to 60%
  const LP = LABEL_PX * Math.min(1, Math.max(0.6, camera.aspect / 0.8));
  const k = (LP / LOW_H) * 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  _up.set(0, 1, 0).applyQuaternion(camera.quaternion);
  const items = labels.map((o) => {
    const a = o.userData.anchor ||= o.position.clone();
    const d = a.distanceTo(camera.position);
    _v.copy(a).project(camera);
    const sx = _v.x * LOW_H * camera.aspect / 2, sy = _v.y * LOW_H / 2;   // 240-line pixels from centre
    const w = LP * o.userData.aspect;
    return { o, a, d, sx, sy, w };
  }).sort((p, q) => p.d - q.d);
  const placed = [];
  for (const it of items) {
    let y = it.sy;
    for (let pass = 0; pass < 6; pass++) {
      const hit = placed.find((p) => Math.abs(p.sx - it.sx) < (p.w + it.w) / 2 + 1 && y < p.y + LP + 1 && y + LP + 1 > p.y);
      if (!hit) break;
      y = hit.y + LP + 1;
    }
    placed.push({ sx: it.sx, y, w: it.w });
    const o = it.o, want = y - it.sy;
    o.userData.lift = (o.userData.lift ?? want) + (want - (o.userData.lift ?? want)) * Math.min(1, dt * 8);
    o.quaternion.copy(camera.quaternion);
    o.scale.setScalar(k * it.d / o.userData.h);
    o.position.copy(it.a).addScaledVector(_up, o.userData.lift * k * it.d / LP);
    o.renderOrder = 1000 - it.d * 10;
    const roof = SCENE.labels[o.name.slice(6)].roof, i = labels.indexOf(o) * 6;
    leaders.geometry.attributes.position.array.set([o.position.x, o.position.y, o.position.z, roof[0], roof[1], roof[2]], i);
  }
  leaders.geometry.attributes.position.needsUpdate = true;
}

// ------------------------------------------------------------ input

const hint = document.getElementById('hint');
function shake() {
  state.shakeT = 0;
  hint.style.opacity = 0;
  if (state.weather === 'snow') kickSnow();
  if (state.weather === 'smoke') {
    const r = ash.rnd;
    for (let i = 0; i < ash.n; i++) {
      ash.rest[i] = 0;
      ash.vel[i * 3] += (r() - 0.5) * 1.5; ash.vel[i * 3 + 1] += 0.5 + r(); ash.vel[i * 3 + 2] += (r() - 0.5) * 1.5;
    }
    for (let i = 0; i < embers.n; i++) { spawnEmber(i); embers.vel[i * 3 + 1] += 0.4; }
  }
}

let down = null;
renderer.domElement.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 8 && performance.now() - down.t < 350) shake();
  down = null;
});
controls.addEventListener('start', () => { controls.autoRotate = false; });

const btn = (id) => document.getElementById(id);
function syncUi() {
  btn('ps1').textContent = state.ps1 ? 'PS1 on' : 'PS1 off';
  btn('ps1').classList.toggle('off', !state.ps1);
  btn('weather').textContent = `weather: ${state.weather}`;
}
btn('ps1').onclick = () => { state.ps1 = !state.ps1; applyMode(); syncUi(); };
btn('weather').onclick = () => {
  setWeather(WEATHERS[(WEATHERS.indexOf(state.weather) + 1) % WEATHERS.length]);
  const u = new URL(location.href);
  u.searchParams.set('weather', state.weather);
  history.replaceState(null, '', u);
  syncUi();
};
btn('shake').onclick = shake;

function applyMode() {
  shared.uAffine.value = state.ps1 ? 1 : 0;
  resize();
  applyFilter();
}

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // portrait: keep the disc's width in frame by widening the vertical fov
  const halfTan = Math.tan(THREE.MathUtils.degToRad(20)) / Math.min(1, camera.aspect);
  camera.fov = Math.min(75, THREE.MathUtils.radToDeg(2 * Math.atan(halfTan)));
  camera.updateProjectionMatrix();
  let resY;
  if (state.ps1) {
    const lw = Math.round(LOW_H * w / h);
    lowTarget.setSize(lw, LOW_H);
    shared.uSnap.value.set(lw, LOW_H);
    post.material.uniforms.uRes.value.set(lw, LOW_H);
    resY = LOW_H;
  } else {
    shared.uSnap.value.set(0, 0);
    resY = h * renderer.getPixelRatio();
  }
  for (const c of [snow, ash, embers]) if (c) c.points.material.uniforms.uResY.value = resY;
  pxPerUnit.value = resY / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
}
addEventListener('resize', resize);

// ------------------------------------------------------------ loop

const clock = new THREE.Clock();
let t = 0;
const shakeAt = params.has('shake') ? parseFloat(params.get('shake')) : null;

function sim(dt) {
  t += dt;
  shared.uTime.value = t;
  if (state.shakeT >= 0) state.shakeT += dt;
  stepWeather(dt, t);
}

function frame(dt) {
  sim(dt);
  controls.update(dt);
  updateLabels(dt);

  // camera jolt, decaying over about a second
  let jolt = null;
  if (state.shakeT >= 0 && state.shakeT < 1.5) {
    const s = state.shakeT, a = Math.exp(-s * 4) * 0.15;
    jolt = new THREE.Vector3(Math.sin(s * 47) * a, Math.sin(s * 59 + 1) * a * 0.7, 0);
    camera.position.add(jolt);
  }
  if (state.ps1) {
    renderer.setRenderTarget(lowTarget);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(postScene, postCam);
  } else {
    renderer.render(scene, camera);
  }
  renderer.autoClear = false;
  renderer.render(labelScene, camera);
  renderer.autoClear = true;
  if (jolt) camera.position.sub(jolt);
}

loaded.then((info) => {
  setWeather(state.weather);
  applyMode();
  syncUi();
  // fast-forward for headless screenshots, in fixed 1/30 s steps
  for (let i = 0; i < Math.round(FF * 30); i++) sim(1 / 30);
  if (shakeAt !== null) {
    shake();
    for (let i = 0; i < Math.round(shakeAt * 30); i++) sim(1 / 30);
  }
  document.title = JSON.stringify({ ok: true, ...info, weather: state.weather });
  if (params.has('freeze')) frame(0);
  else if (params.has('record')) {
    Object.assign(window, { __step: frame, __shake: shake, __weather: (w) => { setWeather(w); syncUi(); } });
  } else renderer.setAnimationLoop(() => frame(Math.min(clock.getDelta(), 0.05)));
}).catch((e) => { document.title = JSON.stringify({ ok: false, err: String(e) }); console.error(e); });
