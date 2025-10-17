"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TreblePlugin = void 0;
const stream_1 = require("stream");
class TreblePlugin {
    treble;
    constructor(treble) {
        this.treble = treble;
    }
    setTreble(t) {
        this.treble = t;
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
                            // Simple treble boost simulation (linear for demo)
                            val = val * (1 + this.treble * 0.3);
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
        t._treble = this.treble;
        return t;
    }
}
exports.TreblePlugin = TreblePlugin;
//# sourceMappingURL=treble.js.map