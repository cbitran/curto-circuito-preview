import {beamsVisible} from './laser-geometry.mjs';
export function audibleTracks(s) {
  // Visibility/focus do not control playback: the bed should keep running when
  // the player moves to another window. `ready` only prevents playback pre-boot.
  if (!s.enabled || !s.ready) return [];
  const tracks = ['music'];
  if (s.crowd) tracks.push('crowd');
  if (s.state === 'inspecao' || s.moving) tracks.push('robot'); // motor: rotação na inspeção ou carrinho em movimento
  if (beamsVisible(s.state, s.sweep)) tracks.push('laser');
  return tracks;
}
