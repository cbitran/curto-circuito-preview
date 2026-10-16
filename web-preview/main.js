import {rayToOctagon, beamsVisible} from './laser-geometry.mjs';
import { ArenaAudio } from './audio-mixer.mjs';
import { activeCells, nearestCell, pickSpawnCells, beamHitsCircle } from './match-logic.mjs';
import { createVolumeLight } from './volume-light.mjs';
import { makeDissolvable, createEmbers } from './dissolve.mjs';
// Curto-Circuito — prévia WebGL local (revisão visual, sem lógica de jogo/financeira real).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';

const params = new URLSearchParams(location.search);
// Qualidade máxima por padrão (diretriz do Celio: realismo cinematográfico; desempenho depois). ?rapido desliga GTAO e refração.
const CINEMA = !params.has('rapido');
const REF_MODE = params.has('ref');          // canvas only + câmera Blender exata
const ASSET = '../';                         // GLBs na pasta base (servida a partir de curto-circuito-conceitos/)
// Carrinho padrão: game-v3 (superfície limpa, aprovado pelo Codex). v2 não usar; v4 só com medição (?player=robo-laranja-game-v4.glb)
// Arena/torcida: v4 (aço refinado, grade de 16 casas por faixa, proposta visual). ?arena=v1|v2 só para comparação.
// v7 (fonte v15): 72 casas octogonais 8/8/16/16/24 + poço v2. v6 = estrutura/poço v1; v1–v5 têm tampa (só comparação).
const ARENA_VER = ['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8', 'v9', 'v10', 'v11'].includes(params.get('arena')) ? params.get('arena') : 'v11';
// Arquivos por versão da arena (Codex): poço, placement do jogador e manifesto de casas
const ASSET_SET = {
  v11: { pit:'arena-pit-v4.glb',venue:'v9',placement:'player-placement-v15.json',cells:'cell-layout-v15.json',bays:'arena-launch-bays-v2.glb',baysManifest:'launch-bays-v2.json' },
  // v10 (fonte v18): quatro entradas reais na fase 2; SEMPRE com arena-launch-bays-v1.glb (senão ficam 4 buracos abertos)
  v10: { pit: 'arena-pit-v4.glb', venue: 'v9', placement: 'player-placement-v15.json', cells: 'cell-layout-v15.json',
    bays: 'arena-launch-bays-v1.glb', baysManifest: 'launch-bays-v1.json' },
  v9: { pit: 'arena-pit-v4.glb', placement: 'player-placement-v15.json', cells: 'cell-layout-v15.json' },
  v8: { pit: 'arena-pit-v3.glb', placement: 'player-placement-v15.json', cells: 'cell-layout-v15.json' },
  v7: { pit: 'arena-pit-v2.glb', placement: 'player-placement-v15.json', cells: 'cell-layout-v15.json' },
  v6: { pit: 'arena-pit-v1.glb', placement: 'player-placement-v9.json', cells: null },
}[ARENA_VER] ?? { pit: null, placement: 'player-placement-v9.json', cells: null };
const PLAYER_FILE = /^robo-laranja-[\w-]+\.glb$/.test(params.get('player') || '') ? params.get('player') : 'robo-laranja-game-v3.glb';

// ---------- Câmera do Blender (Z-up) convertida para glTF/three (Y-up): (x, y, z)_B -> (x, z, -y) ----------
const blenderToThree = (x, y, z) => new THREE.Vector3(x, z, -y);
const CAM = {
  pos: blenderToThree(0, -18.2, 16.4),     // (0, 16.4, 18.2)
  target: blenderToThree(0, 0.4, 0),       // (0, 0, -0.4)
  orthoScale: 29.5,                        // mais respiro para o passadiço, vidro e arquibancadas
  shiftX: 0.16,                            // fração da largura
  refW: 1672, refH: 941,
};
const REF_VIEW_H = CAM.orthoScale * CAM.refH / CAM.refW;          // 14.914 unidades
const REF_CENTER_FRAC = 0.5 - CAM.shiftX;                          // centro óptico em 34% da largura

const PLAYABLE_R = 7.2;     // apótema do piso jogável medido (6,975) + faixa de LED/margem
const FIT_R = 8.9;          // inclui guarda-corpo/vidro para o enquadramento ajustado

// ---------- Renderer / cena ----------
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.AgXToneMapping;       // Blender usa AgX
renderer.toneMappingExposure = 0.9;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.info.autoReset = false;                    // somar todos os passes do composer

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x060b18);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.25;

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 120);
camera.position.copy(CAM.pos);
camera.up.set(0, 1, 0);
camera.lookAt(CAM.target);
camera.updateMatrixWorld();

// Luzes de prévia equivalentes às do build_arena.py (áreas do Blender -> direcional/pontual)
scene.add(new THREE.HemisphereLight(0x2a3d6e, 0x05070d, 0.3));
const key = new THREE.DirectionalLight(0xa1ccff, 1.25);
key.position.copy(blenderToThree(-5, -5, 14));
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
Object.assign(key.shadow.camera, { left: -11, right: 11, top: 11, bottom: -11, near: 1, far: 40 });
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.02;
key.shadow.radius = 3;                              // borda da sombra projetada mais macia (PCF)
scene.add(key);
const warm = new THREE.PointLight(0xffb180, 12, 30, 1.6);
warm.position.copy(blenderToThree(-6, 7, 8));
scene.add(warm);
const fill = new THREE.DirectionalLight(0x52a6ff, 0.5);
fill.position.copy(blenderToThree(5, 7, 11));
scene.add(fill);

// Pós-processamento: bloom moderado só em valores HDR (LEDs/lasers)
// MSAA no render target do composer: o antialias do canvas não vale para o RenderPass fora da tela
const msaaTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
const composer = new EffectComposer(renderer, msaaTarget);
composer.addPass(new RenderPass(scene, camera));
// Oclusão de ambiente (contato dos robôs com o piso, cantos da arena). No passe interno de profundidade/normais os efeitos
// aditivos e transparentes (lasers, volumes, fumaça, vidro) ficam ocultos para não gerar halos escuros falsos.
const gtao = new GTAOPass(scene, camera, 1, 1);
gtao.enabled = CINEMA;
gtao.updateGtaoMaterial({ radius: 0.45, distanceExponent: 1.4, thickness: 1.2, scale: 1.15, samples: 16 });
gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
{
  const renderInner = gtao.render.bind(gtao), hidden = [];
  gtao.render = (...args) => {
    scene.traverse((o) => {
      const m = o.material;
      if ((o.isMesh || o.isSprite || o.isPoints) && o.visible && m && !Array.isArray(m) && (m.depthWrite === false || m.blending === THREE.AdditiveBlending)) { o.visible = false; hidden.push(o); }
    });
    try { renderInner(...args); } finally { for (const o of hidden) o.visible = true; hidden.length = 0; }
  };
}
composer.addPass(gtao);
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.28, 0.24, 1.2);  // limiar acima da luminância dos LEDs (~2,0): brilho só em lasers/óticas
composer.addPass(bloom);
composer.addPass(new OutputPass());

// ---------- Estado ----------
const loader = new GLTFLoader();
const phaseGroups = new Map();      // phase_index -> Group
const dropOrder = [5, 4, 3, 2];
let dropped = 0;
const falling = [];                 // animações em curso
let venue = null;
let lasersOn = true;            // varredura contínua: só no estado Inspeção
// Rodada demonstrativa (MECANICA-ORIGINAL-OBSERVADA.md + explicação do Celio, 15/10):
// começa só com o jogador; ele escolhe uma casa; os 4 adversários surgem em casas restantes; disparo simultâneo;
// laser que cruza o jogador = curto-circuito/fim de jogo. Sorteio de posições/direções só VISUAL no navegador —
// no jogo real é do servidor. Sem aposta, saldo ou pagamento.
let reviewState = 'posicionamento';   // 'inspecao' | 'posicionamento' | 'revelacao' | 'disparo'
const STEP16 = Math.PI / 8;     // 16 direções
const ROBOT_MIN_DIST = 1.3;     // centro a centro: maior vão (Rubi 1,29; jogador 1,25) => sem sobreposição
const PLAYER_HIT_R = 0.62;      // meio vão do carrinho (1,25 / 2) para o teste de acerto
let cells = [];                 // casas da grade visual da prévia (não topologia confirmada do original)
let playerRig = null, playerCell = null, playerHomeCell = null, playerMove = null, playerFell = false;
let spawned = false, gameOver = false;
let lite = false;
const ENEMIES = [
  // emitter: altura/avanço do nó de mira no GLB (Rubi "Laser emitter"; demais "Optic …"), frente +Z
  { id: 'rubi', file: 'enemies/rubi.glb', color: 0xff3b4e, lift: 0.004, emitY: 0.70, emitZ: 0.39 },
  { id: 'lima', file: 'enemies/lima.glb', color: 0x38e36b, lift: 0.004, emitY: 0.68, emitZ: 0.50 },
  { id: 'ambar', file: 'enemies/ambar.glb', color: 0xffa21f, lift: 0.004, emitY: 0.83, emitZ: 0.47 },
  { id: 'violeta', file: 'enemies/violeta.glb', color: 0xa44bff, lift: 0.22, emitY: 0.80, emitZ: 0.46 },
];
const enemySlots = [];
const lasers = [];
let playerEmitter = null;

const loadGLB = (url) => new Promise((res, rej) => loader.load(url, res, undefined, rej));

function prepShadows(root) {
  root.traverse((o) => {
    if (o.isMesh) {
      const m=o.material;
      const transparent = m && (m.transparent || m.transmission > 0);
      // Thin safety glass needs transparency and reflections; full-scene refraction is optional.
      if (m?.transmission > 0) {
        m.userData.transmission=m.transmission;
        if (!CINEMA && !params.has('refraction')) {m.transmission=0;m.transparent=true;m.depthWrite=false;}   // refração física por padrão
      }
      const luminous = /^(LED |Gameplay |Pit \| recessed)/.test(m?.name || '');
      o.castShadow = !transparent && !luminous;
      o.receiveShadow = !luminous;
    }
  });
}

function groundOnly(root, lift) {
  root.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(root);
  const wrapper = new THREE.Group();
  root.position.y += lift - b.min.y;
  wrapper.add(root);
  return wrapper;
}

// Manifesto de casas (Codex, ex.: cell-layout-v15.json): { cells: [{ phase, index, three: [x, y, z], radius }], player_cell }.
// Sem manifesto, as casas são extraídas da malha (abaixo).
async function loadCellManifest(root) {
  if (!ASSET_SET.cells) return null;
  const m = await fetch(ASSET + ASSET_SET.cells).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!m?.cells?.length) return null;
  // centros, fase e raio do manifesto; orientação (vértice) e lados vêm da malha da casa mais próxima
  const mesh = extractCells(root);
  const out = m.cells.map((c, i) => {
    const [x, , z] = c.three;
    let best = null, bd = 0.2;
    for (const e of mesh) { const d = Math.hypot(e.x - x, e.z - z); if (d < bd) { bd = d; best = e; } }
    return { id: c.index ?? i, phase: c.phase, x, z, radius: best?.radius ?? c.radius, sides: best?.sides ?? 8,
      corner: best?.corner ?? Math.PI / 8, matched: !!best };
  });
  out.playerCell = m.player_cell;
  return out;
}

// Convenções de efeitos para os GLBs do Codex (nomes de material ou de nó):
//   "FX | …" ou "VolumeBeam | …"  → aditivo, sem escrita de profundidade, dupla face, sem sombra (fachos volumétricos leves)
//   luzes KHR_lights_punctual      → mantidas, sem sombra; no máximo 4 (o resto desligado) para preservar desempenho
let punctualLights = 0;
// Neon: os GLBs v7 trazem emissão 6–7 (calibrada no Cycles). No navegador, com AgX + bloom, isso estoura em branco;
// escala para manter o núcleo colorido e um halo moderado (lasers continuam bem mais fortes).
const NEON_SCALE = [[/subtle floor/i, 0.25], [/^LED \|/i, 0.44], [/^Venue \| warm lights/i, 0.5]];
const neonDone = new WeakSet();
function applyFxConventions(root) {
  root.traverse((o) => {
    if (o.isLight) { o.castShadow = false; o.visible = ++punctualLights <= 4; return; }
    if (!o.isMesh) return;
    const mat = o.material;
    if (mat && !neonDone.has(mat) && mat.emissiveIntensity > 3) {
      const rule = NEON_SCALE.find(([re]) => re.test(mat.name));
      if (rule) mat.emissiveIntensity *= rule[1];
      neonDone.add(mat);
    }
    const tag = `${o.name} ${o.material?.name ?? ''}`;
    if (/(^|\s)(FX|VolumeBeam) \|/.test(tag)) {
      o.material.transparent = true; o.material.blending = THREE.AdditiveBlending; o.material.depthWrite = false;
      o.material.side = THREE.DoubleSide; o.castShadow = false; o.receiveShadow = false; o.renderOrder = 7;
    }
  });
}

