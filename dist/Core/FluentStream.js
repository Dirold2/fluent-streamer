"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
const eventemitter3_1 = require("eventemitter3");
const Processor_js_1 = tslib_1.__importDefault(require("./Processor.js"));
const PluginRegistry_js_1 = tslib_1.__importDefault(require("./PluginRegistry.js"));
const PluginHotSwap_js_1 = tslib_1.__importDefault(require("./PluginHotSwap.js"));
/**
 * FluentStream provides a fluent, strongly-typed API for constructing and running FFmpeg processes.
 * It supports plugins, filter chains, transform streams, and advanced process configuration.
 *
 * See examples below.
 *
 * @example
 * // Simple audio conversion
 * const proc = new FluentStream()
 *   .input('song.mp3')
 *   .audioCodec('aac')
 *   .output('song.aac')
 *   .run();
 *
 * @example
 * // Use global plugins with plugin chain and custom headers
 * FluentStream.registerPlugin('myPlugin', opts => new MyPlugin(opts));
 *
 * const pipeline = new FluentStream({ enableProgressTracking: true })
 *   .setHeaders({ Authorization: 'Bearer abc123' })
 *   .input('input.wav')
 *   .usePlugins(
 *     enc => enc.audioCodec('aac').output('output.m4a'),
 *     "myPlugin",
 *     { name: "normalize", options: { level: 0.95 } }
 *   )
 *   .run();
 *
 * @example
 * // With custom filter and progress
 * const res = new FluentStream()
 *   .input('in.mp3')
 *   .complexFilter('volume=2')
 *   .output('out.mp3')
 *   .run();
 * res.process.on('progress', prog => console.log(prog));
 */
