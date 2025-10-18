"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BassPlugin = void 0;
const stream_1 = require("stream");
/**
 * Bass boost plugin.
 * Усиление басов на PCM аудио.
 */
class BassPlugin {
    options;
    constructor(options) {
        this.options = { sampleRate: 48000, channels: 2, ...options };
    }
    /** Динамически меняем настройки */
    setOptions(options) {
        this.options = { ...this.options, ...options };
    }
    getOptions() {
        return this.options;
    }
    createTransform(options) {
        const opts = options ?? this.options;
        const { channels, bass } = opts;
        const t = new stream_1.Transform({
            transform: (chunk, _enc, cb) => {
                try {
                    const samples = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.length / 2);
                    for (let i = 0; i < samples.length; i += channels) {
                        for (let c = 0; c < channels; c++) {
                            const idx = i + c;
                            let val = samples[idx] / 32768;
                            val = val * (1 + bass * 0.5);
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
        t._bass = bass;
        return t;
    }
}
exports.BassPlugin = BassPlugin;
//# sourceMappingURL=bass.js.map