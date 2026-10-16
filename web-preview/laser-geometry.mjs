export const beamsVisible = (state, sweep) => state === 'disparo' || (state === 'inspecao' && sweep);
export function rayToOctagon(px, pz, dx, dz, R) {
  let best = Infinity;
  for (let i = 0; i < 8; i++) {
    const nx = Math.cos(i * Math.PI / 4), nz = Math.sin(i * Math.PI / 4);
    const dn = dx * nx + dz * nz;
    if (dn > 1e-8) best = Math.min(best, (R - px * nx - pz * nz) / dn);
  }
  return Number.isFinite(best) ? Math.max(0, best) : 0;
}
