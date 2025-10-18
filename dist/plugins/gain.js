"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GainPlugin = void 0;
const stream_1 = require("stream");
/**
 * Simple gain plugin example.
 * Multiplies each audio sample by a gain factor.
 */
class GainPlugin {
    options;
    constructor(options) {
        this.options = { sampleRate: 48000, channels: 2, ...options };
    }
    setOptions(options) {
        this.options = { ...this.options, ...options };
    }
    getOptions() {
        return this.options;
    }
    /**
     * Creates a Node.js Transform stream that applies the gain to PCM s16le audio.
     * @param options - Audio options (sampleRate, channels)
     * @returns Transform stream that processes audio
     */
    createTransform(options) {
        const opts = options ?? this.options;
        const { channels, gain } = opts;
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
        t._gain = gain;
        return t;
    }
}
exports.GainPlugin = GainPlugin;
//# sourceMappingURL=gain.js.map