// Casas = componentes conectados da malha "Gameplay | dim cyan" (contorno do hexágono; o ponto central é descartado)
function extractCells(root) {
  const out = [], v = new THREE.Vector3();
  root.traverse((o) => {
    if (!o.isMesh || !/Gameplay \| dim cyan/.test(o.material.name)) return;
    const phase = o.userData.phase_index ?? o.parent?.userData?.phase_index ?? 0;
    const g = o.geometry, pos = g.attributes.position, n = pos.count;
    const ids = new Map(), vid = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(pos, i);
      const k = `${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)}`;
      if (!ids.has(k)) ids.set(k, ids.size);
      vid[i] = ids.get(k);
    }
    const par = [...Array(ids.size).keys()];
    const f = (a) => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
    const idx = g.index ? g.index.array : [...Array(n).keys()];
    for (let t = 0; t < idx.length; t += 3) { const a = f(vid[idx[t]]); par[f(vid[idx[t + 1]])] = a; par[f(vid[idx[t + 2]])] = a; }
    const comps = new Map();
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      const r = f(vid[i]), c = comps.get(r) || { x: 0, z: 0, k: 0, x0: 1e9, x1: -1e9, pts: [] };
      c.x += v.x; c.z += v.z; c.k++; c.x0 = Math.min(c.x0, v.x); c.x1 = Math.max(c.x1, v.x); c.pts.push(v.x, v.z);
      comps.set(r, c);
    }
    for (const c of comps.values()) {
      if (c.x1 - c.x0 <= 0.15) continue;
      const cx = c.x / c.k, cz = c.z / c.k;
      // canto do hexágono = vértice mais distante do centro: dá orientação e raio reais da casa
      let rMax = 0, corner = 0;
      for (let i = 0; i < c.pts.length; i += 2) {
        const d = Math.hypot(c.pts[i] - cx, c.pts[i + 1] - cz);
        if (d > rMax) { rMax = d; corner = Math.atan2(c.pts[i + 1] - cz, c.pts[i] - cx); }
      }
      // lados: vértices no contorno externo (≥ 97% do raio), agrupados por ângulo
      const ang = new Set();
      for (let i = 0; i < c.pts.length; i += 2) {
        const d = Math.hypot(c.pts[i] - cx, c.pts[i + 1] - cz);
        if (d >= rMax * 0.97) ang.add(Math.round(Math.atan2(c.pts[i + 1] - cz, c.pts[i] - cx) * 180 / Math.PI / 6));
      }
      out.push({ phase, x: cx, z: cz, radius: rMax, corner, sides: ang.size >= 7 ? 8 : 6 });
    }
  });
  return out;
}

// ---------- Entradas de lançamento (Codex, v18): portas baixam e deslizam, elevador sobe com o robô ----------
// Raízes LAUNCH_BAY_n presas à faixa 2 (caem junto), posições globais preservadas; sem escala nem reparentesco de folhas.
const bays = [];
let baysManifest = null;
const norm = (n) => (n ?? '').replace(/[\s|_]+/g, '').toLowerCase();          // GLTFLoader pode sanitizar espaços/pipe
async function loadLaunchBays() {
  const [gltf, man] = await Promise.all([
    loadGLB(ASSET + ASSET_SET.bays),
    fetch(ASSET + ASSET_SET.baysManifest).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  if (!man) { console.warn('launch-bays: manifesto ausente'); return; }
  baysManifest = man;
  if (man.clear_width) BAY_APOTHEM = man.clear_width / 2;
  const byName = new Map();
  gltf.scene.traverse((o) => { byName.set(norm(o.userData?.name ?? o.name), o); byName.set(norm(o.name), o); });
  const group = phaseGroups.get(man.phase);
  scene.add(gltf.scene); gltf.scene.updateMatrixWorld(true);
  for (const b of man.bays) {
    const root = byName.get(norm(b.root)), left = byName.get(norm(b.left)), right = byName.get(norm(b.right)), lift = byName.get(norm(b.lift));
    if (!root || !left || !right || !lift) { console.warn('launch-bays: nó ausente', b); continue; }
    (group ?? scene).attach(root);
    prepShadows(root);
    const cell = cells.find((c) => c.phase === b.phase && Math.hypot(c.x - b.position_three[0], c.z - b.position_three[2]) < 0.05) ?? null;
    bays.push({ ...b, rootObj: root, leftObj: left, rightObj: right, liftObj: lift, cell, busy: false, anim: null });
  }
  scene.remove(gltf.scene);
  closeBaysInstant();
}
function closeBaysInstant() {
  const d = baysManifest?.doors_three, l = baysManifest?.lift_three;
  for (const b of bays) {
    b.anim = null; b.busy = false;
    b.leftObj.position.set(0, d.closed_y, b.leftObj.position.z);
    b.rightObj.position.set(0, d.closed_y, b.rightObj.position.z);
    b.liftObj.position.y = l.bottom_y;
  }
}

async function loadArena() {
  const gltf = await loadGLB(ASSET + `curto-circuito-arena-game-${ARENA_VER}.glb`);
  const root = gltf.scene;
  scene.add(root);
  root.updateMatrixWorld(true);
  cells = (await loadCellManifest(root)) ?? extractCells(root);
  applyFxConventions(root);
  tuneGlass(root);
  const nodes = [...root.children];
  for (const n of nodes) {
    const p = n.userData?.phase_index ?? 0;
    if (p < 2) continue;                          // 0 estático, 1 centro: permanecem
    if (!phaseGroups.has(p)) {
      const g = new THREE.Group();
      g.name = `Phase ${p} group`;
      root.add(g);
      phaseGroups.set(p, g);
    }
    // Material próprio por faixa para o aviso piscante não afetar as demais
    n.traverse((o) => { if (o.isMesh) o.material = o.material.clone(); });
    phaseGroups.get(p).attach(n);
  }
  for (const g of phaseGroups.values()) {
    g.userData.emissive = [];
    g.traverse((o) => { if (o.isMesh && o.material.emissiveIntensity !== undefined) g.userData.emissive.push([o.material, o.material.emissiveIntensity]); });
  }
  prepShadows(root);
  buildExteriorEmitterLights(root);
  // Poço sem fundo iluminado (Codex): permanente, independente da Torcida e das fases; coordenadas globais, sem ajuste.
  if (ASSET_SET.bays) await loadLaunchBays();
  if (ASSET_SET.pit) {
    const pit = (await loadGLB(ASSET + ASSET_SET.pit)).scene;
    applyFxConventions(pit);
    pit.name = 'Poço';
    pit.traverse((o) => { if (o.isMesh) { o.receiveShadow = true; o.castShadow = false; } });
    scene.add(pit);
  }
  return root;
}

// Posicionamento exato do jogador: ../player-placement-v9.json (Codex), extraído de curto-circuito-aco-refinado-v9.blend
// e conferido por reimportação (erro máx. de bounds 0,00011 u). A matriz vai no gltf.scene; os transforms
// filhos nativos ficam intactos — sem zerar posição, sem escala/rotação extra e sem centralização.
// (A compensação anterior — vão 1,25, rot −0,45 e centro (0,5915; 1,2822) medido com o lite-v1 — foi abandonada.)
let playerCenter = new THREE.Vector3(1.55, 0.542, 1.2);
async function loadPlayer() {
  const [gltf, placement] = await Promise.all([
    loadGLB(ASSET + PLAYER_FILE),
    fetch(ASSET + ASSET_SET.placement).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  const root = gltf.scene;
  if (placement && placement.asset === PLAYER_FILE) {
    root.matrixAutoUpdate = false;
    root.matrix.fromArray(placement.matrix_column_major);
    root.matrix.decompose(root.position, root.quaternion, root.scale);
    root.matrixAutoUpdate = true;
  } else {
    // Arquivo sem placement correspondente (ex.: ?player=…v4): carregado só com transforms nativos, sem compensação.
    console.warn(`${ASSET_SET.placement} não corresponde a ${PLAYER_FILE}; usando transforms nativos do GLB.`);
    toast(`Sem placement para ${PLAYER_FILE}: posição nativa do GLB`);
  }
  root.name = 'Jogador laranja';
  root.updateMatrixWorld(true);
  new THREE.Box3().setFromObject(root).getCenter(playerCenter);
  prepShadows(root);
  scene.add(root);
  // Locate the front surface on the imported car, without changing its native transforms.
  const box = new THREE.Box3().setFromObject(root);
  const ray = new THREE.Raycaster(new THREE.Vector3(playerCenter.x, box.min.y + .52, box.max.z + 1), new THREE.Vector3(0, 0, -1));
  const surface = ray.intersectObject(root, true)[0];
  if (surface) {
    playerEmitter = new THREE.Group();
    playerEmitter.name = 'Player laser emitter';
    playerEmitter.position.copy(surface.point).add(new THREE.Vector3(0, 0, .018));
    playerEmitter.userData = {id:'player', color:0x39ddff, isPlayer:true, lift:0, emitY:playerEmitter.position.y, emitZ:0};
    const lens = new THREE.Mesh(new THREE.SphereGeometry(.025, 12, 8), new THREE.MeshBasicMaterial({color:new THREE.Color(0x39ddff).multiplyScalar(3)}));
    playerEmitter.add(lens);
    scene.add(playerEmitter);
  } else throw new Error('Não foi possível localizar o emissor na superfície do jogador.');
  // Rig de movimento: carrinho + emissor andam juntos (o emissor acompanha posição/rotação do carrinho).
  playerRig = new THREE.Group();
  playerRig.name = 'Jogador (rig)';
  playerRig.position.set(playerCenter.x, 0, playerCenter.z);
  scene.add(playerRig);
  playerRig.attach(root);
  playerRig.attach(playerEmitter);
  playerRig.rotation.order = 'YXZ';                        // guinada, depois arfagem (nariz) no eixo local
  playerHomeCell = playerCell = nearestCell(cells, playerCenter.x, playerCenter.z, 0.3);
  // Ponta da antena = vértice mais alto; rodas traseiras = cantos inferiores de trás (−Z local)
  playerRig.updateMatrixWorld(true);
  const v = new THREE.Vector3(), top = new THREE.Vector3(0, -1e9, 0), lb = new THREE.Box3();
  root.traverse((o) => {
    if (!o.isMesh) return;
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      playerRig.worldToLocal(v);
      lb.expandByPoint(v);
      if (v.y > top.y) top.copy(v);
    }
  });
  beacon = new THREE.Mesh(new THREE.SphereGeometry(0.042, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffb02e, toneMapped: true }));
  beacon.userData.base = new THREE.Color(0xffb02e);
  beacon.position.copy(top).add(new THREE.Vector3(0, -0.03, 0));   // centro da bolinha, logo abaixo do topo
  beacon.name = 'Luz da antena (sobreposição)';
  playerRig.add(beacon);
  playerRig.userData.rearWheels = [new THREE.Vector3(lb.min.x + 0.12, 0, lb.min.z + 0.15), new THREE.Vector3(lb.max.x - 0.12, 0, lb.min.z + 0.15)];
  playerRig.userData.localBox = lb;
  playerDissolve = makeDissolvable(root, 0x7fefff);         // carrinho do jogador: dissipa em ciano quente ao perder
  addContactShadow(playerRig, lb);
  return root;
}

async function toggleVenue(on) {
  if (on && !venue) {
    const gltf = await loadGLB(ASSET + `curto-circuito-venue-game-${ASSET_SET.venue ?? ARENA_VER}.glb`);
    venue = gltf.scene;
    applyFxConventions(venue);
    venue.traverse((o) => {
      if (o.isMesh) { o.receiveShadow = true; o.castShadow = false; }
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
        if (/Venue \| warm lights/i.test(m?.name ?? '') && m.emissiveIntensity !== undefined) m.emissiveIntensity = Math.max(m.emissiveIntensity, 1.8);
      }
    });
    scene.add(venue);
    // The source grandstand is a two-sided corner. Continue it around the arena with a
    // matched opposite copy; share its meshes/materials and omit the oversized ground.
    venue.updateMatrixWorld(true);
    const farStand = new THREE.Group(); farStand.name = 'Arquibancada oposta, continuação';
    venue.traverse((o) => {
      if (!o.isMesh || /dark hangar floor|deep blue graphite/i.test(o.material?.name ?? '')) return;
      const copy = o.clone(); copy.matrix.copy(o.matrixWorld); copy.matrix.decompose(copy.position, copy.quaternion, copy.scale);
      copy.geometry = o.geometry; copy.material = o.material; copy.castShadow = false; copy.receiveShadow = true;
      farStand.add(copy);
    });
    farStand.rotation.y = Math.PI; scene.add(farStand);
    buildArenaGlass(); buildArenaSurroundings();
  }
  if (venue) venue.visible = on;
}

// ---------- Adversários (opcionais; Codex entrega os GLBs) ----------
function buildSlots(playerAngle) {
  ENEMIES.forEach((e, i) => {
    const a = playerAngle + (i + 1) * (Math.PI * 2 / 5);
    const r = 1.7;   // pegada máx. 0,65 u (Rubi) => borda 2,35 < apótema do centro 2,395
    const slot = new THREE.Group();
    slot.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    slot.lookAt(0, 0, 0);
    slot.userData = { ...e, angle: a, model: null };
    // anel de identificação no piso (não substitui o modelo)
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.74, 0.78, 48),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(e.color).multiplyScalar(1.6), transparent: true, opacity: 0.85, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.012;
    slot.add(ring);
    scene.add(slot);
    enemySlots.push(slot);
  });
}

// Emissores reais: enemies/animation-contract-v1.json (Codex) dá o nome do nó; usa-se a posição dele no modelo carregado.
let enemyContract = null;
async function loadEnemies() {
  enemyContract = await fetch(ASSET + 'enemies/animation-contract-v1.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  await Promise.all(enemySlots.map(async (slot) => {
    const chip = document.querySelector(`.roster li[data-enemy="${slot.userData.id}"]`);
    try {
      const gltf = await loadGLB(ASSET + slot.userData.file + `?t=${Date.now()}`);
      if (slot.userData.model) slot.remove(slot.userData.model);
      // Modelos do Codex já vêm em escala de jogo: só apoiar no piso (Violeta flutua 0,22 u como em stage_enemies.py)
      const m = groundOnly(gltf.scene, slot.userData.lift);
      prepShadows(m);
      slot.add(m);
      slot.userData.model = m;
      slot.userData.dissolve = makeDissolvable(m, new THREE.Color(slot.userData.color).lerp(new THREE.Color(0xffa040), 0.55));
      if (!slot.userData.shadowed) { addContactShadow(slot, localBoxOf(slot, m), slot.userData.lift > 0.1 ? 0.22 : 0); slot.userData.shadowed = true; }
      // Ponto de saída do laser no espaço do slot: centro da lente + 0,03 à frente (+Z), para sair da superfície
      const node = enemyContract?.[slot.userData.id] && m.getObjectByName(enemyContract[slot.userData.id].emitter_node);
      slot.updateMatrixWorld(true);
      slot.userData.emitLocal = node
        ? slot.worldToLocal(node.getWorldPosition(new THREE.Vector3())).add(new THREE.Vector3(0, 0, 0.03))
        : new THREE.Vector3(0, slot.userData.lift + slot.userData.emitY, slot.userData.emitZ);   // reserva: offsets aproximados
      chip.classList.remove('missing');
    } catch {
      chip.classList.add('missing');
    }
  }));
}

