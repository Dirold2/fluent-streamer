"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = exports.FluentStream = void 0;
const tslib_1 = require("tslib");
/**
 * FluentStream is a fluent, chainable wrapper around the low-level Processor
 * for building FFmpeg command arguments and optionally attaching input streams.
 *
 * Provides a convenient builder API for constructing FFmpeg commands,
 * attaching file or stream inputs, and customizing options including JS audio transforms.
 *
 * @example
 * // Basic usage with file input and output:
 * const ff = new FluentStream({ enableProgressTracking: true })
 *   .input('input.mp4')
 *   .videoCodec('libx264')
 *   .output('output.mp4');
 * const { output, done } = ff.run();
 *
 * @example
 * // With stream input/output and custom filter
 * const ff = new FluentStream()
 *   .input(someReadableStream)
 *   .outputOptions('-preset', 'fast')
 *   .complexFilter('[0:v]scale=320:240[vout]')
 *   .map('[vout]')
 *   .output('pipe:1');
 * const { output, done } = ff.run();
 *
 * @example
 * // Using JS audio transform (node stream as PCM)
 * ff
 *   .input('song.mp3')
 *   .withAudioTransform(myTransform, (enc) => enc.audioCodec('aac').output('song-processed.aac'));
 * ff.run();
 */
const eventemitter3_1 = require("eventemitter3");
const fs_1 = require("fs");
const child_process_1 = require("child_process");
const path_1 = require("path");
const os_1 = tslib_1.__importDefault(require("os"));
const Processor_js_1 = tslib_1.__importDefault(require("./Processor.js"));
/**
 * SimpleFFmpeg provides a convenient, chainable interface for constructing
 * FFmpeg commands. It delegates execution to the low-level Processor.
 *
 * @example
 * const ff = new SimpleFFmpeg({ enableProgressTracking: true })
 *   .input('input.mp4')
 *   .videoCodec('libx264')
 *   .output('pipe:1');
 * const { output, done } = ff.run();
 */
