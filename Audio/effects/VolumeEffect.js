"use strict";import{clampVolume as o}from"./utils.js";export class VolumeEffect{name="volume";_volume;constructor(e){this._volume=o(e)}get volume(){return this._volume}setVolume(e){this._volume=o(e)}isActive(){return this._volume!==1}process(e,m,u){if(this._volume===1)return;const s=this._volume;for(let t=0;t<e.length;t++)e[t]=e[t]*s}reset(){}}
//# sourceMappingURL=VolumeEffect.js.map
