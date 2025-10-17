"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VolumeFaderPlugin = exports.CompressorPlugin = exports.TreblePlugin = exports.BassPlugin = exports.FluentChain = exports.PluginRegistry = exports.FluentStream = exports.Processor = void 0;
/**
 * Core public API: low-level `Processor` and fluent `SimpleFFmpeg` wrapper.
 */
var Core_1 = require("./Core");
Object.defineProperty(exports, "Processor", { enumerable: true, get: function () { return Core_1.Processor; } });
Object.defineProperty(exports, "FluentStream", { enumerable: true, get: function () { return Core_1.FluentStream; } });
Object.defineProperty(exports, "PluginRegistry", { enumerable: true, get: function () { return Core_1.PluginRegistry; } });
Object.defineProperty(exports, "FluentChain", { enumerable: true, get: function () { return Core_1.FluentChain; } });
var bass_1 = require("./plugins/bass");
Object.defineProperty(exports, "BassPlugin", { enumerable: true, get: function () { return bass_1.BassPlugin; } });
var treble_1 = require("./plugins/treble");
Object.defineProperty(exports, "TreblePlugin", { enumerable: true, get: function () { return treble_1.TreblePlugin; } });
var compressor_1 = require("./plugins/compressor");
Object.defineProperty(exports, "CompressorPlugin", { enumerable: true, get: function () { return compressor_1.CompressorPlugin; } });
var volume_1 = require("./plugins/volume");
Object.defineProperty(exports, "VolumeFaderPlugin", { enumerable: true, get: function () { return volume_1.VolumeFaderPlugin; } });
//# sourceMappingURL=index.js.map