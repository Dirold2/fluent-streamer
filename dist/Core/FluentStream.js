"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = exports.FluentStream = void 0;
const tslib_1 = require("tslib");
const eventemitter3_1 = require("eventemitter3");
const stream_1 = require("stream");
const PluginRegistry_js_1 = tslib_1.__importDefault(require("./PluginRegistry.js"));
const Processor_js_1 = tslib_1.__importDefault(require("./Processor.js"));
/**
 * Internal class for "hot swapping" audio plugin chains without stopping the pipeline.
 * Acts as a Transform stream that proxies data through the current plugin chain.
 *
 * @internal
 */
class PluginHotSwap extends stream_1.Transform {
    activeChain;
    constructor(initialChain) {
        super();
        this.activeChain = initialChain;
        this.wireChain(this.activeChain);
    }
    /**
     * Set up listeners for data and errors for the active plugin chain.
     * @param chain The chain to wire.
     */
    wireChain(chain) {
        chain.on('data', (chunk) => {
            if (!this.push(chunk)) {
                chain.pause();
            }
        });
        chain.on('error', (err) => this.emit('error', err));
    }
    /**
     * Remove listeners from the given plugin chain.
     * @param chain The chain to unwire.
     */
    unwireChain(chain) {
        chain.removeAllListeners('data');
        chain.removeAllListeners('error');
    }
    /** Invoked when the consumer is ready to read more data. */
    _read() {
        this.activeChain.resume();
    }
    /** Called when data is written to this stream to process it through the plugin chain. */
    _transform(chunk, _encoding, callback) {
        if (!this.activeChain.write(chunk)) {
            this.activeChain.once('drain', callback);
        }
        else {
            callback();
        }
    }
    /** Called when the input stream ends. */
    _flush(callback) {
        this.activeChain.end(() => {
            callback();
        });
    }
    /**
     * Hot-swap the current plugin chain for a new one.
     * @param newChain The new plugin Transform chain to use.
     */
    async swap(newChain) {
        const oldChain = this.activeChain;
        const promise = new Promise((resolve) => {
            oldChain.once('end', () => {
                this.unwireChain(oldChain);
                resolve();
            });
        });
        // Switch to the new chain for all new data
        this.activeChain = newChain;
        this.wireChain(this.activeChain);
        // End the old chain and wait until it finishes processing
        oldChain.end();
        await promise;
    }
}
/**
 * The FluentStream class provides a convenient, fluent API wrapper around a low-level `Processor` for working with FFmpeg.
 * Allows you to easily configure FFmpeg commands, manage inputs/outputs, and build advanced audio processing pipelines using plugins.
 * Supports building complex transcoding and media processing pipelines through chained methods, including handling user-defined audio plugins.
 *
 * @example <caption>Basic file conversion</caption>
 * const stream = new FluentStream()
 *   .input("input.mp3")
 *   .audioCodec("aac")
 *   .audioBitrate("192k")
 *   .output("output.aac");
 *
 * const { output, done } = stream.run();
 * output.pipe(fs.createWriteStream("output.aac"));
 * await done;
 *
 * @example <caption>Using audio effect plugins</caption>
 * // Register a custom plugin
 * FluentStream.registerPlugin("gain", opts => new GainPlugin(opts));
 *
 * // Using a registered plugin
 * const stream = new FluentStream()
 *   .input(fs.createReadStream("raw.wav"))
 *   .usePlugins(
 *     enc => enc.audioCodec("aac").output("final.m4a"),
 *     { name: "gain", options: { gainDb: 6 } }
 *   );
 *
 * const { output, done } = stream.run();
 * output.pipe(fs.createWriteStream("final.m4a"));
 * await done;
 *
 * @example <caption>Dynamically update plugins during processing</caption>
 * await stream.updatePlugins({ name: "compressor", options: { threshold: -20 } });
 *
 * @see run
 */
