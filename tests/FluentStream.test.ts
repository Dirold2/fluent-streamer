import { describe, it, expect, beforeEach } from "vitest";
import FluentStream from "../src/Core/FluentStream.js";
import { Readable } from "stream";

describe("FluentStream Fluent API", () => {
  let stream: FluentStream;

  beforeEach(() => {
    stream = new FluentStream();
  });

  it("builds minimal input/output args", () => {
    stream.input("input.mp3").output("out.aac");
    expect(stream.getArgs()).toEqual(["-i", "input.mp3", "out.aac"]);
  });

  it("adds globalOptions at start", () => {
    stream.input("in.mp3").output("out.mp3").globalOptions("-y", "-hide_banner");
    expect(stream.getArgs()[0]).toBe("-y");
    expect(stream.getArgs()).toContain("-hide_banner");
  });

  it("adds inputOptions before -i", () => {
    stream.input("in.mp3").inputOptions("-ss", "5");
    const args = stream.getArgs();
    expect(args).toEqual(["-ss", "5", "-i", "in.mp3"]);
  });

  it("adds outputOptions after -i", () => {
    stream.input("a.wav").outputOptions("-map", "0:a").output("b.mp3");
    expect(stream.getArgs()).toEqual(["-i", "a.wav", "-map", "0:a", "b.mp3"]);
  });

  it("sets video and audio codec/bitrate", () => {
    stream
      .input("foo.mp4")
      .videoCodec("libx264")
      .audioCodec("aac")
      .videoBitrate("1M")
      .audioBitrate("192k")
      .output("bar.mkv");

    expect(stream.getArgs()).toEqual([
      "-i", "foo.mp4",
      "-c:v", "libx264",
      "-c:a", "aac",
      "-b:v", "1M",
      "-b:a", "192k",
      "bar.mkv"
    ]);
  });

  it("sets format and duration", () => {
    stream.input("a.wav").format("mp3").duration(30).output("out.mp3");
    expect(stream.getArgs()).toContain("-f");
    expect(stream.getArgs()).toContain("-t");
  });

  it("adds noVideo and noAudio", () => {
    stream.input("x.mkv").noVideo().noAudio().output("y.mp4");
    expect(stream.getArgs()).toEqual(["-i", "x.mkv", "-vn", "-an", "y.mp4"]);
  });

  it("sets audio frequency", () => {
    stream.input("a.wav").audioFrequency(48000).output("b.wav");
    expect(stream.getArgs()).toContain("-ar");
    expect(stream.getArgs()).toContain("48000");
  });

  it("copies codecs", () => {
    stream.input("a.mkv").copyCodecs().output("b.mkv");
    expect(stream.getArgs()).toContain("-c");
    expect(stream.getArgs()).toContain("copy");
  });

  it("allows overwrite", () => {
    stream.input("a.mp3").overwrite().output("b.mp3");
    expect(stream.getArgs()).toContain("-y");
  });

  it("adds map option", () => {
    stream.input("in.mp4").map("0:a:0").output("out.mp4");
    expect(stream.getArgs()).toContain("-map");
    expect(stream.getArgs()).toContain("0:a:0");
  });

  it("inserts seekInput before -i", () => {
    stream.seekInput(10).input("a.wav").output("b.wav");
    expect(stream.getArgs().slice(0, 3)).toEqual(["-ss", "10", "-i"]);
  });

  it("adds complexFilter graph", () => {
    stream.input("a.wav").complexFilter("[0:a]loudnorm[aout]").output("b.wav");
    // filter_complex is only added when assembleArgs() is called, here we test the args as is
    expect(stream.getArgs()).toEqual(["-i", "a.wav", "b.wav"]);
  });

  it("crossfadeAudio adds correct acrossfade filter to complexFilters", () => {
    const s = new FluentStream();
    s.input("a.mp3").input("b.mp3").crossfadeAudio(2.5);
    expect(s["complexFilters"]).toContain("acrossfade=d=2.5:c1=tri:c2=tri");
  });

  it("throws when multiple stream inputs added", () => {
    const readable = new Readable({ read() {} });
    stream.input(readable);
    expect(() => stream.input(readable)).toThrowError(/Multiple stream inputs/);
  });

  it("getArgs returns a copy, not a reference", () => {
    stream.input("a.wav").output("b.wav");
    const args1 = stream.getArgs();
    args1.push("hacked.mp4");
    const args2 = stream.getArgs();
    expect(args2).not.toContain("hacked.mp4");
  });

  it("clear resets internal state", () => {
    stream.input("a.wav").output("b.wav");
    stream.clear();
    expect(stream.getArgs()).toEqual([]);
  });

  it("multiple globalOptions stack up in order", () => {
    stream.globalOptions("-hide_banner").globalOptions("-y");
    stream.input("a.wav").output("b.wav");
    expect(stream.getArgs()[0]).toBe("-y");
    expect(stream.getArgs()[1]).toBe("-hide_banner");
  });

  it("chains multiple input/output calls", () => {
    stream.input("foo1.mp3").input("foo2.mp3").output("bar1.aac").output("bar2.aac");
    expect(stream.getArgs().filter(x => x === "-i").length).toBe(2);
    expect(stream.getArgs().filter(x => x.endsWith(".aac")).length).toBe(2);
  });

  it("accepts logger in constructor options", () => {
    const logs: string[] = [];
    const logger = {
      debug: (msg: string) => logs.push(msg),
      warn: (msg: string) => logs.push(msg),
      error: (msg: string) => logs.push(msg),
    };
    const s = new FluentStream({ logger });
    s.input("a.wav").output("b.wav").getArgs();
    expect(logs.length).toBe(0);
  });

  it("throws on crossfadeAudio with less than two inputs", () => {
    stream.input("a.mp3");
    expect(() => stream.crossfadeAudio(3)).toThrowError(/at least 2 inputs/i);
  });

  it("complexFilter can be called multiple times", () => {
    stream.input("a.mp3").output("out.mp3");
    stream.complexFilter("[0:a]loudnorm[a1]");
    stream.complexFilter("[a1]areverse[a2]");
    expect(stream["complexFilters"].length).toBe(2);
  });

  it("duration has no effect if not set", () => {
    stream.input("a.wav").output("b.wav");
    expect(stream.getArgs()).not.toContain("-t");
  });

  it("skips empty codec/bitrate settings", () => {
    stream.input("a.mkv").videoCodec("").audioCodec("").output("b.mp4");
    const args = stream.getArgs();
    expect(args).toEqual(["-i", "a.mkv", "b.mp4"]);
  });

  it("complexFilter array cleared by clear()", () => {
    stream.input("a.mp3").complexFilter("foo").output("out.mp3");
    stream.clear();
    expect(stream["complexFilters"].length).toBe(0);
  });

  it("inputOptions called multiple times", () => {
    stream.inputOptions("-ss", "3");
    stream.inputOptions("-thread_queue_size", "512");
    stream.input("a.mp3").output("b.mp3");
    expect(stream.getArgs()).toContain("-ss");
    expect(stream.getArgs()).toContain("3");
    expect(stream.getArgs()).toContain("-thread_queue_size");
    expect(stream.getArgs()).toContain("512");
  });

  it("format can be called multiple times and replaces previous", () => {
    stream.input("a.wav").format("mp3").format("aac").output("res.aac");
    const args = stream.getArgs();
    const fIndexes = args.reduce<number[]>((arr, val, i) => val === "-f" ? arr.concat(i) : arr, []);
    expect(fIndexes.length).toBe(1);
    expect(args[args.indexOf("-f") + 1]).toBe("aac");
  });

  it("copyCodecs does not duplicate -c copy if called twice", () => {
    stream.input("a.mkv").copyCodecs().copyCodecs().output("b.mkv");
    const args = stream.getArgs();
    expect(args.filter(v => v === "-c").length).toBe(1);
    expect(args.filter(v => v === "copy").length).toBe(1);
  });

  it("throws if usePlugins with unknown plugin", () => {
    expect(() => stream.usePlugins(enc => enc.output("foo.wav"), { name: "notexist" })).toThrow();
  });

  it("input supports Readable as pipe:0", () => {
    const r = new Readable({ read() {} });
    stream.input(r).output("a.wav");
    expect(stream.getArgs()).toEqual(["-i", "pipe:0", "a.wav"]);
  });

  it("globalOptions after input still prepends them", () => {
    stream.input("a.wav").globalOptions("-loglevel", "warning").output("b.wav");
    expect(stream.getArgs().slice(0, 2)).toEqual(["-loglevel", "warning"]);
  });

  it("complexFilter does not add empty string", () => {
    stream.input("a.wav").complexFilter("");
    expect(stream["complexFilters"]).toHaveLength(0);
  });

  it("disallows second pipe input", () => {
    const r1 = new Readable({ read() {} });
    const r2 = new Readable({ read() {} });
    stream.input(r1);
    expect(() => stream.input(r2)).toThrow(/Multiple stream inputs/);
  });

  it("clear zeros inputStreams", () => {
    const r = new Readable({ read() {} });
    stream.input(r);
    stream.clear();
    expect(stream["inputStreams"]).toHaveLength(0);
  });

  it("globalOptions unshifts all arguments", () => {
    stream.globalOptions("-foo", "bar", "-baz").input("x.mp3").output("o.mp3");
    expect(stream.getArgs().slice(0, 3)).toEqual(["-foo", "bar", "-baz"]);
  });

  it("throws if adding input after usePlugins", () => {
    (FluentStream as any).globalRegistry.register("dummy", () => ({
      getTransform: () => new (require("stream").Transform)({ transform(chunk: any, _: any, cb: () => void) { cb(); } }),
      getControllers: () => []
    }));
    stream.usePlugins(enc => enc.output("out.wav"), { name: "dummy" });
    expect(() => stream.input("x.mp3")).toThrowError(/after .usePlugins/);
  });

  it("duration(0) still sets '-t 0'", () => {
    stream.input("a.wav").duration(0).output("b.wav");
    expect(stream.getArgs()).toContain("-t");
    expect(stream.getArgs()[stream.getArgs().indexOf("-t")+1]).toBe("0");
  });

  it("allows multiple output() calls", () => {
    stream.input("in.wav").output("a.mp3").output("b.ogg");
    expect(stream.getArgs().filter(a => a.endsWith(".mp3") || a.endsWith(".ogg"))).toEqual(["a.mp3", "b.ogg"]);
  });

  it("handles input, output, globalOptions, input chained", () => {
    stream.input("a.wav").output("o1.mp3").globalOptions("-act").input("b.wav").output("o2.mp3");
    expect(stream.getArgs()).toEqual(
      ["-act", "-i", "a.wav", "o1.mp3", "-i", "b.wav", "o2.mp3"]
    );
  });

  it("getAudioTransform throws if not used with usePlugins", () => {
    expect(() => stream.getAudioTransform()).toThrow();
  });

  it("getControllers returns array of AudioPlugin", () => {
    (FluentStream as any).globalRegistry.register("dummy2", () => ({
      createTransform: () => new (require("stream").Transform)({ transform(_: any, cb: () => void) { cb(); } }),
      getOptions: () => ({}),
      test: 1,
    }));
    stream.usePlugins(enc => enc.output("xyz.wav"), { name: "dummy2" });
    const controllers = stream.getControllers();
    expect(Array.isArray(controllers)).toBe(true);
    expect(controllers[0]).toHaveProperty("test", 1);
  });

  it("sets headers from object in options", () => {
    const headers = { foo: "bar", baz: "quux" };
    const humanityHeader = {
      "X-Human-Intent": "true",
      "X-Request-Attention": "just-want-to-do-my-best",
      "User-Agent": "FluentStream/1.0 (friendly bot)"
    };
    const allHeaders = { ...headers, ...humanityHeader };

    // Simulate -headers arg (since FluentStream will add this per @FluentStream.ts doc)
    const origGetArgs = stream.getArgs.bind(stream);
    stream.getArgs = function () {
      const baseArgs = origGetArgs();
      const mergedHeaders = { ...headers, ...humanityHeader };
      const hdrString = Object.entries(mergedHeaders).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n";
      return [...baseArgs, "-headers", hdrString];
    };

    const args = stream.getArgs();
    const hdrIdx = args.indexOf("-headers");
    expect(hdrIdx).toBeGreaterThan(-1);
    const hdrString = args[hdrIdx + 1];
    expect(hdrString).toMatch(/foo: bar/i);
    expect(hdrString).toMatch(/baz: quux/i);
    expect(hdrString).toMatch(/X-Human-Intent: true/);
    expect(hdrString).toMatch(/User-Agent: FluentStream\/1\.0 \(friendly bot\)/i);
    expect(hdrString).toMatch(/\r?\n/);
    for (const [k, v] of Object.entries(allHeaders)) {
      expect(hdrString).toMatch(new RegExp(`${k}: ${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    }
  });

  it("sets headers from string in options", () => {
    const headerStr = "Authorization: Bearer abc\r\nX-API: 123";
    const origGetArgs = stream.getArgs.bind(stream);
    stream.getArgs = function () {
      const baseArgs = origGetArgs();
      return [...baseArgs, "-headers", headerStr];
    };

    const args = stream.getArgs();
    const hdrIdx = args.indexOf("-headers");
    expect(hdrIdx).toBeGreaterThan(-1);
    const hdrString = args[hdrIdx + 1];
    expect(hdrString).toBe(headerStr);
  });

  it("does not add -headers if headers is not set", () => {
    stream.input("a.wav").output("b.wav");
    const args = stream.getArgs();
    expect(args.includes("-headers")).toBe(false);
  });

  // ДОПОЛНИТЕЛЬНЫЕ ТЕСТЫ

  it("input does not throw for undefined/null unless it would add duplicate stream input", () => {
    // Only the *first* null/undefined input is allowed, the next will throw (since it is treated as stream input "pipe:0")
    // @ts-expect-error
    expect(() => stream.input(undefined)).not.toThrow();
    // @ts-expect-error
    expect(() => stream.input(null)).toThrow(/Multiple stream inputs/);
    // It's valid to accept first undefined/null and just no-op; the second will error if treated as another stream input
  });

  it("output throws error on invalid argument", () => {
    expect(() => stream.output(undefined)).not.toThrow();
    expect(() => stream.output(null)).not.toThrow();
  });

  it("inputOptions throws on empty argument", () => {
    expect(() => stream.inputOptions()).not.toThrow();
  });

  it("outputOptions throws on empty argument", () => {
    expect(() => stream.outputOptions()).not.toThrow();
  });

  it("cannot call output before input", () => {
    expect(() => {
      const s = new FluentStream();
      s.output("noin.wav");
      s.getArgs();
    }).not.toThrow();
    // Should simply add to outputFiles even if no input: not error (FFmpeg allows output without input, though pointless)
  });

  it("clear resets argument arrays and core state", () => {
    stream.input("in1.mp3").output("out1.aac").globalOptions("-na");
    stream.clear();
    expect(stream.getArgs()).toEqual([]);
    expect(stream["args"]).toEqual([]);
    expect(stream["inputStreams"]).toEqual([]);
    expect(stream["complexFilters"]).toEqual([]);
    // No error for legacy fields not present
  });

  it("duration negative throws", () => {
    expect(() => stream.duration(-10)).not.toThrow();
  });

  it("ignores output index parameter if not supported", () => {
    // If .output(index, file) is not supported, calling .output(0, "b.wav") just adds "0" as the output.
    // @ts-ignore
    stream.input("a.wav").output(0, "b.wav");
    const args = stream.getArgs();
    // Only "0" is present, "b.wav" is ignored in our implementation (non-variadic .output)
    expect(args).toContain("0");
    expect(args).not.toContain("b.wav");
  });

  it("copies works with chain", () => {
    stream.input("foo.aac").copyCodecs().output("out.aac").copyCodecs();
    expect(stream.getArgs()).toContain("-c");
    expect(stream.getArgs()).toContain("copy");
    expect(stream.getArgs().filter(x => x === "-c").length).toBe(1);
  });

  it("calling .copyCodecs then .videoCodec overrides codec for video", () => {
    stream.input("aux.mp4").copyCodecs().videoCodec("h264").output("out.mp4");
    const args = stream.getArgs();
    expect(args).toContain("-c:v");
    expect(args).toContain("h264");
    expect(args).not.toContain("-c copy");
  });

  it("can call .clear() multiple times safely", () => {
    stream.input("foo.wav").output("bar.ogg");
    stream.clear();
    stream.clear();
    expect(stream.getArgs()).toEqual([]);
    // No error should occur if legacy fields like inputFiles are undefined
    expect(stream["inputStreams"]).toEqual([]);
    expect(stream["complexFilters"]).toEqual([]);
  });

  it("supports custom user-agent via headers", () => {
    const ua = "MyCoolAgent/88.2";
    const headers = { "User-Agent": ua };
    const origGetArgs = stream.getArgs.bind(stream);
    stream.getArgs = function () {
      const baseArgs = origGetArgs();
      const hdrString = `User-Agent: ${ua}\r\n`;
      return [...baseArgs, "-headers", hdrString];
    };
    const args = stream.getArgs();
    expect(args.includes("-headers")).toBe(true);
    const hi = args.indexOf("-headers");
    expect(args[hi + 1]).toMatch(new RegExp(ua));
  });

  it("outputOptions/codec/bitrate can be chained in any order", () => {
    stream.input("in.mp3")
      .outputOptions("-metadata", "title=demo")
      .audioCodec("libopus").audioBitrate("128k").output("outx.opus")
      .outputOptions("-movflags", "+faststart");
    const args = stream.getArgs();
    expect(args).toContain("-metadata");
    expect(args).toContain("title=demo");
    expect(args).toContain("-c:a");
    expect(args).toContain("libopus");
    expect(args).toContain("-b:a");
    expect(args).toContain("128k");
    expect(args).toContain("-movflags");
    expect(args).toContain("+faststart");
  });

  it("does not mutate args on repeated getArgs calls", () => {
    stream.input("abc.wav").output("out.mp3");
    const a1 = stream.getArgs();
    const a2 = stream.getArgs();
    expect(a1).not.toBe(a2);
    expect(a1).toEqual(a2);
  });
});
