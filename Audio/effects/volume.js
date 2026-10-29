"use strict";import{VOLUME_MIN as o,VOLUME_MAX as a}from"../../Types/audio.js";export function clampVolume(e){return Math.max(o,Math.min(a,e))}export class VolumeEffect{value;constructor(t){this.value=clampVolume(t)}set(t){this.value=clampVolume(t)}}
//# sourceMappingURL=volume.js.map
