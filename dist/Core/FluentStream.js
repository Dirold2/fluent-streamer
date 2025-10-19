"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
const node_events_1 = require("node:events");
const Processor_js_1 = tslib_1.__importDefault(require("./Processor.js"));
const PluginRegistry_js_1 = tslib_1.__importDefault(require("./PluginRegistry.js"));
const PluginHotSwap_js_1 = tslib_1.__importDefault(require("./PluginHotSwap.js"));
/**
 * FluentStream: main fluent API for building FFmpeg pipelines.
 * Supports plugins, advanced chains, and hot plugin swapping.
 *
 * @example
 * // Basic usage:
 * const fs = new FluentStream();
 * fs.input("input.mp3")
 *   .audioCodec("aac")
 *   .output("output.aac")
 *   .run();
 */
class FluentStream extends node_events_1.EventEmitter {
    static registry = new PluginRegistry_js_1.default();
    static _globalRegistry = null;
    static HUMANITY_HEADER = {
        "X-Human-Intent": "true",
        "X-Request-Attention": "just-want-to-do-my-best",
        "User-Agent": "FluentStream/1.0 (friendly bot)",
    };
    /**
     * Returns the global (singleton) plugin registry.
     *
     * @example
     * FluentStream.globalRegistry.register("myPlugin", myFactory);
     */
    static get globalRegistry() {
        if (!this._globalRegistry)
            this._globalRegistry = new PluginRegistry_js_1.default();
        return this._globalRegistry;
    }
    /**
     * Registers a plugin globally for all FluentStream instances.
     *
     * @param name The plugin name.
     * @param factory Factory function returning a plugin instance.
     * @example
     * FluentStream.registerPlugin("custom", opts => new CustomPlugin(opts));
     */
    static registerPlugin(name, factory) {
        this.globalRegistry.register(name, factory);
    }
    /**
     * Checks if a plugin is registered in the global registry.
     *
     * @param name Plugin name.
     * @returns true if plugin exists.
     * @example
     * if (FluentStream.hasPlugin("loudnorm")) { ... }
     */
    static hasPlugin(name) {
        return this.globalRegistry.has(name);
    }
    /**
     * Clears all plugins from the global registry.
     * @example
     * FluentStream.clearPlugins();
     */
    static clearPlugins() {
        this._globalRegistry = new PluginRegistry_js_1.default();
    }
    // ----- Instance fields -----
    args = [];
    inputStreams = [];
    complexFilters = [];
    options;
    _headers;
    audioTransform = null;
    pluginHotSwap = null;
    pcmOptions = null;
    encoderBuilder = null;
    pluginControllers = [];
    /**
     * Creates a new FluentStream instance.
     * @param options Optional processor options. You can specify a `headers` key to override default headers.
     *
     * @example
     * const fs = new FluentStream({ failFast: true });
     */
    constructor(options = {}) {
        super();
        this.options = { ...options };
        // Allow explicit headers (undefined, empty, custom, or inherit default)
        if (typeof options.headers === "object" && options.headers !== null) {
            this._headers = options.headers;
        }
        else if (options.headers === undefined) {
            this._headers = undefined; // meaning use default when needed
        }
        else {
            this._headers = {};
        }
    }
    /**
     * Sets custom HTTP headers to be used for the ffmpeg process.
     * Overrides any headers configured in constructor or set before.
     * If headers is undefined or null, default FluentStream.HUMANITY_HEADER will be used.
     *
     * @param headers Object with header fields, or undefined/null to use default.
     * @returns this
     * @example
     * fs.setHeaders({'Authorization': 'Bearer ...'})
     */
    setHeaders(headers) {
        if (headers === undefined || headers === null) {
            this._headers = undefined;
        }
        else {
            this._headers = headers;
        }
        return this;
    }
    /**
     * Returns the headers that will be used for the ffmpeg process.
     * Will return either custom, empty, or default headers.
     *
     * @returns A copy of the HTTP headers.
     * @example
     * const headers = fs.getHeaders();
     */
    getHeaders() {
        if (this._headers === undefined) {
            return { ...FluentStream.HUMANITY_HEADER };
        }
        return { ...this._headers }; // shallow copy
    }
    /**
     * Resets this FluentStream instance's state for re-use.
     * Keeps any custom headers.
     *
     * @example
     * fs.clear();
     */
    clear() {
        this.audioTransform = null;
        this.pluginHotSwap = null;
        this.pcmOptions = null;
        this.encoderBuilder = null;
        this.pluginControllers = [];
        this.args = [];
        this.inputStreams = [];
        this.complexFilters = [];
        // keep _headers as-is
    }
    // --- Core builder methods ---
    /**
     * Adds an input for the ffmpeg process. Supports file path or stream.
     * Must be called before plugins are used.
     *
     * @param input Input file path or readable stream.
     * @returns this
     * @example
     * fs.input("audio.mp3")
     *    .input(fs.createReadStream('track.wav'));
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
     * Adds an output for the ffmpeg process.
     *
     * @param output Output file path, writable stream, numeric fd, or undefined/null for stdout.
     * @returns this
     * @example
     * fs.output("output.wav")
     * fs.output(1) // for stdout
     */
    output(output) {
        this.args.push(String(output));
        return this;
    }
    /**
     * Adds global ffmpeg options (before all input/output).
     *
     * @param opts One or more ffmpeg arguments.
     * @returns this
     * @example
     * fs.globalOptions('-hide_banner', '-loglevel', 'error')
     */
    globalOptions(...opts) {
        this.args.unshift(...opts);
        return this;
    }
    /**
     * Adds input options (must be before the last -i).
     *
     * @param opts One or more ffmpeg arguments.
     * @returns this
     * @example
     * fs.inputOptions('-ss', '5')
     */
    inputOptions(...opts) {
        const lastInputIndex = this.args.lastIndexOf("-i");
        if (lastInputIndex !== -1) {
            this.args.splice(lastInputIndex, 0, ...opts);
        }
        else {
            this.args.unshift(...opts);
        }
        return this;
    }
    /**
     * Adds output options after all outputs.
     *
     * @param opts One or more ffmpeg arguments.
     * @returns this
     * @example
     * fs.outputOptions('-movflags', 'faststart')
     */
    outputOptions(...opts) {
        this.args.push(...opts);
        return this;
    }
    /**
     * Sets the video codec to use.
     *
     * @param codec Video codec name.
     * @returns this
     * @example
     * fs.videoCodec('libx264')
     */
    videoCodec(codec) {
        if (codec)
            this.args.push("-c:v", codec);
        return this;
    }
    /**
     * Sets the audio codec to use.
     *
     * @param codec Audio codec name.
     * @returns this
     * @example
     * fs.audioCodec('aac')
     */
    audioCodec(codec) {
        if (codec)
            this.args.push("-c:a", codec);
        return this;
    }
    /**
     * Sets the video bitrate.
     *
     * @param bitrate Bitrate string, e.g., "1000k"
     * @returns this
     * @example
     * fs.videoBitrate('1200k')
     */
    videoBitrate(bitrate) {
        this.args.push("-b:v", bitrate);
        return this;
    }
    /**
     * Sets the audio bitrate.
     *
     * @param bitrate Bitrate string, e.g., "192k"
     * @returns this
     * @example
     * fs.audioBitrate('192k')
     */
    audioBitrate(bitrate) {
        this.args.push("-b:a", bitrate);
        return this;
    }
    /**
     * Sets the output format.
     *
     * @param format Format name, e.g. "mp3"
     * @returns this
     * @example
     * fs.format('flac')
     */
    format(format) {
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
     * Sets a maximum duration (seconds or time string).
     *
     * @param time Duration (e.g. 120, "00:02:00")
     * @returns this
     * @example
     * fs.duration(60)
     */
    duration(time) {
        this.args.push("-t", String(time));
        return this;
    }
    /**
     * Disables video streams in the output.
     *
     * @returns this
     * @example
     * fs.noVideo()
     */
    noVideo() {
        this.args.push("-vn");
        return this;
    }
    /**
     * Disables audio streams in the output.
     *
     * @returns this
     * @example
     * fs.noAudio()
     */
    noAudio() {
        this.args.push("-an");
        return this;
    }
    /**
     * Sets audio sample rate (frequency).
     *
     * @param freq Frequency e.g. 44100
     * @returns this
     * @example
     * fs.audioFrequency(48000)
     */
    audioFrequency(freq) {
        this.args.push("-ar", String(freq));
        return this;
    }
    /**
     * Sets number of audio channels.
     *
     * @param channels Number of channels e.g. 2
     * @returns this
     * @example
     * fs.audioChannels(2)
     */
    audioChannels(channels) {
        this.args.push("-ac", String(channels));
        return this;
    }
    /**
     * Use codec copy mode for all streams.
     *
     * @returns this
     * @example
     * fs.copyCodecs()
     */
    copyCodecs() {
        for (let i = 0; i < this.args.length - 1;) {
            if (this.args[i] === "-c" && this.args[i + 1] === "copy") {
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
     * Adds one or more complex filter graphs.
     *
     * @param graph String or array of filter graph strings.
     * @returns this
     * @example
     * fs.complexFilter('[0:a][1:a]acrossfade')
     */
    complexFilter(graph) {
        if (Array.isArray(graph)) {
            for (const g of graph) {
                if (typeof g === "string" && g.trim() !== "") {
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
     * Adds audio crossfade (acrossfade filter) between two inputs.
     *
     * @param duration Crossfade duration (seconds)
     * @param opts Additional options
     * @returns this
     * @example
     * fs.input('a.mp3').input('b.mp3').crossfadeAudio(4)
     */
    crossfadeAudio(duration, opts) {
        let inputCount = this.args.filter((arg) => arg === "-i").length +
            (Array.isArray(this.inputStreams) ? this.inputStreams.length : 0);
        if (inputCount < 2 && opts?.input2) {
            this.input(opts.input2);
            inputCount++;
        }
        if (inputCount < 2) {
            throw new Error("crossfadeAudio requires at least 2 inputs set before calling this method (or provide {input2}).");
        }
        if (duration == null || (typeof duration === "number" && isNaN(duration))) {
            return this;
        }
        const { filter } = Processor_js_1.default.buildAcrossfadeFilter({
            inputs: opts?.inputs ?? 2,
            duration,
            curve1: opts?.curve1 ?? opts?.c1 ?? "tri",
            curve2: opts?.curve2 ?? opts?.c2 ?? "tri",
            nb_samples: opts?.nb_samples,
            overlap: opts?.overlap,
            inputLabels: opts?.inputLabels,
            outputLabel: opts?.outputLabel,
        });
        let filterStr = filter;
        if (opts?.additional && opts.additional.trim()) {
            filterStr += `:${opts.additional.trim()}`;
        }
        this.complexFilters.push(filterStr);
        this.args.push("-filter_complex", filterStr);
        return this;
    }
    // ---- Plugin API ----
    /**
     * Alias for usePlugins. Adds a single plugin and sets up plugin pipeline.
     *
     * @param buildEncoder Function that configures the final encoder.
     * @param pluginConfig Single plugin configuration.
     * @returns this
     * @example
     * fs.usePlugin(enc => enc.audioCodec('mp3'), "loudnorm")
     */
    usePlugin(buildEncoder, pluginConfig) {
        return this.usePlugins(buildEncoder, pluginConfig);
    }
    /**
     * Adds one or more plugins and sets up the plugin pipeline. Enables transform chain.
     *
     * @param buildEncoder Function to configure the encoder instance (output).
     * @param pluginConfigs List of plugin configurations.
     * @returns this
     * @example
     * fs.usePlugins(enc => enc.audioCodec('aac'), "eq", {name:"loudnorm"})
     */
    usePlugins(buildEncoder, ...pluginConfigs) {
        if (pluginConfigs.length === 0)
            throw new Error("usePlugins requires at least one plugin.");
        const chain = FluentStream.globalRegistry.chain(...pluginConfigs);
        this.pluginControllers = chain.getControllers();
        this.encoderBuilder = buildEncoder;
        const initialChainTransform = chain.getTransform();
        this.pluginHotSwap = new PluginHotSwap_js_1.default(initialChainTransform);
        this.audioTransform = this.pluginHotSwap;
        this.pcmOptions = this.pluginControllers[0]?.getOptions?.() ?? {
            sampleRate: 48000,
            channels: 2,
        };
        return this;
    }
    /**
     * Hot-swap plugin chain during processing.
     *
     * @param pluginConfigs New plugin configuration(s).
     * @returns Promise<void>
     * @example
     * await fs.updatePlugins("highpass", {name: "loudnorm"})
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
        this.pluginControllers = newChainInstance.getControllers();
    }
    /**
     * Gets the current plugin controller instances.
     *
     * @returns Array of AudioPlugin controllers.
     * @example
     * const controllers = fs.getPluginControllers();
     */
    getPluginControllers() {
        return this.pluginControllers;
    }
    // --- Pipeline helpers, args, and run ---
    /**
     * Returns a copy of ffmpeg argument list that will be used.
     *
     * @returns Array of string arguments.
     * @example
     * console.log(fs.getArgs())
     */
    getArgs() {
        return [...this.args];
    }
    assembleArgs() {
        const finalArgs = [...this.args];
        if (this.complexFilters.length > 0 &&
            !finalArgs.includes("-filter_complex")) {
            finalArgs.push("-filter_complex", this.complexFilters.join(";"));
        }
        if (this.options.failFast && !finalArgs.includes("-xerror")) {
            finalArgs.push("-xerror");
        }
        if (this.options.enableProgressTracking &&
            !finalArgs.some((arg) => arg === "-progress")) {
            finalArgs.push("-progress", "pipe:2");
        }
        // ffmpeg_1760884412131: insert flags for low-latency/low-probe if used as input source
        // Only add for pipe:0 or http/https input
        // Heuristic: if input (args) includes "-i <url>" with http/https, or "-i pipe:0", prepend flags
        let needsLowDelay = false;
        for (let i = 0; i < finalArgs.length - 1; i++) {
            if (finalArgs[i] === "-i" &&
                typeof finalArgs[i + 1] === "string" &&
                (finalArgs[i + 1].startsWith("http://") ||
                    finalArgs[i + 1].startsWith("https://") ||
                    finalArgs[i + 1] === "pipe:0")) {
                needsLowDelay = true;
                break;
            }
        }
        if (needsLowDelay) {
            // Avoid duplicates by filtering first
            const lowDelayFlags = [
                "-fflags", "nobuffer",
                "-flags", "low_delay",
                "-probesize", "32",
                "-analyzeduration", "0"
            ];
            // Remove any pre-existing occurrence of these flags from finalArgs
            let i = 0;
            while (i < finalArgs.length) {
                if ((finalArgs[i] === "-fflags" && finalArgs[i + 1] === "nobuffer") ||
                    (finalArgs[i] === "-flags" && finalArgs[i + 1] === "low_delay") ||
                    (finalArgs[i] === "-probesize" && finalArgs[i + 1] === "32") ||
                    (finalArgs[i] === "-analyzeduration" && finalArgs[i + 1] === "0")) {
                    finalArgs.splice(i, 2);
                }
                else {
                    i++;
                }
            }
            // Prepend to beginning for maximal effect (before all -i <input>)
            finalArgs.unshift(...lowDelayFlags);
        }
        return finalArgs;
    }
    /**
     * Used internally to merge user, default, and no headers logic.
     * If headers were set by setHeaders or in constructor, use them;
     * If not, use the default HUMANITY_HEADER.
     * If headers is empty object, use none.
     */
    getMergedHeaders() {
        if (this._headers === undefined) {
            // default
            return { ...FluentStream.HUMANITY_HEADER };
        }
        else if (this._headers &&
            typeof this._headers === "object" &&
            Object.keys(this._headers).length > 0) {
            return { ...this._headers };
        }
        // explicit empty or {} disables default headers
        return {};
    }
    addHumanityHeadersToProcessorOptions(options) {
        // If user explicitly set headers (even {}), respect that. Else, use default headers.
        let mergedHeaders = this.getMergedHeaders();
        return {
            ...options,
            headers: mergedHeaders,
        };
    }
    createProcessor(extraOpts = {}, args, inputStreams) {
        // Always supply headers via addHumanityHeadersToProcessorOptions
        const opts = this.addHumanityHeadersToProcessorOptions({
            ...this.options,
            ...extraOpts,
        });
        return Processor_js_1.default.create({
            args: args ?? this.assembleArgs(),
            inputStreams: inputStreams ?? this.inputStreams,
            options: opts,
        });
    }
    collectStreams() {
        // For compatibility with plugins and main input API.
        if (this.inputStreams.length > 0)
            return [...this.inputStreams];
        return [];
    }
    /**
     * Starts execution of the ffmpeg pipeline.
     * Selects plugin-based mode if plugins in use, else single process.
     *
     * @returns FFmpegRunResult object {output, done, stop}
     * @example
     * const { output, done } = fs.run();
     */
    run() {
        if (this.encoderBuilder && this.audioTransform && this.pcmOptions) {
            return this.runWithPlugins();
        }
        return this.runSingleProcess();
    }
    runSingleProcess() {
        const proc = this.createProcessor();
        return proc.run();
    }
    runWithPlugins() {
        // 1. Decoder (first pipeline)
        const decoder = this.createProcessor(undefined, undefined, this.collectStreams());
        // 2. Encoder
        const encoder = new FluentStream({
            ...this.options,
            headers: this._headers,
        }); // also propagate headers
        if (!this.encoderBuilder) {
            throw new Error("No encoderBuilder provided for plugin pipeline.");
        }
        this.encoderBuilder(encoder);
        // ---- ffmpeg_1760884412131 START: Insert low-latency flags to encoder if needed ----
        // When setting up encoder process (s16le → ...), also add the same flags if input is pipe:0
        let encArgs = encoder.assembleArgs();
        // Remove global -i ... for encoder, since we're supplying ["-f", "s16le", "-i", "pipe:0", ...encArgs]
        // But useful: check if encArgs already has those flags, avoid duplicates
        // But let's be sure: if the input ("-i", "pipe:0") exists, add the same flags in front
        // We can't know for certain if encoder actually needs low_delay, but it's harmless for PCM.
        const lowDelayFlags = [
            "-fflags", "nobuffer",
            "-flags", "low_delay",
            "-probesize", "32",
            "-analyzeduration", "0",
        ];
        // Remove any pre-existing occurrence of these flags from encArgs
        let ei = 0;
        while (ei < encArgs.length) {
            if ((encArgs[ei] === "-fflags" && encArgs[ei + 1] === "nobuffer") ||
                (encArgs[ei] === "-flags" && encArgs[ei + 1] === "low_delay") ||
                (encArgs[ei] === "-probesize" && encArgs[ei + 1] === "32") ||
                (encArgs[ei] === "-analyzeduration" && encArgs[ei + 1] === "0")) {
                encArgs.splice(ei, 2);
            }
            else {
                ei++;
            }
        }
        // Always prepend low-latency flags to encoder's arguments for s16le/pcm scenarios
        encArgs = [...lowDelayFlags, ...encArgs];
        // ---- ffmpeg_1760884412131 END ----
        const encProc = encoder.createProcessor(undefined, ["-f", "s16le", "-i", "pipe:0", ...encArgs], []);
        // 3. Set up run and connect decoder→plugins→encoder
        const { output: dOut, done: dDone } = decoder.run();
        const { output: eOut, done: eDone, stop } = encProc.run();
        if (!this.audioTransform) {
            throw new Error("audioTransform is not defined.");
        }
        const transformStream = this.audioTransform;
        const encoderInputStream = encProc.getInputStream();
        if (!encoderInputStream) {
            throw new Error("encProc.getInputStream() returned undefined.");
        }
        dOut.pipe(transformStream).pipe(encoderInputStream);
        return {
            output: eOut,
            done: Promise.all([dDone, eDone]).then(() => void 0),
            stop,
        };
    }
    // --- ADDITIONS FOR MISSING METHODS ---
    /**
     * Overwrites output files (-y flag).
     *
     * @returns this
     * @example
     * fs.overwrite()
     */
    overwrite() {
        this.args = this.args.filter((arg) => arg !== "-y");
        this.args.unshift("-y");
        return this;
    }
    /**
     * Adds a -map ffmpeg option to select specific streams.
     *
     * @param mapSpec Map specifier string.
     * @returns this
     * @example
     * fs.map('0:a:0')
     */
    map(mapSpec) {
        this.args.push("-map", mapSpec);
        return this;
    }
    /**
     * Seeks to a position in the input.
     *
     * @param position Time position (seconds or timestamp).
     * @returns this
     * @example
     * fs.seekInput(10)
     * fs.seekInput('00:01:00')
     */
    seekInput(position) {
        let firstInputIdx = this.args.findIndex((arg) => arg === "-i");
        if (firstInputIdx === -1) {
            this.args.unshift("-ss", String(position));
        }
        else {
            this.args.splice(firstInputIdx, 0, "-ss", String(position));
        }
        return this;
    }
    /**
     * Gets the current audio transform pipeline (Transform stream).
     * Only available after usePlugins() was called.
     *
     * @returns Transform stream representing audio pipeline.
     * @throws Error if used before usePlugins()
     * @example
     * const transform = fs.getAudioTransform();
     */
    getAudioTransform() {
        if (!this.audioTransform) {
            throw new Error("getAudioTransform() called before usePlugins() - no audio transform pipeline exists.");
        }
        return this.audioTransform;
    }
    /**
     * Gets the current plugin controllers (same as getPluginControllers).
     *
     * @returns Array of AudioPlugin controllers.
     * @example
     * fs.getControllers().forEach(ctrl => ...)
     */
    getControllers() {
        return this.pluginControllers;
    }
}
exports.default = FluentStream;
//# sourceMappingURL=FluentStream.js.map