// ---------- Lasers demonstrativos (finos: núcleo HDR + halo aditivo) ----------
// Inimigos: lasers MUITO fortes (pedido do Celio) — núcleo HDR quase branco tingido + halo médio + brilho externo
// largo (aditivos) + impacto. Jogador: intensidade anterior, moderada.
const LASER_STYLE = {
  enemy: { core: 0.022, coreHdr: 8, coreWhite: 0.4, halo: 0.06, haloOp: 0.5, haloHdr: 2.2, glow: 0.13, glowOp: 0.09, hit: 0.08 },
  player: { core: 0.014, coreHdr: 4.5, coreWhite: 0.35, halo: 0.05, haloOp: 0.22, haloHdr: 1.3, glow: 0, glowOp: 0, hit: 0.045 },
};
const beamGeo = (r, seg) => new THREE.CylinderGeometry(r, r, 1, seg, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.5);
function softenBeamTip(material) {
  material.transparent = true;
  material.depthWrite = false;
  material.blending = THREE.AdditiveBlending;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vBeamAlong;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBeamAlong = position.z;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vBeamAlong;')
      .replace('#include <opaque_fragment>', '#include <opaque_fragment>\n  gl_FragColor.a *= 1.0 - smoothstep(0.84, 1.0, vBeamAlong);');
  };
  material.customProgramCacheKey = () => 'laser-tip-fade-v1';
  return material;
}
function buildLasers() {
  for (const slot of [...enemySlots, ...(playerEmitter ? [playerEmitter] : [])]) {
    const st = slot.userData.isPlayer ? LASER_STYLE.player : LASER_STYLE.enemy;
    const c = new THREE.Color(slot.userData.color);
    const add = (hdr, op) => new THREE.MeshBasicMaterial({ color: c.clone().multiplyScalar(hdr), transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthWrite: false });
    const g = new THREE.Group();
    g.add(new THREE.Mesh(beamGeo(st.core, 10), softenBeamTip(new THREE.MeshBasicMaterial({ color: c.clone().lerp(new THREE.Color(1, 1, 1), st.coreWhite).multiplyScalar(st.coreHdr) }))));
    g.add(new THREE.Mesh(beamGeo(st.halo, 12), add(st.haloHdr, st.haloOp)));
    if (st.glow) g.add(new THREE.Mesh(beamGeo(st.glow, 14), add(st.haloHdr, st.glowOp)));
    const hit = new THREE.Mesh(new THREE.SphereGeometry(st.hit, 14, 10), add(st.haloHdr * 2, Math.min(1, st.haloOp * 1.4)));
    hit.position.y = 0.015;
    const aim = new THREE.Group();                                        // linha de mira fina (antes do disparo)
    aim.add(new THREE.Mesh(beamGeo(0.009, 6), softenBeamTip(add(st.haloHdr * 1.6, 0.6))));
    aim.visible = false;
    scene.add(g, hit, aim);
    lasers.push({ g, hit, aim, slot, phase: Math.random() * 6 });
  }
}

const _dir = new THREE.Vector3(), _o = new THREE.Vector3(), _e = new THREE.Vector3(), _w = new THREE.Vector3();
function updateLasers(t) {
  for (const L of lasers) {
    const u = L.slot.userData;
    const inspect = reviewState === 'inspecao';
    // Posicionamento: só o jogador; adversários aparecem a partir da Revelação (e atingidos não voltam)
    L.slot.visible = u.isPlayer ? !playerFell && !playerGone : (reviewState !== 'posicionamento' && spawned && !u.gone && (!u.dead || !!u.dissolving));
    L.slot.getWorldPosition(_w);
    // Jogador: frente +Z girada pelo rig. Inspeção: varredura opcional (efeito). Demais: direção sorteada (visual) entre 16.
    const a = u.isPlayer ? playerAimAngle()
      : inspect ? u.angle + Math.sin(t * 0.6 + L.phase) * 0.9 : u.aim;
    _dir.set(Math.cos(a), 0, Math.sin(a));
    if (!u.isPlayer && !u.driving) { L.slot.rotation.set(0, Math.atan2(_dir.x, _dir.z), 0); L.slot.updateMatrixWorld(true); }   // frente +Z = direção do laser
    // arma desligada assim que a dissipação começa (o robô ainda aparece se desfazendo, mas não atira mais)
    const armed = u.isPlayer ? !playerFell && !playerDissolve?.active && !playerGone : !u.dissolve?.active && !u.gone;
    const beams = beamsVisible(reviewState, lasersOn) && L.slot.visible && !playerMove && armed;
    const aimLine = aimLinesOn && L.slot.visible && !(u.isPlayer && playerFell);   // linhas de mira antes do disparo
    L.g.visible = L.hit.visible = beams;
    L.aim.visible = aimLine;
    if (!beams && !aimLine) continue;
    if (u.isPlayer) _o.copy(_w);
    else if (u.emitLocal) L.slot.localToWorld(_o.copy(u.emitLocal));   // nó emissor real do GLB
    else { _o.copy(_w).addScaledVector(_dir, u.emitZ); _o.y = u.lift + u.emitY; }
    const len = rayToOctagon(_w.x, _w.z, _dir.x, _dir.z, currentRadius());
    _e.copy(_w).addScaledVector(_dir, len); _e.y = _o.y;         // feixe horizontal: altura constante do emissor
    for (const m of [L.g, L.aim]) { m.position.copy(_o); m.lookAt(_e); m.scale.set(1, 1, _o.distanceTo(_e)); }
    L.aim.children[0].material.opacity = 0.35 + 0.35 * Math.sin(t * 14 + L.phase);
    L.hit.position.copy(_e);
  }
}
// ---------- Rodada demonstrativa: jogador, surgimento, acerto ----------
const activePhases = () => [1, ...dropOrder.slice(dropped)];
function placePlayer(cell) {
  if (!cell || !playerRig) return;
  playerRig.position.set(cell.x, 0, cell.z);
  playerCell = cell;
}
// Movimento orgânico: gira no lugar até ficar de frente para a casa, acelera, anda reto, freia (nariz abaixa,
// fumaça nas rodas traseiras) e se acomoda. Frente do carrinho = +Z local (mesmo eixo do emissor do jogador).
const TURN_RATE = 3.6;                     // rad/s no giro no lugar
const V_MAX = 3.4, ACCEL = 5.5, DECEL = 8;  // u/s, u/s² — perfil trapezoidal
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
function movePlayerTo(cell) {
  if (!cell || !playerRig || cell === playerCell) return;
  const from = playerRig.position.clone(), to = new THREE.Vector3(cell.x, 0, cell.z);
  const D = from.distanceTo(to);
  const heading = Math.atan2(to.x - from.x, to.z - from.z);
  const yaw0 = playerRig.rotation.y, dYaw = wrapPi(heading - yaw0);
  const tTurn = Math.max(0.12, Math.abs(dYaw) / TURN_RATE);
  // trapezoide (ou triângulo, se a distância for curta)
  let vPeak = V_MAX, tA = V_MAX / ACCEL, tD = V_MAX / DECEL;
  let dA = 0.5 * ACCEL * tA * tA, dD = 0.5 * DECEL * tD * tD;
  if (dA + dD > D) { vPeak = Math.sqrt(2 * D * ACCEL * DECEL / (ACCEL + DECEL)); tA = vPeak / ACCEL; tD = vPeak / DECEL; dA = 0.5 * ACCEL * tA * tA; dD = D - dA; }
  const tC = Math.max(0, (D - dA - dD) / vPeak);
  playerMove = { from, to, D, dir: to.clone().sub(from).normalize(), yaw0, dYaw, tTurn, tA, tC, tD, vPeak, t0: performance.now(), smokeAt: 0 };
  playerSettle = null;
  playerCell = cell;
  // a mira é montada na casa escolhida no instante do toque, virada para o centro do octógono (pedido do Celio)
}
let playerSettle = null;
function updatePlayerMove(now) {
  if (playerSettle) {                                      // acomodação: balanço amortecido do nariz
    const t = (now - playerSettle.t0) / 1000;
    playerRig.rotation.x = playerSettle.amp * Math.exp(-6 * t) * Math.cos(16 * t);
    if (t > 0.8) { playerRig.rotation.x = 0; playerSettle = null; }
  }
  if (!playerMove) return;
  const m = playerMove, t = (now - m.t0) / 1000;
  if (t < m.tTurn) {                                       // 1) gira no lugar
    const u = t / m.tTurn, k = u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2;
    playerRig.rotation.y = m.yaw0 + m.dYaw * k;
    return;
  }
  playerRig.rotation.y = m.yaw0 + m.dYaw;
  const td = t - m.tTurn;                                  // 2) acelera, anda, freia
  let s, pitch = 0, braking = false;
  if (td < m.tA) { s = 0.5 * ACCEL * td * td; pitch = -0.035 * (td / m.tA); }                 // traseira abaixa ao acelerar
  else if (td < m.tA + m.tC) { s = 0.5 * ACCEL * m.tA ** 2 + m.vPeak * (td - m.tA); }
  else if (td < m.tA + m.tC + m.tD) {
    const tb = td - m.tA - m.tC;
    s = 0.5 * ACCEL * m.tA ** 2 + m.vPeak * m.tC + m.vPeak * tb - 0.5 * DECEL * tb * tb;
    pitch = 0.06 * Math.sin(Math.PI * Math.min(1, tb / m.tD * 0.9)); braking = true;           // nariz abaixa na frenagem
  } else {                                                 // 3) chegou de frente: acomoda
    playerRig.position.copy(m.to);
    playerRig.rotation.x = 0;
    playerSettle = { t0: now, amp: 0.045 };
    playerMove = null;
    aimToCenterFrom(playerCell);                           // 4) chegou: vira para o centro e o feixe gira junto
    return;
  }
  playerRig.position.copy(m.from).addScaledVector(m.dir, Math.min(s, m.D));
  playerRig.rotation.x = pitch;
  if (braking && now - m.smokeAt > 35) { m.smokeAt = now; emitBrakeSmoke(); }
}
// Surgimento aleatório em qualquer casa ativa, sem sobrepor o jogador nem entre inimigos.
function spawnEnemies() {
  const alive = enemySlots.filter((s) => !s.userData.dead);
  const act = activeCells(cells, activePhases());
  // Usa a posição física atual do jogador, e não a identidade do objeto da casa:
  // isso também cobre o instante em que a animação de movimento acabou de assentar.
  const occupied = playerRig ? [{ x: playerRig.position.x, z: playerRig.position.z }] : [];
  const pool = act;
  // com poucas casas (ex.: centro com 8), relaxa a distância mínima aos poucos antes de desistir
  let picks = [];
  for (const minD of [ROBOT_MIN_DIST, 1.15, 1.0, 0.85]) {
    picks = pickSpawnCells(pool, occupied, alive.length, minD);
    if (picks.length === alive.length) break;
  }
  if (picks.length < alive.length) { spawned = false; toast('Sem casas livres suficientes para os adversários'); return; }
  alive.forEach((slot, i) => {
    const c = picks[i];
    slot.position.set(c.x, 0, c.z);
    slot.userData.cell = c;
    slot.userData.gone = false;
    slot.userData.angle = Math.atan2(c.z, c.x);                                 // referência da varredura (Inspeção)
    // Como no original: nunca mira para fora — peso proporcional às casas que o laser cruzaria (sorteio só VISUAL)
    const weights = Array.from({ length: 16 }, (_, k) => cellsCrossed(c.x, c.z, k * STEP16, act).length);
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total, k = 0;
    if (total > 0) { while (r >= weights[k]) { r -= weights[k]; k++; } } else k = Math.floor(Math.random() * 16);
    slot.userData.aim = k * STEP16;
  });
  spawned = true;
}
// Casas (das fases ativas) no corredor de um laser saindo de (x, z) no ângulo a, até a grade
const LASER_REACH = 0.42;
function cellsCrossed(x, z, a, pool, skip = null) {
  const dx = Math.cos(a), dz = Math.sin(a), len = rayToOctagon(x, z, dx, dz, currentRadius());
  return pool.filter((c) => {
    if (c === skip) return false;
    const ex = c.x - x, ez = c.z - z, along = ex * dx + ez * dz, across = Math.abs(ex * dz - ez * dx);
    return along > 0.3 && along <= len && across <= LASER_REACH;
  });
}
function setGameOver(hit) {
  const over = hit || playerFell;
  if (over !== gameOver) { gameOver = over; updateMatchStatus(); }
}
function updateMatchStatus() {
  const el = $('matchStatus');
  let msg = '', cls = '';
  if (playerFell) { msg = 'O jogador estava na faixa que caiu · fim de jogo (demonstração)'; cls = 'over'; }
  else if (matchResult) { msg = matchResult.msg; cls = matchResult.cls; }
  if (el.textContent !== msg) el.textContent = msg;
  if (el.className !== 'match-status ' + cls) el.className = 'match-status ' + cls;
}
// Curto-circuito visual no carrinho: emissivo ciano piscando enquanto atingido
let playerMats = null;
function updatePlayerFx(now) {
  if (!playerRig) return;
  if (!playerMats) { playerMats = []; playerRig.traverse((o) => { if (o.isMesh && o.material.emissive) playerMats.push([o.material, o.material.emissive.clone()]); }); }
  const on = gameOver && !playerFell;
  const k = on ? 0.35 + 0.65 * (Math.sin(now / 45) > 0 ? 1 : 0.2) : 0;
  for (const [m, base] of playerMats) {
    if (on) m.emissive.setRGB(0.25 * k, 0.9 * k, 1.2 * k); else m.emissive.copy(base);
  }
}

