"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GainPlugin = void 0;
const stream_1 = require("stream");
/**
 * Simple gain plugin example: multiplies samples by a factor.
 */
class GainPlugin {
    gain;
    constructor(gain) {
        this.gain = gain;
    }
    setGain(g) {
        this.gain = g;
    }
    createTransform(options) {
        const { channels } = options;
        const t = new stream_1.Transform({
            transform: (chunk, _enc, cb) => {
                try {
                    const samples = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.length / 2);
                    for (let i = 0; i < samples.length; i += channels) {
                        for (let c = 0; c < channels; c++) {
                            const idx = i + c;
                            const val = samples[idx] / 32768;
                            const scaled = Math.max(-1, Math.min(1, val * t._gain));
                            samples[idx] = Math.round(scaled * 32767);
                        }
                    }
                    cb(null, chunk);
                }
                catch (e) {
                    cb(e);
                }
            },
        });
        t._gain = this.gain;
        return t;
    }
}
exports.GainPlugin = GainPlugin;
//# sourceMappingURL=Filters.js.map