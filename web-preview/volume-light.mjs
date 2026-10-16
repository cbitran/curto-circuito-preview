// Luz volumétrica leve (falso volume por marcha de raio curta dentro de uma caixa unitária).
// Usado na coluna da mira e no halo da casa do jogador: densidade suave nas bordas, forte no piso,
// sumindo para cima, com variação lenta. Aditivo, sem escrever profundidade. Câmera ortográfica ou perspectiva.
import * as THREE from 'three';

const vertexShader = /* glsl */`
  varying vec3 vLocal;
  varying vec3 vViewDirLocal;
  uniform vec3 uCamDir;          // direção da câmera no mundo (ortográfica)
  uniform vec3 uCamPos;          // posição da câmera no mundo (perspectiva)
  uniform float uOrtho;
  void main() {
    vLocal = position;                                   // caixa unitária: 0..1 em x, y, z
    vec4 world = modelMatrix * vec4(position, 1.0);
    vec3 dirWorld = uOrtho > 0.5 ? uCamDir : normalize(world.xyz - uCamPos);
    vViewDirLocal = (inverse(modelMatrix) * vec4(dirWorld, 0.0)).xyz;   // em unidades da caixa
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const fragmentShader = /* glsl */`
  varying vec3 vLocal;
  varying vec3 vViewDirLocal;
  uniform mat4 uWorld;
  uniform float uFloor;
  uniform vec3 uSize;            // dimensões reais da caixa (u)
  uniform vec3 uColor;
  uniform float uIntensity;
  uniform float uTime;
  uniform int uMode;             // 0 = coluna da mira (eixo X); 1 = halo em anel (centro da caixa)
  uniform float uRing;           // raio do anel (modo 1)
  uniform float uWidth;          // meia largura (desvio) da densidade

  float hash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 45758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
  }
  float density(vec3 q) {        // q em unidades reais, origem no canto da caixa
    if (uMode == 2) {
      vec3 worldQ=(uWorld*vec4(q/uSize,1.0)).xyz;
      if(worldQ.y<uFloor+.005) return 0.0;
      float along=q.x/uSize.x;
      float coneR=.025+along*uSize.y*.5;
      float radius=length(q.yz-uSize.yz*.5)/coneR;
      float soft=1.0-smoothstep(.38,1.0,radius);
      float wisps=.72+.28*noise(q.xy*2.4+q.z*.7+vec2(uTime*.06,-uTime*.08));
      return soft*wisps*exp(-along*.75)*smoothstep(0.0,.035,along)*(1.0-smoothstep(.88,1.0,along));
    }
    float h = q.y / uSize.y;
    float vert = exp(-3.2 * h) * smoothstep(0.0, 0.04, h);                 // forte no piso, some para cima
    if (uMode == 0) {
      float across = (q.z - 0.5 * uSize.z) / uWidth;
      float along = q.x / uSize.x;
      // Feather both emitter and destination: a volume should dissipate into the floor,
      // not end with a visible planar cut.
      float ends = smoothstep(0.0, 0.06, along) * (1.0-smoothstep(0.76,1.0,along));
      float flow = 0.75 + 0.25 * noise(vec2(q.x * 1.6 - uTime * 1.8, q.y * 2.0));
      return exp(-across * across * 2.2) * vert * ends * flow;
    }
    vec2 c = q.xz - 0.5 * uSize.xz;
    float r = length(c);
    float dr = (r - uRing) / uWidth, rc = r / (uRing * 0.9);
    float band = exp(-dr * dr * 2.0) + 0.35 * exp(-rc * rc * 2.5);         // x*x: pow com base negativa é indefinido
    float flow = 0.8 + 0.2 * noise(vec2(atan(c.y, c.x) * 3.0 + uTime * 0.8, q.y * 3.0));
    return band * vert * flow;
  }
  void main() {
    // marcha do ponto de saída (face de trás) em direção à câmera, até sair da caixa
    vec3 rd = -normalize(vViewDirLocal);
    vec3 ro = vLocal;
    vec3 inv = 1.0 / max(abs(rd), vec3(1e-5)) * sign(rd + 1e-9);
    vec3 t0 = (vec3(0.0) - ro) * inv, t1 = (vec3(1.0) - ro) * inv;
    float tFar = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), max(t0.z, t1.z));
    tFar = max(tFar, 0.0);
    const int STEPS = 48;
    float dt = tFar / float(STEPS);
    float acc = 0.0;
    for (int i = 0; i < STEPS; i++) {
      vec3 p = ro + rd * (float(i) + 0.5) * dt;
      acc += density(p * uSize) * dt * length(rd * uSize);
    }
    float a = 1.0 - exp(-acc * 1.6);
    gl_FragColor = vec4(clamp(uColor * uIntensity * a, 0.0, 8.0), 1.0);
    // Linear HDR output; OutputPass performs the sole display conversion.
  }
`;

export function createVolumeLight({ color, mode = 0, ring = 0.7, width = 0.25 }) {
  const geometry = new THREE.BoxGeometry(1, 1, 1).translate(0.5, 0.5, 0.5);
  const material = new THREE.ShaderMaterial({
    vertexShader, fragmentShader,
    uniforms: {
      uWorld:{value:new THREE.Matrix4()},
      uFloor:{value:-100},
      uSize: { value: new THREE.Vector3(1, 1, 1) },
      uColor: { value: new THREE.Color(color) },
      uIntensity: { value: 1 },
      uTime: { value: 0 },
      uMode: { value: mode },
      uRing: { value: ring },
      uWidth: { value: width },
      uCamDir: { value: new THREE.Vector3(0, -1, 0) },
      uCamPos: { value: new THREE.Vector3() },
      uOrtho: { value: 1 },
    },
    side: THREE.BackSide, transparent: true, depthWrite: false, depthTest:mode!==2, blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  // dimensiona a caixa (u) e mantém a densidade em unidades reais
  mesh.userData.setSize = (x, y, z) => { mesh.scale.set(x, y, z); material.uniforms.uSize.value.set(x, y, z); };
  mesh.userData.update = (camera, time) => {
    mesh.updateWorldMatrix(true,false);material.uniforms.uWorld.value.copy(mesh.matrixWorld);
    camera.getWorldDirection(material.uniforms.uCamDir.value);
    material.uniforms.uCamPos.value.copy(camera.position);
    material.uniforms.uOrtho.value = camera.isOrthographicCamera ? 1 : 0;
    material.uniforms.uTime.value = time;
  };
  return mesh;
}
