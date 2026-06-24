export const VOLUME_MIN = 0;
export const VOLUME_MAX = 1;
export const BASS_MIN = -20;
export const BASS_MAX = 20;
export const TREBLE_MIN = -20;
export const TREBLE_MAX = 20;

export interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

export interface BiquadState {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

export interface FilterState {
  bassShelfL: BiquadState;
  bassShelfR: BiquadState;
  bassPeakL: BiquadState;
  bassPeakR: BiquadState;
  trebleShelfL: BiquadState;
  trebleShelfR: BiquadState;
  treblePeakL: BiquadState;
  treblePeakR: BiquadState;
}