// ---------- Fumaça de frenagem (sprites suaves, pool fixo) ----------
const smokeTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), grd = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  grd.addColorStop(0, 'rgba(255,255,255,0.9)'); grd.addColorStop(0.5, 'rgba(255,255,255,0.35)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
})();
const smoke = Array.from({ length: 36 }, () => {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: smokeTex, color: 0xb9c4d2, transparent: true, opacity: 0, depthWrite: false }));
  sp.visible = false; sp.userData = { t0: 0, life: 0, vel: new THREE.Vector3() }; scene.add(sp); return sp;
});
let smokeIdx = 0;
const _rear = new THREE.Vector3();
function emitBrakeSmoke() {
  if (!playerRig?.userData.rearWheels) return;
  for (const local of playerRig.userData.rearWheels) {
    const sp = smoke[smokeIdx++ % smoke.length];
    playerRig.localToWorld(_rear.copy(local));
    sp.position.set(_rear.x + (Math.random() - 0.5) * 0.05, 0.06, _rear.z + (Math.random() - 0.5) * 0.05);
    const back = new THREE.Vector3(-Math.sin(playerRig.rotation.y), 0, -Math.cos(playerRig.rotation.y));
    sp.userData.vel.copy(back).multiplyScalar(0.25 + Math.random() * 0.2).add(new THREE.Vector3((Math.random() - 0.5) * 0.25, 0.35 + Math.random() * 0.2, (Math.random() - 0.5) * 0.25));
    sp.userData.t0 = performance.now(); sp.userData.life = 700 + Math.random() * 400;
    sp.visible = true;
  }
}
function updateSmoke(now, dt) {
  for (const sp of smoke) {
    if (!sp.visible) continue;
    const u = (now - sp.userData.t0) / sp.userData.life;
    if (u >= 1) { sp.visible = false; continue; }
    sp.position.addScaledVector(sp.userData.vel, dt);
    sp.userData.vel.multiplyScalar(0.96);
    const sc = 0.12 + 0.45 * u; sp.scale.set(sc, sc, sc);
    sp.material.opacity = 0.55 * (1 - u) * Math.min(1, u * 6);
  }
}

// ---------- Sombra volumétrica dos robôs ----------
// O render do Blender tem sombra de luz de área + oclusão de contato (Cycles); não é objeto exportável.
// Aqui: (1) sombra projetada macia da luz principal; (2) contato escuro justo, no contorno real de cada modelo;
// (3) penumbra larga e suave, deslocada no sentido da luz principal. As camadas acompanham posição e giro.
const shadowTex = (stops) => {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  for (const [o, a] of stops) grd.addColorStop(o, `rgba(0,0,0,${a})`);
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
};
const CONTACT_TEX = shadowTex([[0, 0.88], [0.42, 0.7], [0.72, 0.28], [1, 0]]);
const PENUMBRA_TEX = shadowTex([[0, 0.5], [0.35, 0.36], [0.7, 0.12], [1, 0]]);
const SHADOW_DIR = new THREE.Vector3().copy(key.position).negate().setY(0).normalize();   // sentido da sombra no piso
const contactShadows = [];
function addContactShadow(owner, localBox, hover = 0) {
  const sx = localBox.max.x - localBox.min.x, sz = localBox.max.z - localBox.min.z;
  const cx = (localBox.max.x + localBox.min.x) / 2, cz = (localBox.max.z + localBox.min.z) / 2;
  const mk = (tex, w, d, op, order) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: op, depthWrite: false, toneMapped: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    m.scale.set(w, 1, d); m.renderOrder = order; m.name = 'Sombra (camada)';
    owner.add(m); return m;
  };
  const soft = 1 + hover * 2.2;                                   // Violeta flutua: sombra mais larga e fraca
  const contact = mk(CONTACT_TEX, sx * 1.12 * soft, sz * 1.12 * soft, 0.95 / soft, 2);
  contact.position.set(cx, 0.012, cz);
  const pen = mk(PENUMBRA_TEX, sx * 2.0 * soft, sz * 2.0 * soft, 0.75 / soft, 1);
  contactShadows.push({ owner, pen, base: new THREE.Vector3(cx, 0.011, cz), reach: 0.22 + hover * 0.6 });
}
const _sd = new THREE.Vector3();
function updateContactShadows() {
  for (const s of contactShadows) {
    const yaw = s.owner.rotation.y;                                // deslocamento fixo no mundo -> espaço local do dono
    _sd.copy(SHADOW_DIR).multiplyScalar(s.reach).applyAxisAngle(new THREE.Vector3(0, 1, 0), -yaw);
    s.pen.position.copy(s.base).add(_sd);
  }
}
// Caixa de um modelo no espaço local do dono (vértice a vértice: exata mesmo com o dono girado)
function localBoxOf(owner, model) {
  owner.updateMatrixWorld(true);
  const b = new THREE.Box3(), v = new THREE.Vector3();
  model.traverse((o) => {
    if (!o.isMesh || o.name === 'Sombra (camada)') return;
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) b.expandByPoint(owner.worldToLocal(v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld)));
  });
  return b;
}

// ---------- Luz da antena piscando (sobreposição; o modelo Tripo é malha única) ----------
let beacon = null;
function updateBeacon(now) {
  if (!beacon) return;
  const ph = (now % 1100) / 1100;                          // pisca ~0,9 Hz: aceso 35% do ciclo, com borda suave
  const on = ph < 0.35 ? Math.sin(Math.PI * ph / 0.35) : 0;
  beacon.material.color.copy(beacon.userData.base).multiplyScalar(0.6 + 5.5 * on);
  beacon.scale.setScalar(0.9 + 0.25 * on);
}

const BAND_OUTER = { 5: 6.975, 4: 5.702, 3: 4.917, 2: 4.021, 1: 2.395 };   // apótemas medidos nos painéis gameplay_surface do GLB
const currentRadius = () => BAND_OUTER[dropOrder[dropped] ?? 1];

// O vidro fica preso entre os montantes do octógono. Reflexos e bordas discretas
// tornam a contenção legível sem pôr uma faixa luminosa por cima da pista.
function buildArenaGlass() {
  if (scene.getObjectByName('Vidro perimetral da arena')) return;
  const group = new THREE.Group(); group.name = 'Vidro perimetral da arena';
  const r = 8.86, bottom = -0.48, top = 0.47, offset = Math.PI / 8;
  const glass = new THREE.MeshPhysicalMaterial({ color:0x83b5c3, metalness:.06, roughness:.19, transmission:.30, thickness:.035, ior:1.48, transparent:true, opacity:.36, side:THREE.DoubleSide, depthWrite:false, envMapIntensity:1.35, emissive:0x0a2832, emissiveIntensity:.16 });
  const edge = new THREE.MeshStandardMaterial({ color:0x5bbdd0, metalness:.72, roughness:.28, emissive:0x246478, emissiveIntensity:.7 });
  for (let i=0;i<8;i++) {
    const a=offset+i*Math.PI/4, b=offset+(i+1)*Math.PI/4;
    const va=new THREE.Vector3(r*Math.cos(a),0,r*Math.sin(a)), vb=new THREE.Vector3(r*Math.cos(b),0,r*Math.sin(b));
    const verts=[va.x,bottom,va.z,vb.x,bottom,vb.z,vb.x,top,vb.z,va.x,top,va.z];
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(verts,3));g.setIndex([0,1,2,0,2,3]);g.computeVertexNormals();
    const pane=new THREE.Mesh(g,glass);pane.name=`Painel de vidro ${i+1}`;pane.renderOrder=3;group.add(pane);
    const rail=new THREE.Mesh(new THREE.CylinderGeometry(.024,.024,va.distanceTo(vb),8),edge);rail.position.set((va.x+vb.x)/2,top,(va.z+vb.z)/2);rail.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),new THREE.Vector3(vb.x-va.x,0,vb.z-va.z).normalize());group.add(rail);
    const sill=rail.clone();sill.position.y=bottom+.02;group.add(sill);
  }
  scene.add(group);
}

// Vidro de proteção: reflexo do ambiente visível sem refração cara (Codex: alpha .27, rough .16)
function tuneGlass(root) {
  root.traverse((o) => {
    if (!o.isMesh || !/glass/i.test(o.material?.name ?? '')) return;
    const m=o.material;
    m.color.set(0xe8f6ff);m.metalness=0;m.roughness=.12;
    m.transmission=CINEMA?.94:0;m.thickness=.045;m.ior=1.5;
    m.opacity=CINEMA?1:.25;m.envMapIntensity=1.45;
    m.attenuationColor.set(0xbce8e8);m.attenuationDistance=8;
    m.transparent=!CINEMA;m.depthWrite=false;
    o.material.needsUpdate = true;
  });
}

// Shafts originate only from the emissive lamp geometry authored in the arena GLB.
// Pick one real diffuser around each side; never invent emitter coordinates.
const exteriorVolumes = [];
function buildExteriorEmitterLights(arenaRoot) {
  let emitters = null;
  arenaRoot.traverse((o) => { if (o.isMesh && /warm lights/i.test(o.name)) emitters = o; });
  if (!emitters?.isMesh) return;
  for (const mat of (Array.isArray(emitters.material) ? emitters.material : [emitters.material])) {
    if (/warm lights/i.test(mat?.name ?? '') && mat.emissiveIntensity !== undefined) mat.emissiveIntensity = Math.max(mat.emissiveIntensity, 1.8);
  }
  emitters.updateWorldMatrix(true, false);
  const attr = emitters.geometry.attributes.position, v = new THREE.Vector3(), clusters = [];
  for (let i = 0; i < attr.count; i++) {
    v.fromBufferAttribute(attr, i).applyMatrix4(emitters.matrixWorld);
    let c = clusters.find((p) => Math.hypot(p.x / p.n - v.x, p.z / p.n - v.z) < .07 && Math.abs(p.y / p.n - v.y) < .16);
    if (!c) { c = { x: 0, y: 0, z: 0, n: 0, top: -Infinity }; clusters.push(c); }
    c.x += v.x; c.y += v.y; c.z += v.z; c.n++; c.top = Math.max(c.top, v.y);
  }
  const sources = clusters.filter((c) => c.n >= 24).map((c) => ({
    x: c.x / c.n, y: c.top, z: c.z / c.n,
    angle: Math.atan2(c.z, c.x), radius: Math.hypot(c.x / c.n, c.z / c.n),
  }));
  const selected = [];
  for (let i = 0; i < 8 && sources.length >= 8; i++) {
    const a = i * Math.PI / 4;
    const candidates = sources.filter((s) => !selected.includes(s)).sort((p, q) =>
      Math.abs(Math.atan2(Math.sin(p.angle - a), Math.cos(p.angle - a))) -
      Math.abs(Math.atan2(Math.sin(q.angle - a), Math.cos(q.angle - a))));
    const source = candidates[0]; if (!source) continue; selected.push(source);
    const from = new THREE.Vector3(source.x, source.y, source.z);
    const target = new THREE.Vector3(Math.cos(source.angle) * (source.radius + 1.35), -.84,
      Math.sin(source.angle) * (source.radius + 1.35));
    const direction = target.clone().sub(from).normalize(), len = from.distanceTo(target);
    const angle = THREE.MathUtils.degToRad(32), radius = Math.tan(angle) * len;
    const spot = new THREE.SpotLight(0xffa54e, 14, 3.5, angle, .78, 2);
    spot.position.copy(from); spot.target.position.copy(target); spot.castShadow = false;
    scene.add(spot, spot.target);
    const holder = new THREE.Group(); holder.position.copy(from);
    holder.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), direction);
    const fog = createVolumeLight({ color: 0xffa54e, mode: 2, width: radius });
    fog.userData.setSize(len, 2 * radius, 2 * radius); fog.position.set(0, -radius, -radius);
    fog.material.uniforms.uIntensity.value = .22; fog.material.uniforms.uFloor.value = -.89;
    holder.add(fog); scene.add(holder); exteriorVolumes.push(fog);
  }
}

