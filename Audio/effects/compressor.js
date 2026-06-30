"use strict";export function compressSample(e,s=.8,n=4){const t=Math.abs(e);if(t<=s)return e;const c=t-s,o=s+c/n;return Math.sign(e)*o}export class CompressorEffect{enabled;constructor(s){this.enabled=s}set(s){this.enabled=s}}
//# sourceMappingURL=compressor.js.map
