import { VOLUME_MIN, VOLUME_MAX } from "../../Types/audio.js";

export function clampVolume(volume: number): number {
  return Math.max(VOLUME_MIN, Math.min(VOLUME_MAX, volume));
}

export class VolumeEffect {
  public value: number;

  constructor(initialVolume: number) {
    this.value = clampVolume(initialVolume);
  }

  public set(volume: number): void {
    this.value = clampVolume(volume);
  }
}