function buildArenaSurroundings() {
  if (scene.getObjectByName('Passadiço exterior e escadas')) return;
  const group=new THREE.Group();group.name='Passadiço exterior e escadas';
  const grain=document.createElement('canvas');grain.width=grain.height=512;
  const ctx=grain.getContext('2d');ctx.fillStyle='#343b3f';ctx.fillRect(0,0,512,512);
  let seed=2741;const rand=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
  for(let i=0;i<24000;i++){const x=rand()*512,y=rand()*512,v=Math.floor(70+rand()*80),a=.04+rand()*.12;ctx.fillStyle=`rgba(${v},${v+3},${v+4},${a})`;ctx.fillRect(x,y,rand()*2+.35,rand()*2+.35);}
  for(let i=0;i<90;i++){const x=rand()*512,y=rand()*512;ctx.strokeStyle=`rgba(12,19,23,${.08+rand()*.10})`;ctx.lineWidth=.5+rand();ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+(rand()-.5)*45,y+(rand()-.5)*3);ctx.stroke();}
  const grainTex=new THREE.CanvasTexture(grain);grainTex.colorSpace=THREE.SRGBColorSpace;grainTex.wrapS=grainTex.wrapT=THREE.RepeatWrapping;grainTex.repeat.set(3,3);grainTex.anisotropy=4;
  const apronMat=new THREE.MeshStandardMaterial({map:grainTex,color:0xc2c7c9,metalness:.24,roughness:.78,envMapIntensity:.62});
  const seamMat=new THREE.MeshStandardMaterial({color:0x111a20,metalness:.55,roughness:.46});
  const metal=new THREE.MeshStandardMaterial({color:0x43515a,metalness:.78,roughness:.38});
  const shape=new THREE.Shape();
  for(let i=0;i<8;i++){const a=Math.PI/8+i*Math.PI/4,x=Math.cos(a)*11.75,z=Math.sin(a)*11.75;if(i===0)shape.moveTo(x,z);else shape.lineTo(x,z);}
  shape.closePath();
  const hole=new THREE.Path();
  for(let i=7;i>=0;i--){const a=Math.PI/8+i*Math.PI/4,x=Math.cos(a)*9.08,z=Math.sin(a)*9.08;if(i===7)hole.moveTo(x,z);else hole.lineTo(x,z);}
  hole.closePath();shape.holes.push(hole);
  const apron=new THREE.Mesh(new THREE.ShapeGeometry(shape,2),apronMat);apron.rotation.x=-Math.PI/2;apron.position.y=-.888;apron.receiveShadow=true;group.add(apron);
  for(let i=0;i<8;i++){
    const a=Math.PI/8+i*Math.PI/4,points=[new THREE.Vector3(9.25*Math.cos(a),-.884,9.25*Math.sin(a)),new THREE.Vector3(11.65*Math.cos(a),-.884,11.65*Math.sin(a))];
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points),new THREE.LineBasicMaterial({color:0x111920,transparent:true,opacity:.82})));
    for(const r of [9.35,11.58]){
      const bolt=new THREE.Mesh(new THREE.CylinderGeometry(.045,.045,.025,12),seamMat);bolt.position.set(r*Math.cos(a),-.86,r*Math.sin(a));group.add(bolt);
    }
  }
  for(let side=0;side<4;side++){
    const a=side*Math.PI/2,ca=Math.cos(a),sa=Math.sin(a),stair=new THREE.Group();stair.position.set(ca*9.48,-.82,sa*9.48);stair.rotation.y=Math.PI/2-a;group.add(stair);
    for(let i=0;i<7;i++){
      const step=new THREE.Mesh(new THREE.BoxGeometry(.78,.095,.235),i%2?metal:apronMat);step.position.set(0,.035+i*.09,.80+i*.235);step.castShadow=true;step.receiveShadow=true;stair.add(step);
      const nosing=new THREE.Mesh(new THREE.BoxGeometry(.72,.018,.018),seamMat);nosing.position.set(0,.086+i*.09,.70+i*.235);stair.add(nosing);
    }
    for(const x of [-.43,.43]){const rail=new THREE.Mesh(new THREE.CylinderGeometry(.027,.027,1.18,8),metal);rail.position.set(x,.48,1.57);stair.add(rail);}
  }
  scene.add(group);
}

// ---------- Partida demonstrativa no fluxo do original ----------
// Escolher casa (toque) e mira (arrasto ou ↺/↻) → TRAVAR → os robôs da casa sobem do chão → linhas de mira →
// todos disparam juntos → atingidos saem (não voltam) → o anel de fora cai → próxima rodada.
// Posições e direções dos robôs da casa: sorteio só VISUAL, no navegador. Painel com valores ilustrativos.
const PLAYER_COLOR = new THREE.Color(0x3ee8ff);
const START_AIM_K = 12;                          // mira inicial "para cima" na tela (−Z), como no original
let playerAimK = START_AIM_K, busy = false, matchOver = false, matchResult = null, aimLinesOn = false, seriesValue = 5;
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const brl = (v, short = false) => short && Number.isInteger(v) ? `R$ ${v}` : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace(/\s/, ' ');
const playerAimAngle = () => playerAimK * STEP16;
function setAim(k) { playerAimK = ((k % 16) + 16) % 16; }
// mira para o centro do octógono a partir de uma casa (início, reinício e ao escolher casa)
const aimToCenterFrom = (c) => { if (c && Math.hypot(c.x, c.z) > 0.05) setAim(Math.round(Math.atan2(-c.z, -c.x) / STEP16)); };

// Marcador do jogador (anel pulsando + seta flutuando), corredor da mira com listras, alça e destaque das casas
let underGlow = null;
let playerGlow = null, cellFill = null, marker = null, chevron = null, corridorGroup = null, corridor = null, corridorTex = null, knob = null, cellOverlay = null;
const cellStyleCache = [];
let previewAlpha = 1, lastAimT = 0;
function buildAimPreview() {
  const add = (color, opacity) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  // anel duplo ciano + halo no piso (observado no original)
  marker = new THREE.Group();
  const ringOuter = new THREE.Mesh(new THREE.RingGeometry(0.7, 0.8, 56).rotateX(-Math.PI / 2), add(PLAYER_COLOR.clone().multiplyScalar(1.8), 0.85));
  const ringInner = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.56, 56).rotateX(-Math.PI / 2), add(PLAYER_COLOR.clone().multiplyScalar(1.5), 0.7));
  // halo volumétrico: anel de luz que sobe do piso e some para cima (sem plano chapado)
  const halo = createVolumeLight({ color: PLAYER_COLOR, mode: 1, ring: 0.74, width: 0.22 });
  halo.userData.setSize(2.4, 1.1, 2.4);
  halo.position.set(-1.2, 0, -1.2);
  halo.renderOrder = 7;
  for (const [i, o] of [ringInner, ringOuter].entries()) { o.renderOrder = 5 + i; marker.add(o); }
  marker.add(halo);
  marker.userData.rings = [ringOuter, ringInner, halo];
  // luz ciano real que incide sobre o carrinho (sem sombra)
  playerGlow = new THREE.PointLight(PLAYER_COLOR, 0, 3.2, 1.6);
  scene.add(playerGlow);
  underGlow=new THREE.PointLight(PLAYER_COLOR,2.2,2.1,2);scene.add(underGlow);
  chevron = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.24, 4), new THREE.MeshBasicMaterial({ color: PLAYER_COLOR.clone().multiplyScalar(2.2), toneMapped: false }));
  chevron.rotation.x = Math.PI;
  scene.add(marker, chevron);
  // corredor: textura de setas desenhada "em pé"; u atravessa, v vai ao longo do laser
  const c = document.createElement('canvas'); c.width = 64; c.height = 64;
  const g = c.getContext('2d');
  const gx = g.createLinearGradient(0, 0, 64, 0);                       // faixa: bordas mais claras, centro suave
  gx.addColorStop(0, 'rgba(255,255,255,0.45)'); gx.addColorStop(0.18, 'rgba(255,255,255,0.14)');
  gx.addColorStop(0.82, 'rgba(255,255,255,0.14)'); gx.addColorStop(1, 'rgba(255,255,255,0.45)');
  g.fillStyle = gx; g.fillRect(0, 0, 64, 64);
  g.fillStyle = 'rgba(255,255,255,0.9)'; g.fillRect(29, 8, 6, 26);       // traço central (tracejado ao repetir)
  corridorTex = new THREE.CanvasTexture(c); corridorTex.wrapT = THREE.RepeatWrapping; corridorTex.colorSpace = THREE.SRGBColorSpace;
  const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0.5, 0, 0);
  const pos = geo.attributes.position, uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getZ(i) + 0.5, 1 - pos.getX(i));
  const corridorMaterial = new THREE.MeshBasicMaterial({ map: corridorTex, color: PLAYER_COLOR.clone().multiplyScalar(1.4), transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  // A ponta precisa desaparecer junto com o volume: sem essa rampa, a faixa texturizada
  // termina num corte retangular mesmo que a densidade volumétrica já esteja sumindo.
  corridorMaterial.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vBeamAlong;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBeamAlong = position.x;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vBeamAlong;')
      .replace('#include <map_fragment>', '#include <map_fragment>\n  diffuseColor.a *= 1.0 - smoothstep(0.76, 1.0, vBeamAlong);');
  };
  corridorMaterial.customProgramCacheKey = () => 'corridor-tip-fade-v1';
  corridor = new THREE.Mesh(geo, corridorMaterial);
  corridor.renderOrder = 6;
  // coluna de luz volumétrica ao longo da mira (densidade suave, forte no piso, some para cima)
  const column = createVolumeLight({ color: PLAYER_COLOR, mode: 0, width: 0.28 });
  column.renderOrder = 7;
  corridor.userData.column = [column];
  knob = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.05, 8, 24).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: PLAYER_COLOR.clone().multiplyScalar(2), transparent: true, toneMapped: false }));
  knob.position.y = 0.1;
  corridorGroup = new THREE.Group();
  corridorGroup.add(corridor, knob, ...corridor.userData.column);
  scene.add(corridorGroup);
  // casas: contorno sobreposto no formato e orientação reais de cada casa (1 draw call)
  const sides = cells[0]?.sides ?? 6;
  const overlayMat = () => new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  cellOverlay = new THREE.InstancedMesh(new THREE.RingGeometry(0.98, 1.16, sides).rotateX(-Math.PI / 2), overlayMat(), cells.length);
  cellFill = new THREE.InstancedMesh(new THREE.CircleGeometry(0.97, sides).rotateX(-Math.PI / 2), overlayMat(), cells.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  cells.forEach((cell, i) => {
    cell.index = i;
    m.compose(new THREE.Vector3(cell.x, 0.035, cell.z), q.setFromAxisAngle(up, -cell.corner), new THREE.Vector3(cell.radius, 1, cell.radius));
    cellOverlay.setMatrixAt(i, m); cellFill.setMatrixAt(i, m);
    cellOverlay.setColorAt(i, new THREE.Color(0, 0, 0)); cellFill.setColorAt(i, new THREE.Color(0, 0, 0));
  });
  cellOverlay.renderOrder = 4; cellFill.renderOrder = 3;
  scene.add(cellFill, cellOverlay);
}
// estilos como no original: idle (base da arena) · lit (no caminho do laser) · chosen (sua casa) · hover (sob o dedo)
const CELL_LOOK = { lit: [0x9ff3ff, 0.75], chosen: [0xffffff, 0.95], hover: [0xffe27a, 0.85] };
const _cc = new THREE.Color();
function updateAimPreview(now) {
  if (!marker || !playerRig) return;
  const dt = lastAimT ? Math.min(0.05, (now - lastAimT) / 1000) : 0; lastAimT = now;
  const t = now / 1000;
  const show = canPlay() || (reviewState === 'posicionamento' && !busy && !matchOver && !playerFell && !!playerMove);
  previewAlpha += ((show ? 1 : 0) - previewAlpha) * (1 - Math.exp(-10 * dt));
  // carrinho parado: vira suave até a mira (chega de frente e depois se posiciona)
  if (!playerMove && !playerFell) {
    const a = playerAimAngle(), yaw = Math.atan2(Math.cos(a), Math.sin(a));
    playerRig.rotation.y += wrapPi(yaw - playerRig.rotation.y) * (1 - Math.exp(-8 * dt));
  }
  // marcador do jogador
  const alivePlayer = !playerFell && !gameOver;
  marker.position.set(playerRig.position.x, playerRig.position.y + 0.02, playerRig.position.z);
  marker.scale.setScalar(1 + Math.sin(t * 4) * 0.06);
  underGlow.position.set(playerRig.position.x,playerRig.position.y+.12,playerRig.position.z);
  underGlow.intensity=alivePlayer?2.1+Math.sin(t*4)*.35:0;
  const [ro, ri, ha] = marker.userData.rings;
  ro.material.opacity = alivePlayer ? 0.6 + Math.sin(t * 4) * 0.25 : 0;
  ri.material.opacity = alivePlayer ? 0.55 + Math.sin(t * 4 + 1.6) * 0.25 : 0;
  ha.material.uniforms.uIntensity.value = alivePlayer ? 1.25 : 0;
  ha.userData.update(camera, t);
  chevron.visible = alivePlayer;
  chevron.position.set(playerRig.position.x, playerRig.position.y + 1.45 + Math.sin(t * 3) * 0.06, playerRig.position.z);
  chevron.rotation.y = t * 2;
  // o feixe SEMPRE sai do carrinho (pedido do Celio): andando, aponta para a casa escolhida e termina nela;
  // parado, segue a mira até a grade
  const from = { x: playerRig.position.x, z: playerRig.position.z };
  let a, len;
  const yaw=playerRig.rotation.y;
  a=Math.atan2(Math.cos(yaw),Math.sin(yaw));
  len=Math.max(.3,rayToOctagon(from.x,from.z,Math.cos(a),Math.sin(a),currentRadius()));
  const dx = Math.cos(a), dz = Math.sin(a);
  corridorGroup.position.set(from.x, 0.03, from.z);
  corridorGroup.rotation.y = -a;
  corridor.scale.set(len, 1, LASER_REACH * 2);
  corridorTex.repeat.set(1, len / 1.6);
  corridorTex.offset.y = -t * 0.9;                      // listras andando para a frente
  knob.position.x = Math.min(1.35, len - 0.2);
  knob.scale.setScalar(1 + Math.sin(t * 5) * 0.08);
  corridor.material.opacity = 0.13 * previewAlpha;                 // faixa no piso mais discreta (o volume dá a luz)
  const col = corridor.userData.column[0];
  col.userData.setSize(len, 1.3, LASER_REACH * 2.6);
  col.position.set(0, 0, -LASER_REACH * 1.3);
  col.material.uniforms.uIntensity.value = 1.35 * previewAlpha;
  col.userData.update(camera, t);
  knob.material.opacity = previewAlpha;
  corridorGroup.visible = previewAlpha > 0.02;
  // estilos das casas
  const act = activePhases();
  const lit = new Set(previewAlpha > 0.02 && !playerMove ? cellsCrossed(from.x, from.z, playerAimAngle(), activeCells(cells, act), playerCell) : []);
  // a luz da mira ilumina o carrinho: ponto ciano logo à frente, na altura da carroceria
  const car = playerRig.position;                                          // a luz acompanha o carrinho, não o destino
  playerGlow.position.set(car.x + dx * 0.55, 0.55, car.z + dz * 0.55);
  playerGlow.intensity = 4.5 * previewAlpha + (alivePlayer ? 1.2 : 0);
  for (const cell of cells) {
    let style = 'idle';
    if (!act.includes(cell.phase)) style = 'hidden';
    else if (cell === hoverCell && canPlay()) style = 'hover';
    else if (cell === playerCell && alivePlayer) style = 'chosen';
    else if (lit.has(cell)) style = 'lit';
    cellStyleCache[cell.index] = style;
    const look = CELL_LOOK[style];
    const k = look ? look[1] * (style === 'hover' || style === 'chosen' ? 1 : previewAlpha) * 1.5 : 0;
    cellOverlay.setColorAt(cell.index, _cc.set(look ? look[0] : 0).multiplyScalar(k));
    cellFill.setColorAt(cell.index, _cc.multiplyScalar(style === 'lit' || style === 'chosen' ? 0.22 : style === 'hover' ? 0.15 : 0));   // preenchimento suave
  }
  cellOverlay.instanceColor.needsUpdate = true;
  cellFill.instanceColor.needsUpdate = true;
}

