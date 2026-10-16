// Dissipação na superfície 3D (robô que perde): o material some por um ruído 3D, com uma frente de borda
// incandescente que avança pela superfície, e brasas saem exatamente dos pontos que estão sendo consumidos.
// Injeta no shader dos próprios materiais (Standard/Physical/Basic, inclusive arrays) e nos materiais de sombra
// (customDepthMaterial/customDistanceMaterial), encadeando hooks onBeforeCompile já existentes.
import * as THREE from 'three';

// Ruído de valor 3D + fbm, idêntico em GLSL e JS (para as brasas nascerem na frente da dissolução)
const GLSL_NOISE = /* glsl */`
  float dsHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float dsNoise(vec3 x) {
    vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(dsHash(i + vec3(0,0,0)), dsHash(i + vec3(1,0,0)), f.x), mix(dsHash(i + vec3(0,1,0)), dsHash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(dsHash(i + vec3(0,0,1)), dsHash(i + vec3(1,0,1)), f.x), mix(dsHash(i + vec3(0,1,1)), dsHash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float dsField(vec3 p, float h) {           // 0..1; o topo do robô se desfaz um pouco antes da base
    float n = 0.55 * dsNoise(p * 3.1) + 0.3 * dsNoise(p * 7.3) + 0.15 * dsNoise(p * 15.7);
    n = clamp((n - 0.27) / 0.46, 0.0, 1.0);                                  // espalha o fbm (concentrado no meio) em 0..1
    return clamp(mix(n, 1.0 - h, 0.32), 0.0, 1.0);
  }
`;
const fract = (x) => x - Math.floor(x);
function dsHash(x, y, z) {
  x = fract(x * 0.3183099 + 0.1) * 17; y = fract(y * 0.3183099 + 0.1) * 17; z = fract(z * 0.3183099 + 0.1) * 17;
  return fract(x * y * z * (x + y + z));
}
function dsNoise(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let fx = x - ix, fy = y - iy, fz = z - iz;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  const m = (a, b, t) => a + (b - a) * t, h = (a, b, c) => dsHash(ix + a, iy + b, iz + c);
  return m(m(m(h(0, 0, 0), h(1, 0, 0), fx), m(h(0, 1, 0), h(1, 1, 0), fx), fy),
           m(m(h(0, 0, 1), h(1, 0, 1), fx), m(h(0, 1, 1), h(1, 1, 1), fx), fy), fz);
}
export function dsField(x, y, z, h) {
  let n = 0.55 * dsNoise(x * 3.1, y * 3.1, z * 3.1) + 0.3 * dsNoise(x * 7.3, y * 7.3, z * 7.3) + 0.15 * dsNoise(x * 15.7, y * 15.7, z * 15.7);
  n = Math.min(1, Math.max(0, (n - 0.27) / 0.46));
  return Math.min(1, Math.max(0, n + ((1 - h) - n) * 0.32));
}

const VERT_DECL = 'varying vec3 vDsPos;\n';
const VERT_BODY = '#include <project_vertex>\n  vDsPos = (modelMatrix * vec4(transformed, 1.0)).xyz;';
const FRAG_DECL = `uniform float uDissolve; uniform vec3 uEdgeColor; uniform vec3 uOrigin; uniform float uHeight;\nvarying vec3 vDsPos;\n${GLSL_NOISE}\n`;
const FRAG_DISCARD = `#include <clipping_planes_fragment>
  vec3 dsP = vDsPos - uOrigin;
  float dsF = dsField(dsP, clamp(dsP.y / uHeight, 0.0, 1.0));
  if (uDissolve > 0.0 && dsF < uDissolve) discard;`;
const FRAG_EDGE = `if (uDissolve > 0.0) {
    float dsEdge = 1.0 - smoothstep(0.0, 0.06, dsF - uDissolve);          // frente incandescente
    outgoingLight += uEdgeColor * dsEdge * 4.5 + vec3(1.0, 0.95, 0.85) * pow(dsEdge, 8.0) * 3.0;
  }
  #include <opaque_fragment>`;