class FluentStream extends eventemitter3_1.EventEmitter {
    static _globalRegistry = null;
    // --- Humanity header addition ---
    static HUMANITY_HEADER = {
        "X-Human-Intent": "true",
        "X-Request-Attention": "just-want-to-do-my-best",
        "User-Agent": "FluentStream/1.0 (friendly bot)"
    };
    static get globalRegistry() {
        if (!this._globalRegistry)
            this._globalRegistry = new PluginRegistry_js_1.default();
        return this._globalRegistry;
    }
    /**
     * Register a plugin for later use by name across all FluentStream instances.
     * @param name Plugin name.
     * @param factory Factory function to create a plugin instance given options.
     * @example
     * FluentStream.registerPlugin("normalize", opts => new NormalizePlugin(opts));
     */
    static registerPlugin(name, factory) {
        this.globalRegistry.register(name, factory);
    }
    /**
     * Check if a plugin is registered globally by name.
     * @param name Plugin name.
     * @returns true if the plugin is registered globally.
     */
    static hasPlugin(name) {
        return this.globalRegistry.has(name);
    }
    /**
     * Clear all globally registered plugins.
     */
    static clearPlugins() {
        this._globalRegistry = new PluginRegistry_js_1.default();
    }
    args = [];
    inputStreams = [];
    complexFilters = [];
    options;
    // State for two-process pipeline with plugins
    audioTransform = null;
    pluginHotSwap = null;
    pcmOptions = null;
    encoderBuilder = null;
    _pluginControllers = [];
    /**
     * FluentStream constructor.
     * @param options Optional configuration for the FFmpeg/Processor.
     */
    constructor(options = {}) {
        super();
        this.options = options;
    }
    getAudioTransform() {
        if (!this.audioTransform)
            throw new Error("Audio transform not initialized. Call usePlugins() first.");
        return this.audioTransform;
    }
    clear() {
        this.audioTransform = null;
        this.pluginHotSwap = null;
        this.pcmOptions = null;
        this.encoderBuilder = null;
        this._pluginControllers = [];
        this.args = [];
        this.inputStreams = [];
        this.complexFilters = [];
    }
    // ===================== Fluent API ========================
    /**
     * Add an input file or stream to the FFmpeg command.
     * Multiple calls allowed for files (only one for streams).
     * Throws if called after .usePlugins().
     * @param input File path or a Readable stream.
     * @example
     * stream.input("input.mp3");
     * stream.input(fs.createReadStream("foo.wav"));
     */
    input(input) {
        if (this.encoderBuilder)
            throw new Error("Cannot add new inputs after .usePlugins() has been called.");
        if (typeof input === "string") {
            this.args.push("-i", input);
        }
        else {
            if (this.inputStreams.length > 0)
                throw new Error("Multiple stream inputs are not supported.");
            this.inputStreams.push({ stream: input, index: 0 });
            this.args.push("-i", "pipe:0");
        }
        return this;
    }
    /**
     * Set the output file for FFmpeg.
     * @param output Output file path.
     * @example
     * stream.output("output.mp3")
     */
    output(output) {
        this.args.push(output);
        return this;
    }
    /**
     * Add global FFmpeg options (before inputs).
     * @param opts Array of FFmpeg options (e.g. "-hide_banner", "-y").
     * @example
     * stream.globalOptions("-y", "-hide_banner");
     */
    globalOptions(...opts) { this.args.unshift(...opts); return this; }
    /**
     * Add FFmpeg options for the last input.
     * @param opts Options for the corresponding input (e.g. "-ss", "30").
     * @example
     * stream.inputOptions("-ss", "10");
     */
    inputOptions(...opts) {
        const lastInputIndex = this.args.lastIndexOf("-i");
        if (lastInputIndex !== -1)
            this.args.splice(lastInputIndex, 0, ...opts);
        else
            this.args.unshift(...opts);
        return this;
    }
    /**
     * Add FFmpeg output options.
     * @param opts Output options (e.g. "-map", "0:a").
     * @example
     * stream.outputOptions("-map", "0:a");
     */
    outputOptions(...opts) { this.args.push(...opts); return this; }
    /**
     * Set the video codec.
     * Skips if codec is falsy/empty.
     * @param codec Codec name (e.g. "libx264").
     * @example
     * stream.videoCodec("libx264")
     */
    videoCodec(codec) {
        if (codec)
            this.args.push("-c:v", codec);
        return this;
    }
    /**
     * Set the audio codec.
     * Skips if codec is falsy/empty.
     * @param codec Audio codec name (e.g. "aac").
     * @example
     * stream.audioCodec("aac")
     */
    audioCodec(codec) {
        if (codec)
            this.args.push("-c:a", codec);
        return this;
    }
    /**
     * Set the video bitrate.
     * @param bitrate Bitrate string (e.g. "1M").
     * @example
     * stream.videoBitrate("1M")
     */
    videoBitrate(bitrate) { this.args.push("-b:v", bitrate); return this; }
    /**
     * Set the audio bitrate.
     * @param bitrate Bitrate string (e.g. "192k").
     * @example
     * stream.audioBitrate("192k")
     */
    audioBitrate(bitrate) { this.args.push("-b:a", bitrate); return this; }
    /**
     * Specify the output format for FFmpeg.
     * Calling multiple times replaces the previous format.
     * @param format Format string (e.g. "mp3").
     * @example
     * stream.format("mp3")
     */
    format(format) {
        // Remove any previous -f and its argument
        for (let i = 0; i < this.args.length - 1;) {
            if (this.args[i] === "-f") {
                this.args.splice(i, 2);
            }
            else {
                i++;
            }
        }
        this.args.push("-f", format);
        return this;
    }
    /**
     * Set the duration limit.
     * @param time Time in seconds or FFmpeg time string (e.g. "00:00:30").
     * @example
     * stream.duration(20)
     * stream.duration("00:01:10")
     */
    duration(time) { this.args.push("-t", String(time)); return this; }
    /**
     * Disable video stream in the output.
     * @example
     * stream.noVideo()
     */
    noVideo() { this.args.push("-vn"); return this; }
    /**
     * Disable audio stream in the output.
     * @example
     * stream.noAudio();
     */
    noAudio() { this.args.push("-an"); return this; }
    /**
     * Set the audio sample rate.
     * @param freq Sample rate (e.g. 44100)
     * @example
     * stream.audioFrequency(48000)
     */
    audioFrequency(freq) { this.args.push("-ar", String(freq)); return this; }
    /**
     * Copy all codecs without transcoding.
     * Ensures only one "-c copy" is present.
     * @example
     * stream.copyCodecs()
     */
    copyCodecs() {
        // Only add "-c copy" if it's not already present.
        for (let i = 0; i < this.args.length - 1;) {
            if (this.args[i] === "-c" && this.args[i + 1] === "copy") {
                // Already present, don't add and return immediately.
                return this;
            }
            else {
                i++;
            }
        }
        this.args.push("-c", "copy");
        return this;
    }
    /**
     * Allow overwriting the output file (-y).
     * @example
     * stream.overwrite()
     */
    overwrite() { this.args.push("-y"); return this; }
    /**
     * Use FFmpeg -map to map input streams to output.
     * @param label Map label string.
     * @example
     * stream.map("0:a:0")
     */
    map(label) { this.args.push('-map', label); return this; }
    /**
     * Seek to a specified input time using -ss.
     * @param time Time in seconds or FFmpeg time string.
     * @example
     * stream.seekInput(30)
     */
    seekInput(time) {
        const lastInputIndex = this.args.lastIndexOf("-i");
        const seekArgs = ['-ss', String(time)];
        if (lastInputIndex !== -1)
            this.args.splice(lastInputIndex, 0, ...seekArgs);
        else
            this.args.unshift(...seekArgs);
        return this;
    }
    /**
     * Add a FFmpeg filter_complex graph to the pipeline.
     * Can be called multiple times.
     * Ignores empty strings.
     * @param graph Filter string or array of strings.
     * @example
     * stream.complexFilter("[0:a]loudnorm[aout]");
     */
    complexFilter(graph) {
        if (Array.isArray(graph)) {
            for (const g of graph) {
                if (typeof g === 'string' && g.trim() !== "") {
                    this.complexFilters.push(g);
                }
            }
        }
        else if (typeof graph === "string" && graph.trim() !== "") {
            this.complexFilters.push(graph);
        }
        return this;
    }
    /**
     * Adds an audio crossfade (acrossfade) filter between two audio streams to the filter_complex graph.
     * Throws if number of inputs is not exactly 2.
     * @param duration Duration in seconds.
     * @param options Optional channel labels.
     * @example
     * stream.crossfadeAudio(2.5, { inputA: '[0:a]', inputB: '[1:a]', outputLabel: 'acrossfaded' })
     */
    crossfadeAudio(duration, options) {
        const inputCount = this.args.filter(arg => arg === "-i").length;
        if (inputCount !== 2) {
            throw new Error(`crossfadeAudio requires exactly 2 input files, but got ${inputCount}`);
        }
        const inputA = options?.inputA ?? '[0:a]';
        const inputB = options?.inputB ?? '[1:a]';
        const outputLabel = options?.outputLabel ?? 'aout';
        const graph = `${inputA}${inputB}acrossfade=d=${duration}[${outputLabel}]`;
        return this.complexFilter(graph).map(`[${outputLabel}]`);
    }
    /**
     * Alias for usePlugins for a single plugin.
     * @param buildEncoder Function that configures the output FluentStream encoder.
     * @param pluginConfig Plugin string or object with its options.
     * @example
     * stream.usePlugin(enc => enc.output("out.ogg"), "normalize");
     */
    usePlugin(buildEncoder, pluginConfig) {
        return this.usePlugins(buildEncoder, pluginConfig);
    }
    /**
     * Switch the pipeline into plugin-processing mode.
     * Multiple plugins (chained) can be specified.
     * @param buildEncoder Function receiving a FluentStream for configuring the encoder (output process).
     * @param pluginConfigs One or more plugins: either a name string or an object { name, options }
     * @example
     * stream.input("in.wav").usePlugins(
     *   enc => enc.audioBitrate("192k").output("out.ogg"),
     *   "normalize", { name: "compressor" }
     * );
     */
    usePlugins(buildEncoder, ...pluginConfigs) {
        if (pluginConfigs.length === 0)
            throw new Error("usePlugins requires at least one plugin.");
        const chain = FluentStream.globalRegistry.chain(...pluginConfigs);
        this._pluginControllers = chain.getControllers();
        this.encoderBuilder = buildEncoder;
        // Create an instance of PluginHotSwap to manage the audio transform pipeline
        const initialChainTransform = chain.getTransform();
        this.pluginHotSwap = new PluginHotSwap(initialChainTransform);
        this.audioTransform = this.pluginHotSwap;
        this.pcmOptions = this._pluginControllers[0]?.getOptions?.() ?? { sampleRate: 48000, channels: 2 };
        return this;
    }
    /**
     * Returns the plugin controllers, for usePlugins-style interface.
     * When called as a property on the result of usePlugins, is bound.
     */
    getControllers() {
        return this._pluginControllers;
    }
    /**
     * Hot-swap (update) the plugin chain at runtime without stopping the pipeline.
     * ONLY after calling usePlugins().
     * @param pluginConfigs New configuration(s) for plugin(s).
     * @example
     * await stream.updatePlugins("compressor", { name: "custom", options: {...} });
     */
    async updatePlugins(...pluginConfigs) {
        if (!this.pluginHotSwap) {
            throw new Error("Plugins can only be updated after .usePlugins() has been called.");
        }
        if (pluginConfigs.length === 0) {
            throw new Error("updatePlugins requires at least one plugin.");
        }
        const newChainInstance = FluentStream.globalRegistry.chain(...pluginConfigs);
        const newTransform = newChainInstance.getTransform();
        await this.pluginHotSwap.swap(newTransform);
        this._pluginControllers = newChainInstance.getControllers();
    }
    /**
     * Get the array of plugin controller instances currently in use.
     * @returns An array of AudioPlugin instances.
     */
    getPluginControllers() {
        return this._pluginControllers;
    }
    /**
     * Run the constructed FFmpeg pipeline.
     * If plugins are used: spawns both a decoder, plugin-processing chain, and encoder (dual process).
     * Returns an object with output Readable stream, a done promise, and a stop function.
     *
     * @example
     * const { output, done, stop } = stream.run();
     * output.pipe(fs.createWriteStream("foo.ogg"));
     * await done;
     */
    run() {
        if (this.encoderBuilder && this.audioTransform && this.pcmOptions) {
            return this.runWithPlugins();
        }
        return this.runSingleProcess();
    }
    /**
     * Get the current array of arguments for the ffmpeg process.
     * @returns FFmpeg argument array.
     * @example
     * const args = stream.getArgs();
     */
    getArgs() {
        return [...this.args];
    }
    // ---- Private Methods ----
    assembleArgs() {
        const finalArgs = [...this.args];
        if (this.complexFilters.length > 0) {
            finalArgs.push('-filter_complex', this.complexFilters.join(';'));
        }
        if (this.options.failFast && !finalArgs.includes('-xerror')) {
            finalArgs.push('-xerror');
        }
        if (this.options.enableProgressTracking && !finalArgs.some(arg => arg === '-progress')) {
            finalArgs.push('-progress', 'pipe:2');
        }
        return finalArgs;
    }
    addHumanityHeadersToProcessorOptions(options) {
        // "headers" may or may not be present; normalize it
        const originalHeaders = typeof options.headers === "object" && options.headers !== null
            ? options.headers
            : {};
        return {
            ...options,
            headers: {
                ...originalHeaders,
                ...FluentStream.HUMANITY_HEADER
            }
        };
    }
    runSingleProcess() {
        // Добавим "человечность" к headers в опциях для Processor
        const processorOptions = this.addHumanityHeadersToProcessorOptions(this.options);
        const processor = new Processor_js_1.default(processorOptions);
        this.setupProcessorEvents(processor);
        processor.setArgs(this.assembleArgs());
        if (this.inputStreams.length > 0)
            processor.setInputStreams(this.inputStreams);
        return processor.run();
    }
    runWithPlugins() {
        // Fix for ffmpeg commands:
        // Properly decode to 16-bit signed little-endian PCM, ar/channels, pipe:1
        // Remove double -c:a for output
        // Decoder command:
        // ffmpeg -f mp3 -i input.mp3 -c:a pcm_s16le -f s16le -ar 48000 -ac 2 pipe:1
        const decoderArgs = [
            ...this.assembleArgs(),
            '-c:a', 'pcm_s16le',
            '-f', 's16le',
            '-ar', String(this.pcmOptions.sampleRate),
            '-ac', String(this.pcmOptions.channels),
            'pipe:1'
        ];
        const decoderProcessorOptions = this.addHumanityHeadersToProcessorOptions({
            ...this.options,
            loggerTag: "ffmpeg-decoder"
        });
        const decoderProcessor = new Processor_js_1.default(decoderProcessorOptions);
        this.setupProcessorEvents(decoderProcessor, 'decoder');
        decoderProcessor.setArgs(decoderArgs);
        if (this.inputStreams.length > 0)
            decoderProcessor.setInputStreams(this.inputStreams);
        const encoder = new FluentStream(this.options);
        this.encoderBuilder(encoder);
        // Encoder command:
        // ffmpeg -f s16le -ar 48000 -ac 2 -i pipe:0 ...user args... pipe:1
        // No extra -f s16le/-ar/-ac unless user calls it themselves via encoder options
        // Remove duplicate -f/-ar/-ac/-c:a from encoder arguments to avoid redundancy
        const encoderBaseArgs = [
            '-f', 's16le',
            '-ar', String(this.pcmOptions.sampleRate),
            '-ac', String(this.pcmOptions.channels),
            '-i', 'pipe:0',
        ];
        const userArgs = encoder.assembleArgs().filter((arg, idx, arr) => {
            if (arg === '-f' && arr[idx + 1] === 's16le')
                return false;
            if (arg === '-ar' && arr[idx + 1] === String(this.pcmOptions.sampleRate))
                return false;
            if (arg === '-ac' && arr[idx + 1] === String(this.pcmOptions.channels))
                return false;
            if (arg === '-c:a' && (arr[idx + 1] === 'pcm_s16le' || arr[idx + 1] === 'pcm_s1le'))
                return false;
            return true;
        });
        const encoderArgs = [
            ...encoderBaseArgs,
            ...userArgs
        ];
        const encoderProcessorOptions = this.addHumanityHeadersToProcessorOptions({
            ...this.options,
            loggerTag: "ffmpeg-encoder"
        });
        const encoderProcessor = new Processor_js_1.default(encoderProcessorOptions);
        this.setupProcessorEvents(encoderProcessor, 'encoder');
        encoderProcessor.setArgs(encoderArgs);
        const { output: decoderOutput, done: decoderDone } = decoderProcessor.run();
        const { output: finalOutput, done: encoderDone } = encoderProcessor.run();
        (0, stream_1.pipeline)(decoderOutput, this.audioTransform, encoderProcessor.process.stdin, (err) => {
            if (err) {
                this.emit('error', new Error(`Plugin pipeline failed: ${err.message}`));
                decoderProcessor.kill();
                encoderProcessor.kill();
            }
        });
        const done = Promise.all([decoderDone, encoderDone]).then(() => undefined);
        const stop = () => {
            decoderProcessor.kill();
            encoderProcessor.kill();
        };
        return { output: finalOutput, done, stop };
    }
    setupProcessorEvents(processor, prefix) {
        const emit = (event, data) => {
            if (prefix)
                this.emit(`${prefix}:${event}`, data);
            this.emit(event, data);
        };
        processor.on("spawn", (data) => emit("spawn", data));
        processor.on("start", (cmd) => emit("start", cmd));
        processor.on("progress", (p) => emit("progress", p));
        processor.on("end", () => emit("end", { processor: prefix }));
        processor.on("terminated", (s) => emit("terminated", s));
        processor.on("error", (e) => emit("error", e));
    }
}
exports.FluentStream = FluentStream;
exports.default = FluentStream;
//# sourceMappingURL=FluentStream.js.map