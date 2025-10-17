"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VolumeFaderPlugin = void 0;
const stream_1 = require("stream");
/**
 * Volume fade plugin.
 * Smoothly interpolates volume over frames.
 */
class VolumeFaderPlugin {
    start;
    end;
    constructor(start = 1, end = 1) {
        this.start = start;
        this.end = end;
    }
    setFade(start, end) {
        this.start = start;
        this.end = end;
    }
    createTransform(options) {
        const { channels } = options;
        const t = new stream_1.Transform({
            transform: (chunk, _enc, cb) => {
                try {
                    const samples = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.length / 2);
                    const frameCount = samples.length / channels;
                    for (let frame = 0; frame < frameCount; frame++) {
                        const factor = this.start + ((this.end - this.start) * frame) / frameCount;
                        for (let c = 0; c < channels; c++) {
                            const idx = frame * channels + c;
                            let val = samples[idx] / 32768;
                            samples[idx] = Math.round(Math.max(-1, Math.min(1, val * factor)) * 32767);
                        }
                    }
                    cb(null, chunk);
                }
                catch (e) {
                    cb(e);
                }
            },
        });
        t._start = this.start;
        t._end = this.end;
        return t;
    }
}
exports.VolumeFaderPlugin = VolumeFaderPlugin;
//# sourceMappingURL=volume.js.map