class FluentStream extends eventemitter3_1.EventEmitter {
    static registry = new PluginRegistry_js_1.default();
    static _globalRegistry = null;
    static HUMANITY_HEADER = Object.freeze({
        "X-Human-Intent": "true",
        "X-Request-Attention": "just-want-to-do-my-best",
        "User-Agent": "FluentStream/1.0 (friendly bot)",
    });
    /**
     * Forcibly clears all global plugins and plugin state (TESTING ONLY).
     * This is a test helper to reset plugin registries between tests.
     */
    static _reset() {
        this.clearPlugins?.();
        if (typeof this.globalRegistry?.clear === "function") {
            this.globalRegistry.clear();
        }
        if (this.registry && typeof this.registry.clear === "function") {
            this.registry.clear();
        }
    }
    /**
     * Retrieve the global plugin registry.
     */
    static get globalRegistry() {
        if (!this._globalRegistry)
            this._globalRegistry = new PluginRegistry_js_1.default();
        return this._globalRegistry;
    }
    /**
     * Register a new global audio plugin.
     * @param name - Name of the plugin.
     * @param factory - Factory function producing the plugin.
     * @template O Plugin options type.
     */
    static registerPlugin(name, factory) {
        this.globalRegistry.register(name, factory);
    }
    /**
     * Checks if a plugin is registered globally.
     * @param name - Plugin name.
     */
    static hasPlugin(name) {
        return this.globalRegistry.has(name);
    }
    /**
     * List all registered global plugins.
     */
    static listPlugins() {
        return this.globalRegistry.list();
    }
    /**
     * Unregister (remove) a global plugin by name.
     * @param name - Plugin name to remove.
     * @returns true if the plugin was removed, false otherwise.
     */
    static unregisterPlugin(name) {
        return this.globalRegistry.unregister(name);
    }
    /**
     * Clears all global plugins. Useful in testing.
     */
    static clearPlugins() {
        this._globalRegistry = new PluginRegistry_js_1.default();
    }
    args = [];
    inputStreams = [];
    complexFilters = [];
    options;
    _headers;
    audioTransform = null;
    pluginHotSwap = null;
    encoderBuilder = null;
    pluginControllers = [];
    /**
     * Creates a new FluentStream instance.
     * @param options - Optional processor options.
     */
    constructor(options = {}) {
        super();
        this.options = { ...options };
        if (typeof options.headers === "object" && options.headers !== null) {
            this._headers = options.headers;
        }
        else if (options.headers === undefined) {
            this._headers = undefined;
        }
        else {
            this._headers = {};
        }
    }
    /**
     * Set HTTP headers (overwrites previous). Null or undefined disables.
     * @param headers - Headers to set.
     */
    setHeaders(headers) {
        this._headers = headers == null ? undefined : headers;
        return this;
    }
    /**
     * Get HTTP headers (or HUMANITY_HEADER if unset).
     */
    getHeaders() {
        return this._headers === undefined
            ? { ...FluentStream.HUMANITY_HEADER }
            : { ...this._headers };
    }
    /**
     * Add or replace the `-headers` argument for FFmpeg.
     * @param headers - Custom headers.
     * @returns this
     */
    headers(headers) {
        this._headers = headers == null ? undefined : headers;
        // Remove old -headers argument(s)
        for (let i = 0; i < this.args.length;) {
            if (this.args[i] === "-headers" && typeof this.args[i + 1] === "string") {
                this.args.splice(i, 2);
            }
            else
                i++;
        }
        if (headers && Object.keys(headers).length > 0) {
            const headerString = Object.entries(headers)
                .map(([k, v]) => `${k}: ${v}`)
                .join("\r\n") + "\r\n";
            this.args.unshift("-headers", headerString);
        }
        return this;
    }
    /**
     * Add or replace the `-user-agent` argument for an input file.
     * @param userAgent - HTTP User-Agent string.
     */
    userAgent(userAgent) {
        for (let i = 0; i < this.args.length;) {
            if (this.args[i] === "-user-agent" &&
                typeof this.args[i + 1] === "string") {
                this.args.splice(i, 2);
            }
            else
                i++;
        }
        if (userAgent && userAgent.length > 0) {
            this.args.unshift("-user-agent", userAgent);
        }
        return this;
    }
    /**
     * Reset all FFmpeg args, plugin/pipeline settings, and filters.
     */
    clear() {
        this.audioTransform = null;
        this.pluginHotSwap = null;
        this.encoderBuilder = null;
        this.pluginControllers = [];
        this.args = [];
        this.inputStreams = [];
        this.complexFilters = [];
    }
    /**
     * Add an input (string/file or Readable stream).
     * Streams are supported as only one input.
     * @param input - Input filename or Readable stream.
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
     * Add an output (filename, stream, or descriptor).
     * @param output - Output target.
     */
    output(output) {
        this.args.push(String(output));
        return this;
    }
    /**
     * Add global FFmpeg options (placed before first `-i`).
     * @param opts - Option strings.
     */
    globalOptions(...opts) {
        this.args.unshift(...opts);
        return this;
    }
    /**
     * Add options before the last input.
     * @param opts - Option strings.
     */
    inputOptions(...opts) {
        const idx = this.args.lastIndexOf("-i");
        if (idx !== -1) {
            this.args.splice(idx, 0, ...opts);
        }
        else {
            this.args.unshift(...opts);
        }
        return this;
    }
    /**
     * Add options to the end, after outputs.
     * @param opts - Option strings.
     */
    outputOptions(...opts) {
        this.args.push(...opts);
        return this;
    }
    /**
     * Set video codec (adds `-c:v codec` if codec is truthy).
     * @param codec - Video codec name.
     */
    videoCodec(codec) {
        if (codec)
            this.args.push("-c:v", codec);
        return this;
    }
    /**
     * Set audio codec (adds `-c:a codec` if codec is truthy).
     * @param codec - Audio codec name.
     */
    audioCodec(codec) {
        if (codec)
            this.args.push("-c:a", codec);
        return this;
    }
    /**
     * Set video bitrate.
     * @param bitrate - Bitrate (e.g. '800k').
     */
    videoBitrate(bitrate) {
        this.args.push("-b:v", bitrate);
        return this;
    }
    /**
     * Set audio bitrate.
     * @param bitrate - Bitrate (e.g. '192k').
     */
    audioBitrate(bitrate) {
        this.args.push("-b:a", bitrate);
        return this;
    }
    /**
     * Set output format (adds or replaces `-f`).
     * @param format - Format name (e.g. 'mp3').
     */
    format(format) {
        for (let i = 0; i < this.args.length - 1;) {
            if (this.args[i] === "-f") {
                this.args.splice(i, 2);
            }
            else
                i++;
        }
        this.args.push("-f", format);
        return this;
    }
    /**
     * Limit FFmpeg run time duration (seconds or formatted string).
     * @param time - Duration to pass to FFmpeg's `-t`.
     */
    duration(time) {
        this.args.push("-t", String(time));
        return this;
    }
    /**
     * Disable all video streams (`-vn`).
     */
    noVideo() {
        this.args.push("-vn");
        return this;
    }
    /**
     * Disable all audio streams (`-an`).
     */
    noAudio() {
        this.args.push("-an");
        return this;
    }
    /**
     * Set audio sampling frequency (`-ar`).
     * @param freq - Frequency in Hz.
     */
    audioFrequency(freq) {
        this.args.push("-ar", String(freq));
        return this;
    }
    /**
     * Set number of audio channels (`-ac`).
     * @param channels - Channel count (e.g. 1 for mono).
     */
    audioChannels(channels) {
        this.args.push("-ac", String(channels));
        return this;
    }
    /**
     * Copy all codecs for all streams (`-c copy`).
     */
    copyCodecs() {
        if (this.args.some((_v, i, arr) => arr[i] === "-c" && arr[i + 1] === "copy")) {
            return this;
        }
        this.args.push("-c", "copy");
        return this;
    }
    /**
     * Add a complex filter specification (or array thereof).
     * @param graph - Filter string or array.
     */
    complexFilter(graph) {
        if (Array.isArray(graph)) {
            for (const g of graph) {
                if (typeof g === "string" && g.trim()) {
                    this.complexFilters.push(g);
                }
            }
        }
        else if (typeof graph === "string" && graph.trim()) {
            this.complexFilters.push(graph);
        }
        return this;
    }
    /**
     * Quickly cross-fade two audio inputs using `acrossfade` filter.
     * @param duration - Crossfade duration in seconds.
     * @param opts - Additional acrossfade options.
     * @throws if less than 2 inputs are present.
     */
    crossfadeAudio(duration, opts) {
        let inputCount = this.args.filter((arg) => arg === "-i").length +
            (Array.isArray(this.inputStreams) ? this.inputStreams.length : 0);
        if (inputCount < 2 && opts?.input2) {
            this.input(opts.input2);
            inputCount++;
        }
        if (inputCount < 2) {
            throw new Error("crossfadeAudio requires at least 2 inputs (or provide input2).");
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
    /**
     * Use a single plugin (shortcut for usePlugins).
     * @param buildEncoder - Function to configure the encoder.
     * @param pluginConfig - Plugin config.
     */
    usePlugin(buildEncoder, pluginConfig) {
        return this.usePlugins(buildEncoder, pluginConfig);
    }
    /**
     * Use a chain of audio plugins - chainable.
     * The `buildEncoder` callback is used for final configuration just before running.
     * @param buildEncoder - Receives encoder instance for final setup.
     * @param pluginConfigs - One or more plugin configs to apply in order.
     * @throws if no plugin configs are passed.
     * @returns this
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
        return this;
    }
    /**
     * Replace the current audio plugin chain at runtime.
     * Safe hot-swap.
     * @param pluginConfigs - Plugin configs to apply.
     * @throws if called before `.usePlugins()`
     */
    async updatePlugins(...pluginConfigs) {
        if (!this.pluginHotSwap) {
            throw new Error("Plugins can only be updated after .usePlugins() has been called.");
        }
        if (pluginConfigs.length === 0)
            throw new Error("updatePlugins requires at least one plugin.");
        const newChainInstance = FluentStream.globalRegistry.chain(...pluginConfigs);
        const newTransform = newChainInstance.getTransform();
        await this.pluginHotSwap.swap(newTransform);
        this.pluginControllers = newChainInstance.getControllers();
    }
    /**
     * Retrieve a plugin controller instance by its name, if present.
     * @param name - The registered plugin name.
     * @returns The AudioPlugin instance for the given name, or undefined.
     */
    getPlugin(name) {
        return this.pluginControllers.find((ctrl) => !!ctrl &&
            typeof ctrl === "object" &&
            typeof ctrl.name === "string" &&
            ctrl.name === name);
    }
    /**
     * List all currently active plugins, returning their { name, options? }.
     * Does NOT expose controller internals.
     * @returns Array of { name, options? }
     */
    getPlugins() {
        return this.pluginControllers
            .filter((ctrl) => !!ctrl &&
            typeof ctrl === "object" &&
            typeof ctrl.name === "string")
            .map((ctrl) => {
            const name = ctrl.name;
            if ("options" in ctrl && ctrl.options !== undefined) {
                // Defensive copy to avoid leaks/mutation
                return { name, options: { ...ctrl.options } };
            }
            else {
                return { name };
            }
        });
    }
    /**
     * Get current plugin state for a specific plugin, or for all plugins if name omitted.
     * If a plugin exposes .getState(), returns result; else returns undefined.
     *
     * @param name - Optional plugin name. If present, returns only that plugin's state.
     * @returns State object of the named plugin, or map of all plugin states if name omitted.
     */
    getPluginState(name) {
        if (typeof name === "string") {
            const ctrl = this.getPlugin(name);
            if (ctrl && typeof ctrl.getState === "function") {
                try {
                    return ctrl.getState();
                }
                catch {
                    return undefined;
                }
            }
            return undefined;
        }
        else {
            const state = {};
            for (const ctrl of this.pluginControllers) {
                if (ctrl &&
                    typeof ctrl === "object" &&
                    typeof ctrl.name === "string" &&
                    typeof ctrl.getState === "function") {
                    const pluginName = String(ctrl.name);
                    try {
                        state[pluginName] = ctrl.getState();
                    }
                    catch {
                        state[pluginName] = undefined;
                    }
                }
            }
            return state;
        }
    }
    /**
     * Access the array of plugin controller instances (internal representation).
     * For advanced usage only.
     */
    getPluginControllers() {
        return this.pluginControllers;
    }
    /**
     * Get a snapshot (copy) of the current FFmpeg argument array.
     */
    getArgs() {
        return [...this.args];
    }
    /**
     * Assembles final set of FFmpeg arguments considering added filters, global options, etc.
     */
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
        // Add flags to make network/pipe:0 inputs lower-latency (useful for streaming scenarios)
        const needsLowDelay = finalArgs.some((_val, i, arr) => arr[i] === "-i" &&
            typeof arr[i + 1] === "string" &&
            (arr[i + 1].startsWith("http://") ||
                arr[i + 1].startsWith("https://") ||
                arr[i + 1] === "pipe:0"));
        if (needsLowDelay) {
            const lowDelayFlags = [
                "-fflags",
                "nobuffer",
                "-flags",
                "low_delay",
                "-probesize",
                "32",
                "-analyzeduration",
                "0",
            ];
            for (let i = 0; i < finalArgs.length;) {
                if ((finalArgs[i] === "-fflags" && finalArgs[i + 1] === "nobuffer") ||
                    (finalArgs[i] === "-flags" && finalArgs[i + 1] === "low_delay") ||
                    (finalArgs[i] === "-probesize" && finalArgs[i + 1] === "32") ||
                    (finalArgs[i] === "-analyzeduration" && finalArgs[i + 1] === "0")) {
                    finalArgs.splice(i, 2);
                }
                else
                    i++;
            }
            finalArgs.unshift(...lowDelayFlags);
        }
        return finalArgs;
    }
    /**
     * Get headers merged with HUMANITY_HEADER defaults.
     * @private
     */
    getMergedHeaders() {
        if (this._headers === undefined) {
            return { ...FluentStream.HUMANITY_HEADER };
        }
        if (typeof this._headers === "object" &&
            Object.keys(this._headers).length > 0) {
            return { ...this._headers };
        }
        return {};
    }
    /**
     * Merge supplied options with headers from getMergedHeaders.
     * @private
     */
    addHumanityHeadersToProcessorOptions(options) {
        const mergedHeaders = this.getMergedHeaders();
        return { ...options, headers: mergedHeaders };
    }
    /**
     * Build a Processor instance, optionally overriding arguments and input streams.
     * @private
     */
    createProcessor(extraOpts = {}, args, inputStreams) {
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
    /**
     * Run the FFmpeg process, building up plugins/filter args and options as needed.
     * Returns an object with the process and control helpers.
     *
     * @returns {FFmpegRunResult}
     */
    run() {
        // Compose plugin and user filter_complex filters.
        if (this.encoderBuilder && this.pluginControllers.length > 0) {
            const pluginFilters = [];
            for (const plugin of this.pluginControllers) {
                if (typeof plugin.getFilter === "function") {
                    const f = plugin.getFilter();
                    if (f)
                        pluginFilters.push(String(f));
                }
            }
            let filterComplex = pluginFilters.join(",");
            const userComplexFilters = this.complexFilters.length
                ? this.complexFilters.join(";")
                : "";
            if (filterComplex && userComplexFilters) {
                filterComplex = `${filterComplex},${userComplexFilters}`;
            }
            else if (!filterComplex && userComplexFilters) {
                filterComplex = userComplexFilters;
            }
            if (filterComplex && !this.args.includes("-filter_complex")) {
                this.args.push("-filter_complex", filterComplex);
            }
        }
        const proc = this.createProcessor();
        return proc.run();
    }
    // ------- Utility Methods -------
    /**
     * Allow file overwrite (`-y`).
     */
    overwrite() {
        this.args = this.args.filter((arg) => arg !== "-y");
        this.args.unshift("-y");
        return this;
    }
    /**
     * Add a custom `-map` spec (for selecting streams).
     * @param mapSpec - FFmpeg stream map string.
     */
    map(mapSpec) {
        this.args.push("-map", mapSpec);
        return this;
    }
    /**
     * Seek input (using `-ss`) before first `-i`.
     * @param position - Time to seek to.
     */
    seekInput(position) {
        const firstInputIdx = this.args.findIndex((arg) => arg === "-i");
        if (firstInputIdx === -1) {
            this.args.unshift("-ss", String(position));
        }
        else {
            this.args.splice(firstInputIdx, 0, "-ss", String(position));
        }
        return this;
    }
    /**
     * Get current audio transform pipeline (as a Transform).
     * Only available after usePlugins().
     * @throws if not called after usePlugins().
     */
    getAudioTransform() {
        if (!this.audioTransform) {
            throw new Error("getAudioTransform() called before usePlugins() - no audio transform pipeline exists.");
        }
        return this.audioTransform;
    }
    /**
     * Alias for getPluginControllers().
     */
    getControllers() {
        return this.pluginControllers;
    }
}
exports.default = FluentStream;
//# sourceMappingURL=FluentStream.js.map