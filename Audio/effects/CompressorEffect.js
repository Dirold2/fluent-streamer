"use strict";import{compressSample as t}from"./utils.js";export class CompressorEffect{name="compressor";_enabled;constructor(e){this._enabled=e}get enabled(){return this._enabled}setEnabled(e){this._enabled=e}isActive(){return this._enabled}process(e,n,o){if(this._enabled)for(let s=0;s<e.length;s++)e[s]=t(e[s])}reset(){}}
//# sourceMappingURL=CompressorEffect.js.map