// Robôs da casa sobem de dentro do chão (o buraco/abertura fica com o Codex) e descem ao sair
const scanRings = Array.from({ length: 4 }, () => {
  const r = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.66, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  r.visible = false; r.renderOrder = 5; scene.add(r); return r;
});
const RISE_DEPTH = 1.9;
function riseSlot(slot, delay, i) {
  slot.userData.rise = { t0: performance.now() + delay * 1000, dur: 650, from: -RISE_DEPTH, to: 0 };
  slot.position.y = -RISE_DEPTH;
  const ring = scanRings[i % scanRings.length];
  ring.userData = { t0: performance.now() + delay * 1000, dur: 700 };
  ring.position.set(slot.position.x, 0.04, slot.position.z);
  ring.material.color.set(slot.userData.color).multiplyScalar(2);
}
function sinkSlot(slot) {
  slot.userData.rise = { t0: performance.now(), dur: 450, from: slot.position.y, to: -RISE_DEPTH, thenGone: true };
}
const easeOutBack = (x) => 1 + 2.70158 * (x - 1) ** 3 + 1.70158 * (x - 1) ** 2;
function updateRise(now) {
  for (const slot of enemySlots) {
    const r = slot.userData.rise;
    if (!r) continue;
    const u = Math.max(0, Math.min(1, (now - r.t0) / r.dur));
    const k = r.to > r.from ? easeOutBack(u) : u * u;
    slot.position.y = r.from + (r.to - r.from) * k;
    if (u >= 1) { slot.position.y = r.to; slot.userData.rise = null; if (r.thenGone) slot.userData.gone = true; }
  }
  for (const ring of scanRings) {
    const d = ring.userData; if (!d?.t0) continue;
    const u = (now - d.t0) / d.dur;
    ring.visible = u >= 0 && u < 1;
    if (!ring.visible) continue;
    ring.scale.setScalar(0.6 + u * 1.2);
    ring.material.opacity = 0.9 * (1 - u);
  }
}

// Disparo simultâneo: quem fica no corredor de um laser entra em curto e sai
const ENEMY_HIT_R = 0.55;
function resolveShots() {
  const shooters = [{ who: 'player', x: playerRig.position.x, z: playerRig.position.z, a: playerAimAngle() },
    ...enemySlots.filter((s) => !s.userData.dead && s.visible).map((s) => ({ who: s, x: s.position.x, z: s.position.z, a: s.userData.aim }))];
  const hit = new Set();
  for (const sh of shooters) {
    const dx = Math.cos(sh.a), dz = Math.sin(sh.a), len = rayToOctagon(sh.x, sh.z, dx, dz, currentRadius());
    for (const tg of shooters) {
      if (tg === sh) continue;
      const r = tg.who === 'player' ? PLAYER_HIT_R : ENEMY_HIT_R;
      if (beamHitsCircle(sh.x, sh.z, dx, dz, len, tg.x, tg.z, r)) hit.add(tg.who);
    }
  }
  return hit;
}
// Explosão (pedido do Celio: robô da casa em cima da faixa que cai explode): clarão + faíscas + fumaça
const glowTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.35, 'rgba(255,255,255,0.55)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();
const blastSprite = (color) => {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  sp.visible = false; sp.userData = { t0: 0, life: 0, vel: new THREE.Vector3(), kind: '' }; scene.add(sp); return sp;
};
const flashes = Array.from({ length: 6 }, () => blastSprite(new THREE.Color(0xffc36b).multiplyScalar(3)));
const sparks = Array.from({ length: 90 }, () => blastSprite(new THREE.Color(0xffd27a).multiplyScalar(4)));
let flashIdx = 0, sparkIdx = 0;
function explodeAt(x, y, z, tint) {
  const now = performance.now();
  const f = flashes[flashIdx++ % flashes.length];
  f.material.color.set(tint ?? 0xffb04a).lerp(new THREE.Color(0xffa23a), 0.8).multiplyScalar(7);   // bola de fogo laranja
  f.position.set(x, y + 0.6, z); f.userData.t0 = now; f.userData.life = 520; f.userData.kind = 'flash'; f.visible = true;
  const core = flashes[flashIdx++ % flashes.length];                                                 // núcleo quase branco
  core.material.color.set(0xfff2d6).multiplyScalar(9);
  core.position.set(x, y + 0.55, z); core.userData.t0 = now; core.userData.life = 260; core.userData.kind = 'core'; core.visible = true;
  for (let i = 0; i < 26; i++) {
    const sp = sparks[sparkIdx++ % sparks.length];
    const a = Math.random() * Math.PI * 2, up = 1.6 + Math.random() * 2.2, out = 1.2 + Math.random() * 2.4;
    sp.position.set(x, y + 0.6, z);
    sp.userData.vel.set(Math.cos(a) * out, up, Math.sin(a) * out);
    sp.userData.t0 = now; sp.userData.life = 600 + Math.random() * 500; sp.userData.kind = 'spark'; sp.visible = true;
  }
  for (let i = 0; i < 10; i++) {
    const sp = smoke[smokeIdx++ % smoke.length];
    sp.position.set(x + (Math.random() - 0.5) * 0.6, y + 0.4 + Math.random() * 0.5, z + (Math.random() - 0.5) * 0.6);
    sp.userData.vel.set((Math.random() - 0.5) * 0.8, 0.7 + Math.random() * 0.6, (Math.random() - 0.5) * 0.8);
    sp.userData.t0 = now; sp.userData.life = 1200 + Math.random() * 700; sp.visible = true;
  }
}
let lastBlastT = 0;
function updateBlasts(now) {
  const dt = lastBlastT ? Math.min(0.05, (now - lastBlastT) / 1000) : 0; lastBlastT = now;
  for (const sp of flashes) {
    if (!sp.visible) continue;
    const u = (now - sp.userData.t0) / sp.userData.life;
    if (u >= 1) { sp.visible = false; continue; }
    const big = sp.userData.kind === 'core' ? 1.3 : 3.4;
    sp.scale.setScalar(0.4 + big * Math.sqrt(u)); sp.material.opacity = (1 - u) * (1 - u);
  }
  for (const sp of sparks) {
    if (!sp.visible) continue;
    const u = (now - sp.userData.t0) / sp.userData.life;
    if (u >= 1) { sp.visible = false; continue; }
    sp.userData.vel.y -= 6 * dt;
    sp.position.addScaledVector(sp.userData.vel, dt);
    sp.scale.setScalar(0.09 * (1 - u) + 0.02); sp.material.opacity = 1 - u;
  }
}

function shortCircuitFx(x, y, z) {
  for (let i = 0; i < 6; i++) {
    const sp = smoke[smokeIdx++ % smoke.length];
    sp.position.set(x + (Math.random() - 0.5) * 0.4, y + 0.3 + Math.random() * 0.4, z + (Math.random() - 0.5) * 0.4);
    sp.userData.vel.set((Math.random() - 0.5) * 0.4, 0.5 + Math.random() * 0.4, (Math.random() - 0.5) * 0.4);
    sp.userData.t0 = performance.now(); sp.userData.life = 900 + Math.random() * 500; sp.visible = true;
  }
}

// ---------- Sequência da entrada (Codex v18): baixar portas → deslizar → elevador sobe com o robô → robô anda até o
// destino → (fora da projeção do vão) elevador desce → portas voltam e sobem. Só os robôs que cabem no vão usam a entrada.
let BAY_APOTHEM = 1.4412520707176073 / 2;             // vão útil entre faces (manifesto clear_width / 2; atualizado na carga)
// Giro do robô durante a subida: se o manifesto (v2+) trouxer o giro por entrada, ele manda e o teste de encaixe
// octogonal não é usado (o vão v2 é alongado). Campos aceitos: robot_yaw_deg | robot_yaw_three (rad).
const bayYaw = (bay) => (bay.robot_yaw_deg != null ? bay.robot_yaw_deg * Math.PI / 180 : bay.robot_yaw_three ?? null);
const tweens = [];
function tween(dur, fn, tok) {
  return new Promise((resolve) => tweens.push({ t0: performance.now(), dur: dur * 1000, fn, resolve, tok }));
}
function updateTweens(now) {
  for (let i = tweens.length - 1; i >= 0; i--) {
    const tw = tweens[i];
    if (tw.tok !== roundToken) { tweens.splice(i, 1); tw.resolve(); continue; }   // cancelado pelo reinício
    const u = Math.min(1, (now - tw.t0) / tw.dur);
    tw.fn(u);
    if (u >= 1) { tweens.splice(i, 1); tw.resolve(); }
  }
}
const easeIO = (u) => (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2);
// cabe no vão? (vértices reais contra as 8 faces, melhor giro) — cacheado por robô
function bayFit(slot) {
  if (slot.userData.bayFit) return slot.userData.bayFit;
  const m = slot.userData.model; if (!m) return null;
  const rot = slot.rotation.y; slot.rotation.set(0, 0, 0); slot.updateMatrixWorld(true);
  const v = new THREE.Vector3(), pts = [];
  m.traverse((o) => {
    if (!o.isMesh || o.name === 'Sombra (camada)') return;
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i += 2) { v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld); pts.push(v.x - slot.position.x, v.z - slot.position.z); }
  });
  slot.rotation.y = rot;
  let best = { yaw: 0, need: Infinity };
  for (let deg = 0; deg < 45; deg += 0.5) {
    const th = deg * Math.PI / 180; let need = 0;
    for (let k = 0; k < 8; k++) {
      const c = Math.cos(k * Math.PI / 4 - th), sn = Math.sin(k * Math.PI / 4 - th);
      for (let i = 0; i < pts.length; i += 2) need = Math.max(need, pts[i] * c + pts[i + 1] * sn);
    }
    if (need < best.need) best = { yaw: th, need };
  }
  return (slot.userData.bayFit = { ...best, fits: best.need < BAY_APOTHEM, margin: BAY_APOTHEM - best.need });
}
const baysOpen = () => bays.length && activePhases().includes(baysManifest.phase);
async function runBay(bay, slot, tok, delay) {
  const d = baysManifest.doors_three, l = baysManifest.lift_three, u = slot.userData;
  bay.busy = true; u.driving = true;
  const bp = bay.rootObj.getWorldPosition(new THREE.Vector3());
  const fixedYaw = bayYaw(bay);
  slot.position.set(bp.x, l.bottom_y + 0.045, bp.z);          // já espera dentro do poço, no elevador
  slot.rotation.set(0, fixedYaw ?? -bayFit(slot).yaw, 0);      // giro fixo do mecanismo (v2) ou o de melhor encaixe (v1); só gira acima do piso
  await new Promise((r) => setTimeout(r, delay * 1000)); if (tok !== roundToken) return;
  // 1) portas baixam, 2) deslizam
  await tween(0.32, (k) => { const y = d.closed_y + (d.lowered_y - d.closed_y) * easeIO(k); bay.leftObj.position.y = y; bay.rightObj.position.y = y; }, tok);
  await tween(0.6, (k) => { const e = easeIO(k); bay.leftObj.position.x = d.left_open_x * e; bay.rightObj.position.x = d.right_open_x * e; }, tok);
  // 3) elevador sobe carregando o robô (base do robô na superfície do elevador)
  await tween(1.0, (k) => { bay.liftObj.position.y = l.bottom_y + (l.top_y - l.bottom_y) * easeIO(k); slot.position.y = bay.liftObj.position.y + 0.045; }, tok);
  if (tok !== roundToken) return;
  slot.position.y = 0;
  // 4) anda até o destino: gira de frente e vai
  const c = u.cell, from = slot.position.clone(), to = new THREE.Vector3(c.x, 0, c.z);
  const yaw0 = slot.rotation.y, yaw1 = Math.atan2(to.x - from.x, to.z - from.z), dyaw = wrapPi(yaw1 - yaw0);
  await tween(0.28, (k) => { slot.rotation.y = yaw0 + dyaw * easeIO(k); }, tok);
  const dist = from.distanceTo(to), clearAt = Math.min(1, (BAY_APOTHEM + 0.75) / Math.max(dist, 0.01));
  let closing = null;
  await tween(Math.max(0.5, dist / 2.6), (k) => {
    slot.position.lerpVectors(from, to, easeIO(k));
    if (!closing && easeIO(k) >= clearAt) closing = closeBay(bay, tok);  // fecha só quando saiu da projeção do vão
  }, tok);
  if (!closing) closing = closeBay(bay, tok);
  u.driving = false;
  await closing;
}
async function closeBay(bay, tok) {
  const d = baysManifest.doors_three, l = baysManifest.lift_three;
  await tween(0.7, (k) => { bay.liftObj.position.y = l.top_y + (l.bottom_y - l.top_y) * easeIO(k); }, tok);
  await tween(0.55, (k) => { const e = 1 - easeIO(k); bay.leftObj.position.x = d.left_open_x * e; bay.rightObj.position.x = d.right_open_x * e; }, tok);
  await tween(0.25, (k) => { const y = d.lowered_y + (d.closed_y - d.lowered_y) * easeIO(k); bay.leftObj.position.y = y; bay.rightObj.position.y = y; }, tok);
  bay.busy = false;
}
// Surgimento da rodada: cada inimigo aparece na casa aleatória sorteada. As escotilhas
// continuam como cenário, mas não determinam nem restringem os pontos de entrada.
async function emergeEnemies(alive, tok, sleep) {
  if (tok !== roundToken) return;
  alive.forEach((slot, i) => riseSlot(slot, i * 0.16, i));
  await sleep(alive.length * 0.16 + 0.75);
}