class FluentStream extends eventemitter3_1.EventEmitter {
    args = [];
    inputStreams = [];
    inputFiles = [];
    options;
    pendingFifos = [];
    audioTransformConfig;
    audioPluginConfig;
    /**
     * Create a new FluentStream builder.
     *
     * @param {SimpleFFmpegOptions} [options] - Default configuration for the created Processor.
     *
     * @example
     * const ff = new FluentStream({ enableProgressTracking: true });
     */
    constructor(options = {}) {
        super();
        this.options = {
            ffmpegPath: options.ffmpegPath ?? "ffmpeg",
            failFast: options.failFast ?? false,
            extraGlobalArgs: options.extraGlobalArgs ?? [],
            loggerTag: options.loggerTag ?? `ffmpeg_${Date.now()}`,
            enableProgressTracking: options.enableProgressTracking ?? false,
            logger: options.logger ?? console,
        };
        if (this.options.failFast)
            this.args.push("-xerror");
        if (this.options.extraGlobalArgs?.length)
            this.args.push(...this.options.extraGlobalArgs);
        if (this.options.enableProgressTracking)
            this.args.push("-progress", "pipe:2");
    }
    // ================= Fluent API =================
    /**
     * Adds global ffmpeg options to the arguments.
     * @param {...string} opts - The global options to set (e.g. "-hide_banner").
     * @returns {FluentStream} This instance for chaining.
     */
    globalOptions(...opts) {
        this.args.unshift(...opts);
        return this;
    }
    /**
     * Adds input-specific ffmpeg options.
     * @param {...string} opts - The options to add before the most recent "-i".
     * @returns {FluentStream} This instance for chaining.
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
     * Adds an input (file path or stream) to the ffmpeg command.
     * @param {string|Readable} input - Path or stream to use as input.
     * @returns {FluentStream} This instance for chaining.
     */
    input(input) {
        if (typeof input === "string") {
            this.args.push("-i", input);
            this.inputFiles.push(input);
        }
        else {
            const index = this.inputStreams.length;
            this.inputStreams.push({ stream: input, index });
            this.args.push("-i", "pipe:0");
        }
        return this;
    }
    /**
     * Adds a FIFO (named pipe) as an input.
     * @param {string} fifoPath - Path to the FIFO.
     * @returns {FluentStream} This instance for chaining.
     */
    inputFifo(fifoPath) {
        this.pendingFifos.push(fifoPath);
        this.args.push("-i", fifoPath);
        return this;
    }
    /**
     * Prepares and adds a unique FIFO input for a new track, returning its path.
     * @param {Object} [options]
     * @param {string} [options.dir] - Directory for the FIFO.
     * @param {string} [options.prefix] - Prefix for the FIFO filename.
     * @returns {string} The FIFO path.
     */
    prepareNextTrackFifo(options) {
        const dir = options?.dir ?? os_1.default.tmpdir();
        const prefix = options?.prefix ?? "ffmpeg_fifo";
        const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const path = `${dir}/${prefix}_${unique}.fifo`;
        this.inputFifo(path);
        return path;
    }
    /**
     * Sets the output file or pipe for the ffmpeg command.
     * @param {string} output - Path or ffmpeg output spec (e.g. "pipe:1").
     * @returns {FluentStream} This instance for chaining.
     */
    output(output) {
        this.args.push(output);
        return this;
    }
    /**
     * Adds extra options to the end of ffmpeg command (output side).
     * @param {...string} opts - The options to add after outputs.
     * @returns {FluentStream} This instance for chaining.
     */
    outputOptions(...opts) {
        this.args.push(...opts);
        return this;
    }
    /**
     * Sets the video codec.
     * @param {string} codec - The video codec name.
     * @returns {FluentStream} This instance for chaining.
     */
    videoCodec(codec) {
        this.args.push("-c:v", codec);
        return this;
    }
    /**
     * Sets the audio codec.
     * @param {string} codec - The audio codec name.
     * @returns {FluentStream} This instance for chaining.
     */
    audioCodec(codec) {
        this.args.push("-c:a", codec);
        return this;
    }
    /**
     * Sets the video bitrate.
     * @param {string} bitrate - Video bitrate value (e.g. "1000k").
     * @returns {FluentStream} This instance for chaining.
     */
    videoBitrate(bitrate) {
        this.args.push("-b:v", bitrate);
        return this;
    }
    /**
     * Sets the audio bitrate.
     * @param {string} bitrate - Audio bitrate value (e.g. "192k").
     * @returns {FluentStream} This instance for chaining.
     */
    audioBitrate(bitrate) {
        this.args.push("-b:a", bitrate);
        return this;
    }
    /**
     * Sets the target video size.
     * @param {string} size - The target size, e.g. "640x480".
     * @returns {FluentStream} This instance for chaining.
     */
    size(size) {
        this.args.push("-s", size);
        return this;
    }
    /**
     * Sets the output video fps.
     * @param {number} fps - Frames per second.
     * @returns {FluentStream} This instance for chaining.
     */
    fps(fps) {
        this.args.push("-r", fps.toString());
        return this;
    }
    /**
     * Sets the output duration.
     * @param {string|number} duration - Output duration (seconds or ffmpeg duration string).
     * @returns {FluentStream} This instance for chaining.
     */
    duration(duration) {
        this.args.push("-t", duration.toString());
        return this;
    }
    /**
     * Sets the start time offset for input.
     * @param {string|number} time - Time offset (seconds or ffmpeg timestamp string).
     * @returns {FluentStream} This instance for chaining.
     */
    seek(time) {
        this.args.push("-ss", time.toString());
        return this;
    }
    /**
     * Sets the output format.
     * @param {string} format - Output format, e.g. "mp4" or "mp3".
     * @returns {FluentStream} This instance for chaining.
     */
    format(format) {
        this.args.push("-f", format);
        return this;
    }
    /**
     * Enables overwrite of output files.
     * @returns {FluentStream} This instance for chaining.
     */
    overwrite() {
        this.args.push("-y");
        return this;
    }
    /**
     * Disables overwrite of output files (fail if exists).
     * @returns {FluentStream} This instance for chaining.
     */
    noOverwrite() {
        this.args.push("-n");
        return this;
    }
    /**
     * Sets a complex filter for ffmpeg.
     * @param {string} filterGraph - Filter graph string.
     * @returns {FluentStream} This instance for chaining.
     */
    complexFilter(filterGraph) {
        this.args.push("-filter_complex", filterGraph);
        return this;
    }
    /**
     * Adds a -map argument.
     * @param {string} label - The ffmpeg stream selector.
     * @returns {FluentStream} This instance for chaining.
     */
    map(label) {
        this.args.push("-map", label);
        return this;
    }
    /**
     * Adds an audio crossfade filter between two inputs.
     * @param {number} durationSeconds - Duration of the crossfade in seconds.
     * @param {Object} [options] - Additional crossfade options.
     * @param {number} [options.inputA=0] - Index of the first audio input.
     * @param {number} [options.inputB=1] - Index of the second audio input.
     * @param {string} [options.curve1='tri'] - First curve type.
     * @param {string} [options.curve2='tri'] - Second curve type.
     * @returns {FluentStream} This instance for chaining.
     */
    crossfadeAudio(durationSeconds, options) {
        const inputA = options?.inputA ?? 0;
        const inputB = options?.inputB ?? 1;
        const c1 = options?.curve1 ?? "tri";
        const c2 = options?.curve2 ?? "tri";
        const graph = `[${inputA}:a][${inputB}:a]acrossfade=d=${durationSeconds}:c1=${c1}:c2=${c2}[aout]`;
        this.args.push("-filter_complex", graph, "-map", "[aout]");
        return this;
    }
    /**
     * Attach a JS audio transform (a Transform stream) to process PCM data between decode and encode.
     *
     * @param {Transform} transform - The Node.js Transform stream to apply to decoded PCM audio.
     * @param {function(FluentStream):void} buildEncoder - Callback to configure encoding/output (receives a FluentStream).
     * @param {Object} [opts] - Audio transform options.
     * @param {number} [opts.sampleRate=48000] - Sample rate for PCM.
     * @param {number} [opts.channels=2] - Channel count for PCM.
     * @returns {FluentStream} This instance for chaining.
     */
    withAudioTransform(transform, buildEncoder, opts) {
        this.audioTransformConfig = {
            transform,
            sampleRate: opts?.sampleRate ?? 48000,
            channels: opts?.channels ?? 2,
            buildEncoder,
        };
        return this;
    }
    /**
     * Attaches a custom AudioPlugin as a JS transform, and wires up the encoder step.
     *
     * @param {AudioPlugin} plugin - The plugin object (must implement createTransform).
     * @param {function(FluentStream):void} buildEncoder - Encoder customization callback.
     * @param {AudioPluginOptions} [opts] - Audio options.
     * @returns {FluentStream} This instance for chaining.
     */
    withAudioPlugin(plugin, buildEncoder, opts) {
        this.audioPluginConfig = {
            plugin,
            options: {
                sampleRate: opts?.sampleRate ?? 48000,
                channels: opts?.channels ?? 2,
            },
            buildEncoder,
        };
        return this;
    }
    // ================= Execute via Processor =================
    /**
     * Execute with the underlying Processor. All processor events are re-emitted.
     *
     * @param {Object} [opts] - Optional. If opts.ffplay is true, will attempt to play the output via ffplay.
     * @returns {FFmpegRunResult} The result object containing the output stream, a done promise, and a stop method.
     */
    run(opts = {}) {
        // Ensure any declared FIFOs exist synchronously before spawning ffmpeg
        for (const fifoPath of this.pendingFifos) {
            this.ensureFifoSync(fifoPath);
        }
        // To stop all sub-processes
        const allProcs = [];
        if (this.audioPluginConfig && !this.audioTransformConfig) {
            const t = this.audioPluginConfig.plugin.createTransform(this.audioPluginConfig.options);
            const { sampleRate, channels } = this.audioPluginConfig.options;
            return this.withAudioTransform(t, this.audioPluginConfig.buildEncoder, {
                sampleRate,
                channels,
            }).run(opts);
        }
        if (this.audioTransformConfig) {
            const { transform, sampleRate, channels, buildEncoder } = this.audioTransformConfig;
            const decoder = new Processor_js_1.default({
                ffmpegPath: this.options.ffmpegPath,
                failFast: this.options.failFast,
                extraGlobalArgs: this.options.extraGlobalArgs,
                enableProgressTracking: this.options.enableProgressTracking,
                logger: this.options.logger,
            });
            const decoderArgs = [];
            for (const f of this.inputFiles)
                decoderArgs.push("-i", f);
            for (const f of this.pendingFifos)
                decoderArgs.push("-i", f);
            if (this.inputStreams.length > 0)
                decoderArgs.push("-i", "pipe:0");
            decoderArgs.push("-vn", "-ac", String(channels), "-ar", String(sampleRate), "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1");
            if (this.inputStreams.length > 0)
                decoder.setInputStreams([this.inputStreams[0]]);
            decoder.setArgs(decoderArgs);
            const { output: decodedPcm, done: decodeDone, stop: stopDecoder } = decoder.run();
            // ENCODER builder. DO NOT COPY inputStreams from main (avoids duplicate -i pipe:0)
            const encoderBuilder = new FluentStream({
                ffmpegPath: this.options.ffmpegPath,
                failFast: this.options.failFast,
                extraGlobalArgs: this.options.extraGlobalArgs,
                enableProgressTracking: this.options.enableProgressTracking,
                logger: this.options.logger,
            });
            buildEncoder(encoderBuilder);
            encoderBuilder.inputStreams = [];
            const encoderArgsTail = encoderBuilder.getArgs();
            const encoder = new Processor_js_1.default({
                ffmpegPath: this.options.ffmpegPath,
                failFast: this.options.failFast,
                extraGlobalArgs: this.options.extraGlobalArgs,
                enableProgressTracking: this.options.enableProgressTracking,
                logger: this.options.logger,
            });
            const encoderArgs = [
                "-f",
                "s16le",
                "-ar",
                String(sampleRate),
                "-ac",
                String(channels),
                "-i",
                "pipe:0",
                ...encoderArgsTail,
            ];
            encoder.setArgs(encoderArgs);
            encoder.setInputStreams([
                { stream: transform, index: 0 },
            ]);
            const { output, done, stop: stopEncoder } = encoder.run();
            decodedPcm.pipe(transform);
            allProcs.push({ stop: stopDecoder });
            allProcs.push({ stop: stopEncoder });
            decoder.on("start", (cmd) => this.emit("start", cmd));
            decoder.on("spawn", (d) => this.emit("spawn", d));
            decoder.on("progress", (p) => this.emit("progress", p));
            decoder.on("error", (e) => this.emit("error", e));
            decoder.on("terminated", (s) => this.emit("terminated", s));
            encoder.on("start", (cmd) => this.emit("start", cmd));
            encoder.on("spawn", (d) => this.emit("spawn", d));
            encoder.on("progress", (p) => this.emit("progress", p));
            encoder.on("error", (e) => this.emit("error", e));
            encoder.on("terminated", (s) => this.emit("terminated", s));
            decodeDone.catch((e) => this.emit("error", e));
            if (opts.ffplay) {
                const { spawn } = require("child_process");
                const ffplay = spawn("ffplay", [
                    "-f",
                    "s16le",
                    "-ar",
                    String(sampleRate),
                    "-ac",
                    String(channels),
                    "-nodisp",
                    "-autoexit",
                    "pipe:0",
                ]);
                output.pipe(ffplay.stdin);
                ffplay.stderr.on("data", (data) => this.emit("ffplay-stderr", data.toString()));
                ffplay.on("close", (code, signal) => this.emit("ffplay-close", { code, signal }));
                const ffplayDonePromise = new Promise((resolve, reject) => {
                    ffplay.on("exit", (code) => {
                        if (code === 0)
                            resolve();
                        else
                            reject(new Error(`ffplay exited with code ${code}`));
                    });
                    ffplay.on("error", (err) => reject(err));
                });
                allProcs.push({
                    stop: () => {
                        try {
                            ffplay.kill("SIGINT");
                        }
                        catch { }
                    },
                });
                return {
                    output,
                    done: Promise.all([done, ffplayDonePromise]).then(() => { }),
                    stop: () => { for (const p of allProcs)
                        p.stop(); },
                };
            }
            return {
                output,
                done,
                stop: () => { for (const p of allProcs)
                    p.stop(); },
            };
        }
        const processor = new Processor_js_1.default({
            ffmpegPath: this.options.ffmpegPath,
            failFast: this.options.failFast,
            extraGlobalArgs: this.options.extraGlobalArgs,
            enableProgressTracking: this.options.enableProgressTracking,
            logger: this.options.logger,
        });
        processor.on("spawn", (data) => this.emit("spawn", data));
        processor.on("start", (cmd) => this.emit("start", cmd));
        processor.on("progress", (p) => this.emit("progress", p));
        processor.on("end", () => this.emit("end"));
        processor.on("terminated", (s) => this.emit("terminated", s));
        processor.on("error", (e) => this.emit("error", e));
        processor.setArgs(this.args);
        if (this.inputStreams.length > 0)
            processor.setInputStreams(this.inputStreams);
        const { output, done, stop } = processor.run();
        return {
            output,
            done,
            stop: stop,
        };
    }
    // ================= Utilities =================
    /**
     * Returns a copy of the constructed ffmpeg args array.
     * @returns {string[]} Arguments list.
     */
    getArgs() {
        return [...this.args];
    }
    /**
     * Returns the ffmpeg command as a string for debugging.
     * @returns {string} The ffmpeg command.
     */
    toString() {
        return `${this.options.ffmpegPath} ${this.args.join(" ")}`;
    }
    /**
     * Returns the currently-attached input streams (for pipe).
     * @returns {Array<{stream: Readable, index: number}>} List of input streams.
     */
    getInputStreams() {
        return this.inputStreams;
    }
    /**
     * Synchronously ensures a FIFO exists at the given filePath (creates it if missing).
     * Throws on error.
     * @private
     * @param {string} filePath - Path to FIFO to check and/or create.
     * @throws {Error} If creation fails or the path exists but is not a FIFO.
     */
    ensureFifoSync(filePath) {
        try {
            if ((0, fs_1.existsSync)(filePath)) {
                const stat = (0, fs_1.lstatSync)(filePath);
                if (!stat.isFIFO())
                    throw new Error(`Path exists but is not FIFO: ${filePath}`);
                return;
            }
            (0, fs_1.mkdirSync)((0, path_1.dirname)(filePath), { recursive: true });
            const res = (0, child_process_1.spawnSync)("mkfifo", ["-m", "600", filePath], {
                stdio: "ignore",
            });
            if (res.status !== 0)
                throw new Error(`mkfifo failed for ${filePath}`);
        }
        catch (e) {
            throw new Error(`Failed to ensure FIFO at ${filePath}: ${e.message}`);
        }
    }
}
exports.FluentStream = FluentStream;
exports.default = FluentStream;
//# sourceMappingURL=FluentStream.js.map