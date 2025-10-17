"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CompressorPlugin = void 0;
const stream_1 = require("stream");
/**
 * Simple dynamic range compressor.
 * Limits peaks above threshold.
 */
class CompressorPlugin {
    threshold;
    ratio;
    constructor(threshold = 0.8, ratio = 4) {
        this.threshold = threshold;
        this.ratio = ratio;
    }
    setParams(threshold, ratio) {
        this.threshold = threshold;
        this.ratio = ratio;
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
                            let val = samples[idx] / 32768;
                            const abs = Math.abs(val);
                            if (abs > this.threshold) {
                                val =
                                    Math.sign(val) *
                                        (this.threshold + (abs - this.threshold) / this.ratio);
                            }
                            samples[idx] = Math.round(Math.max(-1, Math.min(1, val)) * 32767);
                        }
                    }
                    cb(null, chunk);
                }
                catch (e) {
                    cb(e);
                }
            },
        });
        t._threshold = this.threshold;
        t._ratio = this.ratio;
        return t;
    }
}
exports.CompressorPlugin = CompressorPlugin;
//# sourceMappingURL=compressor.js.map