// Encadeia o hook existente (não o substitui) e injeta o campo; `withEdge` só nos materiais visíveis
function patch(mat, uniforms, withEdge) {
  const prevCompile = mat.onBeforeCompile, prevKey = mat.customProgramCacheKey;
  mat.onBeforeCompile = function (shader, renderer) {
    if (prevCompile) prevCompile.call(this, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = VERT_DECL + shader.vertexShader.replace('#include <project_vertex>', VERT_BODY);
    let fs = FRAG_DECL + shader.fragmentShader.replace('#include <clipping_planes_fragment>', FRAG_DISCARD);
    if (withEdge) fs = fs.replace('#include <opaque_fragment>', FRAG_EDGE);
    shader.fragmentShader = fs;
  };
  mat.customProgramCacheKey = function () { return (prevKey ? prevKey.call(this) : '') + (withEdge ? '|dissolve-v2' : '|dissolve-v2-shadow'); };
  mat.needsUpdate = true;
  return mat;
}

// Amostragem de superfície por triângulo, ponderada por área (posições com morph/skin via getVertexPosition)
function buildSurfaceSampler(meshes) {
  const tris = [], a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let total = 0;
  for (const m of meshes) {
    const g = m.geometry, idx = g.index, n = idx ? idx.count : g.attributes.position.count;
    for (let t = 0; t + 2 < n; t += 3) {
      const i0 = idx ? idx.getX(t) : t, i1 = idx ? idx.getX(t + 1) : t + 1, i2 = idx ? idx.getX(t + 2) : t + 2;
      a.fromBufferAttribute(g.attributes.position, i0); b.fromBufferAttribute(g.attributes.position, i1); c.fromBufferAttribute(g.attributes.position, i2);
      const area = b.clone().sub(a).cross(c.clone().sub(a)).length() * 0.5;
      if (area <= 0) continue;
      total += area; tris.push({ m, i0, i1, i2, cum: total });
    }
  }
  return (out) => {
    if (!tris.length) return null;
    const r = Math.random() * total;
    let lo = 0, hi = tris.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tris[mid].cum < r) lo = mid + 1; else hi = mid; }
    const t = tris[lo];
    t.m.getVertexPosition(t.i0, a); t.m.getVertexPosition(t.i1, b); t.m.getVertexPosition(t.i2, c);
    let u = Math.random(), v = Math.random(); if (u + v > 1) { u = 1 - u; v = 1 - v; }
    out.copy(a).addScaledVector(b.sub(a), u).addScaledVector(c.sub(a), v).applyMatrix4(t.m.matrixWorld);
    return out;
  };
}

