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
     * @param options - default configuration for created Processor
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
     * Insert global options (appear before any inputs), e.g. "-hide_banner".
     * @param {...string} opts - one or more global arguments for ffmpeg.
     * @returns {FluentStream}
     * @example
     * ff.globalOptions('-hide_banner');
     */
    globalOptions(...opts) {
        this.args.unshift(...opts);
        return this;
    }
    /**
     * Insert options that must precede the last input (e.g. "-f lavfi").
     * @param {...string} opts
     * @returns {FluentStream}
     * @example
     * ff.inputOptions('-f', 'lavfi');
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
     * Add an input source (filepath or stream). Streams are piped via stdin.
     * @param {string|Readable} input - file path or readable stream
     * @returns {FluentStream}
     * @example
     * ff.input('input.mp3')
     *   .input(someStream);
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
     * Add a named pipe (FIFO) as an input. FIFO is created at run() if missing.
     *
     * @param {string} fifoPath
     * @returns {FluentStream}
     * @example
     * ff.inputFifo('/tmp/somefifo');
     */
    inputFifo(fifoPath) {
        this.pendingFifos.push(fifoPath);
        this.args.push("-i", fifoPath);
        return this;
    }
    /**
     * Prepare a FIFO path and register it as the next input automatically.
     * @param {object} [options] - options for FIFO creation
     * @param {string} [options.dir] - directory to create FIFO in
     * @param {string} [options.prefix] - prefix for FIFO filename
     * @returns {string} absolute FIFO path
     * @example
     * const fifoPath = ff.prepareNextTrackFifo();
     * // Write to fifoPath asynchronously.
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
     * Specify output target (file path, or ffmpeg stream target string).
     * @param {string} output
     * @returns {FluentStream}
     * @example
     * ff.output('output.mp3')
     */
    output(output) {
        this.args.push(output);
        return this;
    }
    /**
     * Add output options (appended before output).
     * @param {...string} opts
     * @returns {FluentStream}
     * @example
     * ff.outputOptions('-b:a', '128k');
     */
    outputOptions(...opts) {
        this.args.push(...opts);
        return this;
    }
    /**
     * Set video codec.
     * @param {string} codec
     * @returns {FluentStream}
     * @example
     * ff.videoCodec('libx264');
     */
    videoCodec(codec) {
        this.args.push("-c:v", codec);
        return this;
    }
    /**
     * Set audio codec.
     * @param {string} codec
     * @returns {FluentStream}
     * @example
     * ff.audioCodec('aac');
     */
    audioCodec(codec) {
        this.args.push("-c:a", codec);
        return this;
    }
    /**
     * Set video bitrate.
     * @param {string} bitrate
     * @returns {FluentStream}
     * @example
     * ff.videoBitrate('1M');
     */
    videoBitrate(bitrate) {
        this.args.push("-b:v", bitrate);
        return this;
    }
    /**
     * Set audio bitrate.
     * @param {string} bitrate
     * @returns {FluentStream}
     * @example
     * ff.audioBitrate('128k');
     */
    audioBitrate(bitrate) {
        this.args.push("-b:a", bitrate);
        return this;
    }
    /**
     * Set output video size.
     * @param {string} size
     * @returns {FluentStream}
     * @example
     * ff.size('640x480');
     */
    size(size) {
        this.args.push("-s", size);
        return this;
    }
    /**
     * Set output frames per second.
     * @param {number} fps
     * @returns {FluentStream}
     * @example
     * ff.fps(24);
     */
    fps(fps) {
        this.args.push("-r", fps.toString());
        return this;
    }
    /**
     * Limit duration.
     * @param {string|number} duration - seconds or ffmpeg time string
     * @returns {FluentStream}
     * @example
     * ff.duration(10);
     */
    duration(duration) {
        this.args.push("-t", duration.toString());
        return this;
    }
    /**
     * Seek input.
     * @param {string|number} time - seconds or ffmpeg time string
     * @returns {FluentStream}
     * @example
     * ff.seek(2.5);
     */
    seek(time) {
        this.args.push("-ss", time.toString());
        return this;
    }
    /**
     * Set container/output format.
     * @param {string} format - e.g. 'mp3'
     * @returns {FluentStream}
     * @example
     * ff.format('wav');
     */
    format(format) {
        this.args.push("-f", format);
        return this;
    }
    /**
     * Force overwrite output.
     * @returns {FluentStream}
     * @example
     * ff.overwrite();
     */
    overwrite() {
        this.args.push("-y");
        return this;
    }
    /**
     * Forbid overwrite output.
     * @returns {FluentStream}
     * @example
     * ff.noOverwrite();
     */
    noOverwrite() {
        this.args.push("-n");
        return this;
    }
    /**
     * Add a custom complex filter string.
     * @param {string} filterGraph
     * @returns {FluentStream}
     * @example
     * ff.complexFilter('[0:a][1:a]acrossfade=d=5:c1=tri:c2=tri[aout]');
     */
    complexFilter(filterGraph) {
        this.args.push("-filter_complex", filterGraph);
        return this;
    }
    /**
     * Map a specific stream label to output (e.g., '[aout]' or '[vout]').
     * @param {string} label
     * @returns {FluentStream}
     * @example
     * ff.map('[aout]');
     */
    map(label) {
        this.args.push("-map", label);
        return this;
    }
    /**
     * Audio crossfade helper using FFmpeg acrossfade filter.
     * Crossfades audio from inputA to inputB for duration seconds.
     * Note: requires at least two inputs. By default uses [0:a] and [1:a].
     *
     * @param {number} durationSeconds
     * @param {object} [options]
     * @param {number} [options.inputA] - Index of first input (default: 0)
     * @param {number} [options.inputB] - Index of second input (default: 1)
     * @param {string} [options.curve1] - Fade curve type for inputA (default: "tri")
     * @param {string} [options.curve2] - Fade curve type for inputB (default: "tri")
     * @returns {FluentStream}
     * @example
     * ff.crossfadeAudio(4);
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
     * Enable JS audio processing between decode and encode stages.
     * You provide a Transform (e.g., your AudioProcessor) and a builder to configure the encoder stage.
     * The decoder stage is generated automatically to produce PCM s16le at the given rate/channels.
     *
     * @param {Transform} transform - Node.js Transform stream
     * @param {(enc:FluentStream)=>void} buildEncoder - function to configure output/encoding
     * @param {object} [opts]
     * @param {number} [opts.sampleRate=48000]
     * @param {number} [opts.channels=2]
     * @returns {FluentStream}
     * @example
     * // Pipe decoded PCM through custom processor:
     * ff.withAudioTransform(myAudioTransform, enc => enc.audioCodec('aac').output('file.aac'));
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
     * Plug-in style audio processing.
     * The plugin returns a Transform; we wire it as withAudioTransform.
     * @param {AudioPlugin} plugin
     * @param {(enc:FluentStream)=>void} buildEncoder
     * @param {AudioPluginOptions} [opts]
     * @returns {FluentStream}
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
     * Execute using the low-level Processor. Subscribes to Processor events
     * and re-emits them from the wrapper instance.
     *
     * @param {object} [opts]
     * @param {boolean} [opts.ffplay] - pipe output to ffplay for previewing
     * @returns {FFmpegRunResult}
     * @example
     * const { output, done } = ff.run();
     */
    run(opts = {}) {
        // Ensure any declared FIFOs exist synchronously before spawning ffmpeg
        for (const fifoPath of this.pendingFifos) {
            this.ensureFifoSync(fifoPath);
        }
        // Получаем опции для ffplay: либо из opts, либо из this.options as fallback
        const useFfplay = opts.ffplay !== undefined
            ? opts.ffplay
            : this.options.useFfplay !== undefined
                ? this.options.useFfplay
                : false;
        // If plugin is provided, construct transform from plugin
        if (this.audioPluginConfig && !this.audioTransformConfig) {
            const t = this.audioPluginConfig.plugin.createTransform(this.audioPluginConfig.options);
            const { sampleRate, channels } = this.audioPluginConfig.options;
            return this.withAudioTransform(t, this.audioPluginConfig.buildEncoder, {
                sampleRate,
                channels,
            }).run(opts);
        }
        // If JS audio transform is enabled, run decode -> transform -> encode chain
        if (this.audioTransformConfig) {
            const { transform, sampleRate, channels, buildEncoder } = this.audioTransformConfig;
            // Build decoder args (inputs -> PCM s16le pipe)
            const decoder = new Processor_js_1.default({
                ffmpegPath: this.options.ffmpegPath,
                failFast: this.options.failFast,
                extraGlobalArgs: this.options.extraGlobalArgs,
                enableProgressTracking: this.options.enableProgressTracking,
                logger: this.options.logger,
            });
            const decoderArgs = [];
            // inputs from files/fifos
            for (const f of this.inputFiles)
                decoderArgs.push("-i", f);
            for (const f of this.pendingFifos)
                decoderArgs.push("-i", f);
            // support single stream input
            if (this.inputStreams.length > 0)
                decoderArgs.push("-i", "pipe:0");
            // decode to PCM s16le
            decoderArgs.push("-vn", "-ac", String(channels), "-ar", String(sampleRate), "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1");
            if (this.inputStreams.length > 0)
                decoder.setInputStreams([this.inputStreams[0]]);
            decoder.setArgs(decoderArgs);
            const { output: decodedPcm, done: decodeDone } = decoder.run();
            // Build encoder args via provided builder
            const encoderBuilder = new FluentStream({
                ffmpegPath: this.options.ffmpegPath,
                failFast: this.options.failFast,
                extraGlobalArgs: this.options.extraGlobalArgs,
                enableProgressTracking: this.options.enableProgressTracking,
                logger: this.options.logger,
            });
            buildEncoder(encoderBuilder);
            const encoderArgsTail = encoderBuilder.getArgs();
            const encoder = new Processor_js_1.default({
                ffmpegPath: this.options.ffmpegPath,
                failFast: this.options.failFast,
                extraGlobalArgs: this.options.extraGlobalArgs,
                enableProgressTracking: this.options.enableProgressTracking,
                logger: this.options.logger,
            });
            // input is PCM from transform
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
            // Wire: decoder -> transform -> encoder
            decodedPcm.pipe(transform);
            // Bubble events
            decoder.on("start", (cmd) => this.emit("start", cmd));
            decoder.on("spawn", (d) => this.emit("spawn", d));
            decoder.on("progress", (p) => this.emit("progress", p));
            decoder.on("error", (e) => this.emit("error", e));
            decoder.on("terminated", (s) => this.emit("terminated", s));
            const { output, done } = encoder.run();
            encoder.on("start", (cmd) => this.emit("start", cmd));
            encoder.on("spawn", (d) => this.emit("spawn", d));
            encoder.on("progress", (p) => this.emit("progress", p));
            encoder.on("error", (e) => this.emit("error", e));
            encoder.on("terminated", (s) => this.emit("terminated", s));
            // Ensure decoder completion propagates if encoder finishes first
            decodeDone.catch((e) => this.emit("error", e));
            // Если установлен useFfplay, подаем вывод в ffplay
            if (useFfplay) {
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
                // done resolves when encoder done + ffplay exited
                const ffplayDonePromise = new Promise((resolve, reject) => {
                    ffplay.on("exit", (code) => {
                        if (code === 0)
                            resolve();
                        else
                            reject(new Error(`ffplay exited with code ${code}`));
                    });
                    ffplay.on("error", (err) => reject(err));
                });
                return {
                    output,
                    done: Promise.all([done, ffplayDonePromise]).then(() => { }),
                };
            }
            return { output, done };
        }
        const processor = new Processor_js_1.default({
            ffmpegPath: this.options.ffmpegPath,
            failFast: this.options.failFast,
            extraGlobalArgs: this.options.extraGlobalArgs,
            enableProgressTracking: this.options.enableProgressTracking,
            logger: this.options.logger,
        });
        // Bubble up events
        processor.on("spawn", (data) => this.emit("spawn", data));
        processor.on("start", (cmd) => this.emit("start", cmd));
        processor.on("progress", (p) => this.emit("progress", p));
        processor.on("end", () => this.emit("end"));
        processor.on("terminated", (s) => this.emit("terminated", s));
        processor.on("error", (e) => this.emit("error", e));
        processor.setArgs(this.args);
        if (this.inputStreams.length > 0)
            processor.setInputStreams(this.inputStreams);
        return processor.run();
    }
    // ================= Utilities =================
    /**
     * Get a copy of the constructed ffmpeg argument list.
     * @returns {string[]}
     * @example
     * const args = ff.getArgs();
     */
    getArgs() {
        return [...this.args];
    }
    /**
     * Get full ffmpeg command string preview (not guaranteed to be shell-escaped).
     * @returns {string}
     * @example
     * ff.toString() // 'ffmpeg ...'
     */
    toString() {
        return `${this.options.ffmpegPath} ${this.args.join(" ")}`;
    }
    /**
     * Get current input streams.
     * @returns {Array<{stream:Readable, index:number}>}
     */
    getInputStreams() {
        return this.inputStreams;
    }
    /**
     * Synchronously ensure FIFO exists at filePath (creates it if missing).
     * Throws on error.
     * @private
     * @param {string} filePath
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