// ---------- Dissipação dos robôs que perdem (superfície 3D + brasas) ----------
const embers = createEmbers(scene, 700);
const dissolving = [];
let playerDissolve = null, playerGone = false, lastDsT = 0;
function dissolveRobot(kind, target, duration) {
  if (kind === 'enemy') {
    const ctl = target.userData.dissolve;
    if (!ctl) { target.userData.gone = true; return; }
    target.userData.dissolving = true;
    ctl.start(duration);
    dissolving.push({ ctl, tint: target.userData.color, done: () => { target.userData.dissolving = false; target.userData.gone = true; } });
  } else if (playerDissolve) {
    playerDissolve.start(duration);
    dissolving.push({ ctl: playerDissolve, tint: 0x9ff3ff, done: () => { playerGone = true; playerRig.visible = false; } });
  }
}
function updateDissolves(now) {
  const dt = lastDsT ? Math.min(0.05, (now - lastDsT) / 1000) : 0; lastDsT = now;
  for (let i = dissolving.length - 1; i >= 0; i--) {
    const d = dissolving[i];
    if (d.ctl.update(now, (x, y, z) => embers.emit(x, y, z, d.tint))) { d.done(); dissolving.splice(i, 1); }
  }
  embers.update(dt, now / 1000);
}

let roundToken = 0;
const ABORT = Symbol('rodada cancelada');
async function lockRound() {
  if (busy || matchOver || playerFell || !playerRig) return;
  const tok = ++roundToken;
  const sleep = async (sec) => { await new Promise((r) => setTimeout(r, sec * 1000)); if (tok !== roundToken) throw ABORT; };
  try { await lockRoundBody(tok, sleep); } catch (e) { if (e !== ABORT) throw e; }
}
async function lockRoundBody(tok, sleep) {
  busy = true; matchResult = null; updateUI(); updateMatchStatus();
  while (playerMove || playerSettle) await sleep(0.05);
  // 1) os robôs da casa sobem do chão, quase juntos
  setReviewState('revelacao');
  if (!spawned) { busy = false; updateUI(); return; }
  const alive = enemySlots.filter((s) => !s.userData.dead);
  await emergeEnemies(alive, tok, sleep);
  await sleep(0.05);
  // 2) linhas de mira de todos, por um instante
  aimLinesOn = true;
  await sleep(1.7);
  aimLinesOn = false;
  // 3) todos disparam juntos
  setReviewState('disparo', { respawn: false });
  const hit = resolveShots();
  for (const who of hit) {
    if (who === 'player') { gameOver = true; shortCircuitFx(playerRig.position.x, 0, playerRig.position.z); setTimeout(() => tok === roundToken && dissolveRobot('player', null, 1.8), 450); continue; }
    who.userData.dead = true;
    who.userData.dissolving = true;                                           // continua visível até a dissipação terminar
    shortCircuitFx(who.position.x, 0, who.position.z);
    setTimeout(() => tok === roundToken && dissolveRobot('enemy', who, 1.6), 350);   // curto-circuito e então se desfaz na superfície
    document.querySelector(`.roster li[data-enemy="${who.userData.id}"]`)?.classList.add('dead');
  }
  await sleep(1.1);
  // 4) atingidos se desfazem; os sobreviventes ficam onde estão até o anel cair (sem re-sortear)
  setReviewState('revelacao', { respawn: false });
  await sleep(1.3);                                    // deixa a dissipação dos atingidos aparecer
  const left = enemySlots.filter((s) => !s.userData.dead).length;
  const survivors = alive.filter((s) => !s.userData.dead);
  const sinkSurvivors = async () => { for (const s of survivors) if (!s.userData.dead) sinkSlot(s); await sleep(0.55); };
  if (gameOver) {
    await sinkSurvivors();
    matchOver = true; matchResult = { msg: 'Curto-circuito: seu robô foi atingido · fim de jogo (demonstração)', cls: 'over' };
  } else if (left === 0 || dropped >= dropOrder.length) {
    await sinkSurvivors();
    matchOver = true;
    matchResult = { msg: left === 0 ? 'Você ficou sozinho na arena · série vencida (demonstração)' : 'Você passou da última rodada · série vencida (demonstração)', cls: 'safe' };
  } else {
    matchResult = { msg: hit.size ? `Sobreviveu e derrubou ${hit.size} robô${hit.size > 1 ? 's' : ''} · o anel de fora cai` : 'Sobreviveu · o anel de fora cai', cls: 'safe' };
    updateMatchStatus();
    const band = dropOrder[dropped];
    dropNext();                                         // aviso piscante (0,65 s) e depois a faixa despenca
    await sleep(0.65);
    // quem ainda estiver em cima da faixa que cai explode (e não volta)
    let blown = 0;
    for (const s of survivors) {
      if (s.userData.cell?.phase !== band) continue;
      explodeAt(s.position.x, 0, s.position.z, s.userData.color);
      s.userData.dead = true; blown++;
      dissolveRobot('enemy', s, 0.75);
      document.querySelector(`.roster li[data-enemy="${s.userData.id}"]`)?.classList.add('dead');
    }
    if (blown) { matchResult = { msg: `${blown} robô${blown > 1 ? 's' : ''} da casa explodi${blown > 1 ? 'ram' : 'u'} com o anel`, cls: 'safe' }; updateMatchStatus(); updateUI(); }
    await sleep(0.9);
    await sinkSurvivors();                              // os demais voltam para baixo do chão
    setReviewState('posicionamento');
    await sleep(0.9);
    if (playerFell) { matchOver = true; matchResult = { msg: 'Seu robô estava no anel que caiu · fim de jogo (demonstração)', cls: 'over' }; }
    else if (enemySlots.every((s) => s.userData.dead)) {
      matchOver = true; matchResult = { msg: 'Você ficou sozinho na arena · série vencida (demonstração)', cls: 'safe' };
    } else if (!blown) matchResult = null;                // mantém a mensagem da explosão até a próxima ação
  }
  busy = false;
  if (!matchOver) setReviewState('posicionamento');               // sem re-sortear: os robôs já desceram para o chão
  updateUI(); updateMatchStatus();
}

// ---------- Queda das faixas 5 → 4 → 3 → 2 ----------
function dropNext() {
  if (dropped >= dropOrder.length) return;
  const p = dropOrder[dropped++];
  const g = phaseGroups.get(p);
  falling.push({ g, t0: performance.now(), warn: 650, fall: 1500 });
  // Fim da rodada: a faixa cai e a próxima começa de novo só com o jogador (adversários somem).
  if (playerCell && playerCell.phase === p) { g.attach(playerRig); playerFell = true; gameOver = true; }   // jogador sobre a faixa cai junto
  if (!busy) setReviewState('posicionamento');
  updateUI();
}
function resetArena() {
  roundToken++;                                       // cancela a rodada em andamento (esperas, timers de dissipação)
  aimLinesOn = false;
  for (const s of enemySlots) { s.userData.rise = null; s.userData.driving = false; }
  tweens.length = 0; closeBaysInstant();
  for (const r of scanRings) { r.visible = false; r.userData = {}; }
  falling.length = 0;
  for (const g of phaseGroups.values()) {
    g.position.set(0, 0, 0); g.rotation.set(0, 0, 0); g.visible = true;
    for (const [m, e] of g.userData.emissive) m.emissiveIntensity = e;
  }
  dropped = 0;
  if (playerRig) { scene.attach(playerRig); playerMove = null; playerSettle = null; placePlayer(playerHomeCell); playerRig.rotation.set(0, 0, 0); }
  playerFell = false; gameOver = false; matchResult = null; matchOver = false; busy = false; aimToCenterFrom(playerHomeCell);
  for (const s of enemySlots) { s.userData.dead = false; s.userData.gone = false; s.userData.dissolving = false; s.userData.dissolve?.reset(); s.scale.setScalar(1); s.position.y = 0; }
  dissolving.length = 0; playerDissolve?.reset(); playerGone = false; if (playerRig) playerRig.visible = true;
  document.querySelectorAll('.roster li').forEach((li) => li.classList.remove('dead'));
  setReviewState('posicionamento');
  updateUI();
}
function updateFalling(now) {
  for (let i = falling.length - 1; i >= 0; i--) {
    const f = falling[i];
    const dt = now - f.t0;
    if (dt < f.warn) {                                  // aviso: LEDs da faixa piscam
      const k = 0.5 + 0.5 * Math.sin(dt / 40);
      for (const [m, e] of f.g.userData.emissive) m.emissiveIntensity = e * (0.25 + 1.6 * k);
      continue;
    }
    const u = Math.min(1, (dt - f.warn) / f.fall);
    f.g.position.y = -16 * u * u;                       // queda acelerada para dentro do poço (fundo a y −18)
    if (u >= 1) { f.g.visible = false; falling.splice(i, 1); }
  }
}

// ---------- Enquadramento ----------
const panel = document.getElementById('panel');
const hudTop = document.getElementById('hudTop');
let arenaRect = null;
let usedMode = 'blender';

function camSpace(p) {
  const v = p.clone().applyMatrix4(camera.matrixWorldInverse);
  return v;
}
function extents(radius, heights = [0, 1.15]) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < 8; i++) {
    const a = (i + 0.5) * Math.PI / 4;
    const R = radius / Math.cos(Math.PI / 8);            // apótema -> vértice
    for (const h of heights) {
      const v = camSpace(new THREE.Vector3(Math.cos(a) * R, h, Math.sin(a) * R));
      x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y);
    }
  }
  return { x0, x1, y0, y1 };
}

function layout() {
  const W = window.innerWidth, H = window.innerHeight;
  renderer.setPixelRatio(lite ? 1 : Math.min(window.devicePixelRatio, 2));
  renderer.setSize(W, H, false);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(W, H);

  // 1) Câmera Blender exata (altura de 14,914 u, centro óptico a 34% da largura)
  let upp = REF_VIEW_H / H;
  let left = -REF_CENTER_FRAC * W * upp;
  let top = REF_VIEW_H / 2;
  const play = extents(PLAYABLE_R, [0, 0.3]);
  const toPx = (x, y) => [(x - left) / upp, (top - y) / upp];

  let ok = true;
  if (!REF_MODE) {
    const [px1] = toPx(play.x1, 0);
    const [, pyTop] = toPx(0, play.y1);
    const pr = panel.getBoundingClientRect();
    const hr = hudTop.getBoundingClientRect();
    const panelBelow = pr.top > H * 0.4 && pr.width > W * 0.6;
    if (panelBelow) ok = false;
    else if (px1 + 8 > pr.left) ok = false;
    // chips do topo à esquerda não podem cobrir o piso jogável
    if (pyTop < hr.bottom + 6) ok = false;
  }

  usedMode = 'blender';
  if (!ok) {
    // 2) Ajustado: encaixa a arena no retângulo livre (fora do painel e da barra superior)
    usedMode = 'ajustada';
    const pr = panel.getBoundingClientRect();
    const hr = hudTop.getBoundingClientRect();
    const panelBelow = pr.top > H * 0.4 && pr.width > W * 0.6;
    const rect = panelBelow
      ? { x: 0, y: hr.bottom + 4, w: W, h: pr.top - hr.bottom - 10 }
      : { x: 0, y: hr.bottom + 4, w: pr.left - 12, h: H - hr.bottom - 10 };
    const e = extents(panelBelow ? PLAYABLE_R + 0.25 : FIT_R, [0, 1.15]);
    upp = Math.max((e.x1 - e.x0) / rect.w, (e.y1 - e.y0) / rect.h);
    const cx = (e.x0 + e.x1) / 2, cy = (e.y0 + e.y1) / 2;
    left = cx - (rect.x + rect.w / 2) * upp;
    top = cy + (rect.y + rect.h / 2) * upp;
  }
  camera.left = left; camera.right = left + W * upp;
  camera.top = top; camera.bottom = top - H * upp;
  camera.updateProjectionMatrix();
  bloom.resolution.set(W, H);

  const [ax0, ay0] = [(play.x0 - left) / upp, (top - play.y1) / upp];
  const [ax1, ay1] = [(play.x1 - left) / upp, (top - play.y0) / upp];
  arenaRect = { x0: ax0, y0: ay0, x1: ax1, y1: ay1 };
  window.__preview = { mode: usedMode, arenaRect, panel: panel.getBoundingClientRect().toJSON(), hud: hudTop.getBoundingClientRect().toJSON() };
}

// ---------- UI ----------
const $ = (id) => document.getElementById(id);
const toast = (msg) => { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2600); };

function updateUI() {
  const round = Math.min(5, dropped + 1);
  $('roundLabel').textContent = `${round}/5`;
  $('roundTitle').textContent = `Rodada ${round} de 5`;
  const next = dropOrder[dropped];
  $('btnDrop').disabled = next === undefined;
  $('btnDrop').textContent = next === undefined ? 'Só resta o centro' : `Derrubar faixa ${next}`;
  const remaining = dropOrder.slice(dropped).sort();
  $('phaseStatus').textContent = remaining.length ? `Faixas ${remaining.join(', ')}` : 'Só o centro';
  const alive = enemySlots.filter((s) => !s.userData.dead).length;
  $('quoteBots').textContent = `${alive} robô${alive === 1 ? '' : 's'} da casa`;
  $('lockLabel').textContent = matchOver ? 'Nova série' : `Travar · ${brl(seriesValue, true)}`;
  $('rotLeft').disabled = $('rotRight').disabled = busy || matchOver;
  $('lock').disabled = busy;
  document.querySelectorAll('.chip').forEach((b) => { b.disabled = busy || (dropped > 0 && !matchOver); });
  panel.classList.toggle('is-busy', busy);
}