/** Prepara um robô (Object3D) para dissipar. Controlador: { start(duration), update(now, emit), reset(), restore() }. */
export function makeDissolvable(root, edgeColor = 0xffa040) {
  const uniforms = {
    uDissolve: { value: 0 },
    uEdgeColor: { value: new THREE.Color(edgeColor) },
    uOrigin: { value: new THREE.Vector3() },
    uHeight: { value: 1 },
  };
  const records = [];
  root.traverse((o) => {
    if (!o.isMesh || !o.material || o.name === 'Sombra (camada)') return;
    const original = o.material;
    const list = Array.isArray(original) ? original : [original];
    const clones = list.map((m) => (m.isShaderMaterial ? m : patch(m.clone(), uniforms, true)));   // Basic/óticas também
    o.material = Array.isArray(original) ? clones : clones[0];
    const prevDepth = o.customDepthMaterial, prevDist = o.customDistanceMaterial;
    o.customDepthMaterial = patch(prevDepth ? prevDepth.clone() : new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }), uniforms, false);
    o.customDistanceMaterial = patch(prevDist ? prevDist.clone() : new THREE.MeshDistanceMaterial(), uniforms, false);
    records.push({ mesh: o, original, clones: clones.filter((m) => !list.includes(m)), prevDepth, prevDist });
  });
  const sample = buildSurfaceSampler(records.map((r) => r.mesh));
  const v = new THREE.Vector3();
  let t0 = 0, dur = 1, active = false;
  return {
    uniforms,
    get active() { return active; },
    start(duration = 1.6) {
      root.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(root), wp = root.getWorldPosition(new THREE.Vector3());
      uniforms.uOrigin.value.set(wp.x, box.min.y, wp.z);
      uniforms.uHeight.value = Math.max(0.3, box.max.y - box.min.y);
      t0 = performance.now(); dur = duration * 1000; active = true;
    },
    /** Avança; `emit(x, y, z)` recebe pontos da superfície que estão na frente agora. Retorna true ao terminar. */
    update(now, emit) {
      if (!active) return false;
      const u = Math.min(1, (now - t0) / dur), d = u * 1.08;
      uniforms.uDissolve.value = d;
      if (emit) {
        const o = uniforms.uOrigin.value, H = uniforms.uHeight.value;
        for (let k = 0; k < 18; k++) {
          if (!sample(v)) break;
          const f = dsField(v.x - o.x, v.y - o.y, v.z - o.z, Math.min(1, Math.max(0, (v.y - o.y) / H)));
          if (f >= d && f - d < 0.09) emit(v.x, v.y, v.z);
        }
      }
      if (u >= 1) { active = false; return true; }
      return false;
    },
    reset() { uniforms.uDissolve.value = 0; active = false; },
    /** Devolve os materiais originais e libera os clones. */
    restore() {
      this.reset();
      for (const r of records) {
        r.mesh.material = r.original;
        r.mesh.customDepthMaterial?.dispose(); r.mesh.customDistanceMaterial?.dispose();
        r.mesh.customDepthMaterial = r.prevDepth; r.mesh.customDistanceMaterial = r.prevDist;
        r.clones.forEach((m) => m.dispose());
      }
      records.length = 0;
    },
  };
}

/** Brasas: um único THREE.Points (1 chamada de desenho), aditivo; sobem com leve redemoinho e esfriam. */
export function createEmbers(scene, count = 600) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3), col = new Float32Array(count * 3);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const c = document.createElement('canvas'); c.width = c.height = 32;
  const g = c.getContext('2d'), grd = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.4, 'rgba(255,255,255,0.5)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 32, 32);
  const tex = new THREE.CanvasTexture(c);
  const mat = new THREE.PointsMaterial({ size: 0.075, map: tex, vertexColors: true, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, sizeAttenuation: true });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 8;
  scene.add(points);
  const life = new Float32Array(count), age = new Float32Array(count), vel = new Float32Array(count * 3), base = new Float32Array(count * 3);
  let next = 0;
  const hot = new THREE.Color(), warm = new THREE.Color(1, 0.85, 0.6);
  return {
    points,
    emit(x, y, z, tint) {
      const i = next++ % count;
      pos.set([x, y, z], i * 3);
      vel.set([(Math.random() - 0.5) * 0.5, 0.5 + Math.random() * 0.9, (Math.random() - 0.5) * 0.5], i * 3);
      hot.set(tint ?? 0xffa040).lerp(warm, 0.5).multiplyScalar(3.5);
      base.set([hot.r, hot.g, hot.b], i * 3);
      life[i] = 0.7 + Math.random() * 0.8; age[i] = 0;
    },
    update(dt, t) {
      for (let i = 0; i < count; i++) {
        if (life[i] <= 0) { col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 0; continue; }
        age[i] += dt;
        const u = age[i] / life[i];
        if (u >= 1) { life[i] = 0; continue; }
        const j = i * 3;
        vel[j] += Math.sin(t * 3 + i) * 0.4 * dt; vel[j + 2] += Math.cos(t * 2.6 + i) * 0.4 * dt;
        pos[j] += vel[j] * dt; pos[j + 1] += vel[j + 1] * dt; pos[j + 2] += vel[j + 2] * dt;
        const k = (1 - u) * (1 - u);
        col[j] = base[j] * k; col[j + 1] = base[j + 1] * k * (1 - 0.4 * u); col[j + 2] = base[j + 2] * k * (1 - 0.7 * u);
      }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.color.needsUpdate = true;
    },
    dispose() { points.removeFromParent(); geo.dispose(); mat.dispose(); tex.dispose(); },
  };
}
