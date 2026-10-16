// Lógica pura da rodada demonstrativa (sem Three.js, testável com node --test).
// O sorteio aqui é só VISUAL, no navegador: no jogo real o servidor decide posições e resultado.

// Casas das fases ainda ativas (centro = fase 1 sempre ativo).
export const activeCells = (cells, activePhases) => cells.filter((c) => activePhases.includes(c.phase));

// Casa mais próxima de (x, z) dentro de `maxDist`; null se nenhuma.
export function nearestCell(cells, x, z, maxDist) {
  let best = null, bd = maxDist;
  for (const c of cells) {
    const d = Math.hypot(c.x - x, c.z - z);
    if (d <= bd) { bd = d; best = c; }
  }
  return best;
}

// Escolhe `count` casas sem sobrepor robôs: centro a centro >= minDist entre si e dos ocupados.
// Embaralha e tenta de forma gulosa; repete até `tries` vezes. Devolve [] se não couber.
export function pickSpawnCells(cells, occupied, count, minDist, rng = Math.random, tries = 300) {
  const free = (c, taken) => taken.every((o) => Math.hypot(o.x - c.x, o.z - c.z) >= minDist);
  for (let t = 0; t < tries; t++) {
    const pool = cells.slice();
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    const picked = [];
    for (const c of pool) {
      if (free(c, [...occupied, ...picked])) picked.push(c);
      if (picked.length === count) return picked;
    }
  }
  return [];
}

// Um feixe reto de (ox, oz) na direção unitária (dx, dz), com comprimento `len`, cruza o círculo (cx, cz, r)?
export function beamHitsCircle(ox, oz, dx, dz, len, cx, cz, r) {
  const t = (cx - ox) * dx + (cz - oz) * dz;          // projeção do centro no feixe
  if (t < 0 || t > len + r) return false;
  const tc = Math.min(t, len);
  return Math.hypot(ox + dx * tc - cx, oz + dz * tc - cz) <= r;
}