function setToggle(el, on) { el.classList.toggle('on', on); el.setAttribute('aria-pressed', String(on)); }

$('btnDrop').addEventListener('click', dropNext);
$('btnReset').addEventListener('click', resetArena);
$('tglLasers').addEventListener('click', (e) => { lasersOn = !lasersOn; setToggle(e.currentTarget, lasersOn); });
const STATE_HINT = {
  inspecao: 'Inspeção: todos os modelos visíveis; varredura de lasers opcional (efeito, não mecânica).',
  posicionamento: 'Posição: só o jogador na arena. Clique numa casa das faixas restantes para mover o carrinho.',
  revelacao: 'Revelação: os 4 adversários surgem em casas livres. Posições sorteadas só no navegador (no jogo, o servidor decide).',
  disparo: 'Disparo: lasers simultâneos, retos e horizontais; direções dos adversários sorteadas só para visualizar. Jogador aponta para a frente.',
};
function setReviewState(st, { respawn = true } = {}) {
  if (st === 'posicionamento') spawned = false;                         // nova rodada: só o jogador
  if (respawn && (st === 'revelacao' || (st === 'disparo' && !spawned) || (st === 'inspecao' && !spawned))) spawnEnemies();
  reviewState = st;
  document.querySelectorAll('#stateSeg button').forEach((b) => { const on = b.dataset.state === st; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
  $('tglLasers').disabled = st !== 'inspecao';
  $('stateHint').textContent = STATE_HINT[st];
  updateMatchStatus();
}
document.querySelectorAll('#stateSeg button').forEach((b) => b.addEventListener('click', () => setReviewState(b.dataset.state)));
// Clique numa casa (estado Posição): move o carrinho. Destaque da casa sob o cursor.
const raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2(), floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
function groundAtPointer(ev) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  return raycaster.ray.intersectPlane(floorPlane, new THREE.Vector3());
}
function cellAtPointer(ev) {
  const p = groundAtPointer(ev);
  return p ? nearestCell(activeCells(cells, activePhases()), p.x, p.z, 0.45) : null;
}
// Toque numa casa = ir; arrastar = mirar (16 direções), como no original
let drag = null, hoverCell = null;
const canPlay = () => reviewState === 'posicionamento' && !busy && !matchOver && !playerFell;
canvas.addEventListener('pointerdown', (ev) => {
  if (!canPlay()) return;
  drag = { x: ev.clientX, y: ev.clientY, aiming: false };
  canvas.setPointerCapture(ev.pointerId);
});
canvas.addEventListener('pointermove', (ev) => {
  if (drag && !drag.aiming && Math.hypot(ev.clientX - drag.x, ev.clientY - drag.y) > 8) drag.aiming = true;
  if (drag?.aiming) {
    const p = groundAtPointer(ev);
    if (p && playerRig) {
      const a = Math.atan2(p.z - playerRig.position.z, p.x - playerRig.position.x);
      setAim(Math.round(a / STEP16));
    }
    hoverCell = null;
    canvas.style.cursor = 'grabbing';
    return;
  }
  hoverCell = canPlay() ? cellAtPointer(ev) : null;
  if (hoverCell === playerCell) hoverCell = null;
  canvas.style.cursor = hoverCell ? 'pointer' : '';
});
canvas.addEventListener('pointerup', (ev) => {
  if (!drag) return;
  const wasAiming = drag.aiming;
  drag = null;
  canvas.style.cursor = '';
  if (wasAiming || !canPlay()) return;
  const c = cellAtPointer(ev);
  if (c) movePlayerTo(c);
});
canvas.addEventListener('pointerleave', () => { hoverCell = null; });
$('tglCrowd').addEventListener('click', async (e) => {
  const on = !(venue && venue.visible);
  setToggle(e.currentTarget, on);
  await toggleVenue(on);
});
$('tglQuality').addEventListener('click', (e) => {
  lite = !lite; setToggle(e.currentTarget, lite);
  renderer.shadowMap.enabled = !lite;
  scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
  bloom.enabled = !lite;
  // vidro: transmissão exige um passe extra de renderização; no modo leve vira transparência simples
  scene.traverse((o) => {
    const m = o.material;
    if (!m || (m.userData.transmission ?? m.transmission) === undefined) return;
    if (m.userData.transmission === undefined) m.userData.transmission = m.transmission;
    if (m.userData.transmission > 0) m.transmission = !lite && (CINEMA || params.has('refraction')) ? m.userData.transmission : 0;
  });
  layout();
});
$('tglStats').addEventListener('click', (e) => { const s = $('stats'); s.hidden = !s.hidden; $('benchmark').hidden=s.hidden; setToggle(e.currentTarget, !s.hidden); });
$('btnReloadEnemies').addEventListener('click', async () => { await loadEnemies(); toast('Modelos dos adversários verificados novamente'); });
// Valor da série: só muda os números ilustrativos do painel (×1,37 e +0,60x por abate, como na tela do original)
document.querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.chip').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  seriesValue = Number(b.dataset.v);
  $('qPot').textContent = brl(seriesValue * 1.37);
  $('qKill').textContent = '+' + brl(seriesValue * 0.6);
  updateUI();
}));
$('rotLeft').addEventListener('click', () => setAim(playerAimK - 1));
$('rotRight').addEventListener('click', () => setAim(playerAimK + 1));
$('lock').addEventListener('click', () => (matchOver ? resetArena() : lockRound()));

// Start the game audio bed as soon as the arena is ready. Browser autoplay
// restrictions are handled by retrying on the first interaction, without
// treating a rejected autoplay attempt as the user's choice to mute.
let audioReady=false;
const audioMix=new ArenaAudio((label)=>{ $('tglSound').textContent = /indispon/i.test(label) ? 'Som: indisponível' : `Som: ${audioMix.enabled ? 'ligado' : 'desligado'}`; });
function syncAudio(){audioMix.sync({ready:audioReady,state:reviewState,sweep:lasersOn,crowd:true,moving:!!playerMove});}
$('tglSound').addEventListener('click',()=>{
  if (audioMix.blocked) { audioMix.enabled=true; audioMix.retryAfterGesture(); return; }
  audioMix.enabled=!audioMix.enabled;
  syncAudio();
});
$('audioVolume').addEventListener('input',(e)=>audioMix.setVolume(e.target.value/100));
const isSoundControl=(event)=>event.target?.closest?.('#tglSound');
document.addEventListener('pointerdown',(event)=>{if(!isSoundControl(event))audioMix.retryAfterGesture();},{capture:true});
document.addEventListener('keydown',(event)=>{if(!isSoundControl(event))audioMix.retryAfterGesture();},{capture:true});
window.addEventListener('pagehide',()=>audioMix.stop());

// ---------- Métricas reais ----------
const stats = { frames: 0, acc: 0, fps: 0, ms: 0, calls: 0, tris: 0, last: performance.now(), win: performance.now() };
function updateStats(now) {
  const dt = now - stats.last; stats.last = now;
  stats.frames++; stats.acc += dt;
  stats.calls = renderer.info.render.calls; stats.tris = renderer.info.render.triangles;
  if (now - stats.win >= 1000) {
    stats.fps = (stats.frames * 1000) / (now - stats.win);
    stats.ms = stats.acc / stats.frames;
    stats.frames = 0; stats.acc = 0; stats.win = now;
    const gl = renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'n/d';
    const txt = `FPS ${stats.fps.toFixed(1)} · frame ${stats.ms.toFixed(2)} ms\n` +
      `draw calls ${stats.calls} · triângulos ${stats.tris.toLocaleString('pt-BR')}\n` +
      `${renderer.domElement.width}×${renderer.domElement.height} px · DPR ${renderer.getPixelRatio()}\n` +
      `câmera ${usedMode} · ${lite ? 'modo leve' : 'qualidade alta'}\nGPU ${gpu}`;
    $('stats').textContent = txt;
    window.__stats = { fps: stats.fps, frameMs: stats.ms, calls: stats.calls, triangles: stats.tris, w: renderer.domElement.width, h: renderer.domElement.height, dpr: renderer.getPixelRatio(), mode: usedMode, lite, gpu };
  }
}

// Medição estável: amostra intervalos entre quadros por `ms` (após o quadro atual) e devolve média/p95.
const samples = [];
let sampling = false;
window.__measure = (ms = 5000) => new Promise((resolve) => {
  samples.length = 0; sampling = true;
  setTimeout(() => {
    sampling = false;
    const d = samples.slice(1).sort((a, b) => a - b);
    const avg = d.reduce((a, b) => a + b, 0) / d.length;
    resolve({ frames: d.length, fpsAvg: +(1000 / avg).toFixed(1), frameMsAvg: +avg.toFixed(2),
      frameMsP95: +d[Math.floor(d.length * 0.95)].toFixed(2), frameMsMax: +d[d.length - 1].toFixed(2),
      drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles,
      canvas: `${renderer.domElement.width}x${renderer.domElement.height}`, dpr: renderer.getPixelRatio(), lite, camera: usedMode,
      gpu: window.__stats?.gpu });
  }, ms);
});
$('btnBenchmark').addEventListener('click', async () => {
  const button=$('btnBenchmark'), out=$('benchmarkResult');
  button.disabled=true;
  const initial={width:canvas.width,height:canvas.height,lite,state:reviewState,lasersOn,crowd:!!venue?.visible};
  let interrupted=false;
  const check=()=>{interrupted=true;};
  document.addEventListener('visibilitychange',check);
  window.addEventListener('resize',check);
  out.textContent='Medindo 30 segundos. Mantenha esta aba visível e os controles sem alterações.';
  const result=await window.__measure(30000);
  const final={width:canvas.width,height:canvas.height,lite,state:reviewState,lasersOn,crowd:!!venue?.visible};
  document.removeEventListener('visibilitychange',check);
  window.removeEventListener('resize',check);
  out.textContent=JSON.stringify({...result,durationSeconds:30,configuration:initial,valid:!interrupted&&JSON.stringify(initial)===JSON.stringify(final)&&result.frames>0},null,2);
  button.disabled=false;
});
let lastT = 0;

// ---------- Loop ----------
const timer = new THREE.Timer();
function frame(now) {
  requestAnimationFrame(frame);
  renderer.info.reset();
  updateFalling(now);
  updatePlayerMove(now);
  updateBeacon(now);
  for (const fog of exteriorVolumes) fog.userData.update(camera, now / 1000);
  timer.update(now);
  updateSmoke(now, timer.getDelta());
  updateLasers(timer.getElapsed());
  updatePlayerFx(now);
  updateContactShadows();
  updateAimPreview(now, timer.getDelta());
  updateRise(now);
  updateTweens(now);
  updateBlasts(now);
  updateDissolves(now);
  syncAudio();
  composer.render();
  updateStats(now);
  if (sampling && lastT) samples.push(now - lastT);
  lastT = now;
}

// ---------- Boot ----------
(async () => {
  if (REF_MODE) document.body.classList.add('ref');
  const small = window.matchMedia('(max-width: 760px), (max-aspect-ratio: 1/1)').matches;
  try {
    await loadArena();
    const player = await loadPlayer();
    buildSlots(Math.atan2(playerCenter.z, playerCenter.x));   // ângulo do centro do jogador
    buildLasers();
    if (REF_MODE) lasersOn = false;
    await toggleVenue(true); setToggle($('tglCrowd'), true);                 // torcida sempre ligada (pedido do Celio)
    loadEnemies();
  } catch (err) {
    console.error(err);
    $('loading').textContent = 'Falha ao carregar arena: ' + err.message;
    return;
  }
  setToggle($('tglLasers'), lasersOn);
  if (params.has('revisao')) $('reviewTools').hidden = false;
  // Keep the evenly spaced rail-mounted rig; the floating overhead spot row was removed.
  // Capture the actual venue/LEDs for material reflections instead of a generic white room.
  scene.updateMatrixWorld(true);
  const reflectionTarget=new THREE.WebGLCubeRenderTarget(512,{type:THREE.HalfFloatType,generateMipmaps:true,minFilter:THREE.LinearMipmapLinearFilter});
  const reflectionCamera=new THREE.CubeCamera(.1,60,reflectionTarget);
  reflectionCamera.position.set(0,2.4,0);
  exteriorVolumes.forEach((fog) => { fog.visible = false; });
  reflectionCamera.update(renderer,scene);
  exteriorVolumes.forEach((fog) => { fog.visible = true; });
  const venueReflection=pmrem.fromCubemap(reflectionTarget.texture);
  scene.environment=venueReflection.texture;scene.environmentIntensity=.65;
  reflectionTarget.dispose();
  aimToCenterFrom(playerCell);                                            // começa virado para o centro
  if (playerRig) { const a = playerAimAngle(); playerRig.rotation.y = Math.atan2(Math.cos(a), Math.sin(a)); }
  buildAimPreview();
  setReviewState(params.get('estado') in STATE_HINT ? params.get('estado') : 'posicionamento');
  updateUI();
  layout();
  $('loading').classList.add('done');
  window.addEventListener('resize', layout);
  requestAnimationFrame(frame);
  audioReady=true;
  syncAudio();
  window.__ready = true;
  window.__dbg = { bays, bayFit, gtao, dissolveRobot, explodeAt, lockRound, setAim, aim: () => playerAimK, cellStyles: () => cellStyleCache, isBusy: () => busy, result: () => matchResult, beacon: () => beacon, playerMoveState: () => playerMove, smoke, cells: () => cells, playerRig: () => playerRig, playerCell: () => playerCell, enemySlots, spawnEnemies, movePlayerTo, isGameOver: () => gameOver, setReviewState, THREE, renderer, scene, composer, bloom, camera, key, fill, warm, layout, phaseGroups, dropNext, resetArena };
})();
