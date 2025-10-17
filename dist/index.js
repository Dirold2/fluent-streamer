"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VolumeFaderPlugin = exports.CompressorPlugin = exports.TreblePlugin = exports.BassPlugin = exports.FluentChain = exports.PluginRegistry = exports.FluentStream = exports.Processor = void 0;
/**
 * Core public API: low-level `Processor` and fluent `SimpleFFmpeg` wrapper.
 */
var index_js_1 = require("./Core/index.js");
Object.defineProperty(exports, "Processor", { enumerable: true, get: function () { return index_js_1.Processor; } });
Object.defineProperty(exports, "FluentStream", { enumerable: true, get: function () { return index_js_1.FluentStream; } });
Object.defineProperty(exports, "PluginRegistry", { enumerable: true, get: function () { return index_js_1.PluginRegistry; } });
Object.defineProperty(exports, "FluentChain", { enumerable: true, get: function () { return index_js_1.FluentChain; } });
var bass_js_1 = require("./plugins/bass.js");
Object.defineProperty(exports, "BassPlugin", { enumerable: true, get: function () { return bass_js_1.BassPlugin; } });
var treble_js_1 = require("./plugins/treble.js");
Object.defineProperty(exports, "TreblePlugin", { enumerable: true, get: function () { return treble_js_1.TreblePlugin; } });
var compressor_js_1 = require("./plugins/compressor.js");
Object.defineProperty(exports, "CompressorPlugin", { enumerable: true, get: function () { return compressor_js_1.CompressorPlugin; } });
var volume_js_1 = require("./plugins/volume.js");
Object.defineProperty(exports, "VolumeFaderPlugin", { enumerable: true, get: function () { return volume_js_1.VolumeFaderPlugin; } });
//# sourceMappingURL=index.js.map