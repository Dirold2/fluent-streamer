import { describe, it, expect, beforeEach } from "vitest";
import FluentStream from "../src/Core/FluentStream.js";
import fs from "fs";
import path from "path";

const TEST_AUDIO = path.resolve(__dirname, "320.mp3");
const __outDir = path.resolve(__dirname, ".tmp");

describe("FluentStream Unit Tests", () => {
  let stream: FluentStream;

  beforeEach(() => {
    stream = new FluentStream();
  });

  describe("Basic API Methods", () => {
    it("input() adds input file to args", () => {
      stream.input("test.mp3");
      const args = stream.getArgs();
      expect(args).toContain("-i");
      expect(args).toContain("test.mp3");
    });

    it("output() adds output file to args", () => {
      // Use __outDir for output path
      const outFile = path.join(__outDir, "output.wav");
      stream.output(outFile);
      const args = stream.getArgs();
      expect(args).toContain(outFile);
    });

    it("format() correctly adds/removes -f", () => {
      stream.input(TEST_AUDIO).format("ogg");
      expect(stream.getArgs()).toContain("-f");
      expect(stream.getArgs()).toContain("ogg");
      
      stream.format("mp3");
      const args = stream.getArgs();
      expect(args).not.toContain("ogg");
      expect(args).toContain("mp3");
    });

    it("audioBitrate sets audio bitrate", () => {
      stream.audioBitrate("192k");
      expect(stream.getArgs()).toContain("-b:a");
      expect(stream.getArgs()).toContain("192k");
    });

    it("audioCodec sets audio codec", () => {
      stream.audioCodec("aac");
      expect(stream.getArgs()).toContain("-c:a");
      expect(stream.getArgs()).toContain("aac");
    });

    it("audioChannels sets channel count", () => {
      stream.audioChannels(2);
      expect(stream.getArgs()).toContain("-ac");
      expect(stream.getArgs()).toContain("2");
    });

    it("audioFrequency sets sample rate", () => {
      stream.audioFrequency(44100);
      expect(stream.getArgs()).toContain("-ar");
      expect(stream.getArgs()).toContain("44100");
    });

    it("copyCodecs() idempotently adds -c copy", () => {
      stream.copyCodecs();
      expect(stream.getArgs()).toContain("-c");
      expect(stream.getArgs()).toContain("copy");
      
      stream.copyCodecs();
      const args = stream.getArgs().filter(a => a === "copy");
      expect(args.length).toBe(1);
    });

    it("overwrite() enables -y flag", () => {
      stream.overwrite();
      expect(stream.getArgs()).toContain("-y");
    });

    it("globalOptions() adds global options", () => {
      stream.globalOptions("-y", "-v", "quiet");
      const args = stream.getArgs();
      expect(args).toContain("-y");
      expect(args).toContain("-v");
      expect(args).toContain("quiet");
    });

    it("map() adds -map option", () => {
      stream.map("0:a:1");
      const args = stream.getArgs();
      expect(args).toContain("-map");
      expect(args).toContain("0:a:1");
    });

    it("seekInput() puts -ss before -i", () => {
      stream.input("foo.mp3").seekInput(5);
      const args = stream.getArgs();
      const ssIdx = args.indexOf("-ss");
      const iIdx = args.indexOf("-i");
      expect(ssIdx).toBeLessThan(iIdx);
      expect(args[ssIdx + 1]).toBe("5");
    });
  });

  describe("Complex Filters", () => {
    it("complexFilter() appends filter strings array", () => {
      stream.complexFilter(["[0:a]loudnorm[a1]", "[a1]apad"]);
      // Check the filter chain is present by obtaining summary (which reflects processor state)
      const summary = stream.getInputSummary();
      expect(summary.complexFilters).toContain("[0:a]loudnorm[a1]");
      expect(summary.complexFilters).toContain("[a1]apad");
    });

    it("complexFilter() ignores empty filter strings", () => {
      stream.complexFilter("");
      stream.complexFilter(["", "apad"]);
      const summary = stream.getInputSummary();
      expect(summary.complexFilters).toContain("apad");
      expect(summary.complexFilters.length).toBe(1);
    });

    it("crossfadeAudio works with default options", () => {
      const s = new FluentStream();
      s.input("a.mp3").input("b.mp3").crossfadeAudio(3.5);
      const summary = s.getInputSummary();
      // complexFilters may contain multiple filters, find 'acrossfade'
      const found = summary.complexFilters.find(f =>
        (typeof f === "string" &&
          (f.startsWith("acrossfade=") ||
            f.includes("acrossfade=") || // for possible filtergraph spec
            f.startsWith("acrossfade:") ||
            f.startsWith("acrossfade")))
      );
      expect(found).toBe("acrossfade=d=3.5:c1=tri:c2=tri");
    });

    it("crossfadeAudio works with custom options", () => {
      const s = new FluentStream();
      s.input("a.mp3").input("b.mp3").crossfadeAudio(10, { c1: 'exp', c2: 'log' });
      const summary = s.getInputSummary();
      const found = summary.complexFilters.find(f =>
        (typeof f === "string" &&
          (f.startsWith("acrossfade=") ||
            f.includes("acrossfade=") ||
            f.startsWith("acrossfade:") ||
            f.startsWith("acrossfade")))
      );
      expect(found).toBe("acrossfade=d=10:c1=exp:c2=log");
    });
  });

  describe("Stream Handling", () => {
    it("input() throws on multiple streams", () => {
      const s = new FluentStream();
      s.input(fs.createReadStream(TEST_AUDIO));
      // Must use unique pipeIndex to trigger error in implementation that supports multiple streams via numbered pipes.
      let didThrow = false;
      try {
        s.input(fs.createReadStream(TEST_AUDIO), { pipeIndex: 0 });
      } catch (err: unknown) {
        didThrow = true;
        expect(String(err)).toMatch(/(multiple stream|already has a stream|duplicate pipe index|Multiple stream \(Readable\) inputs are not supported)/i);
      }
      if (!didThrow) {
        throw new Error("Expected input() to throw on multiple stream inputs, but it did not.");
      }
    });

    it("accepts readable stream as input", () => {
      const readStream = fs.createReadStream(TEST_AUDIO);
      stream.input(readStream);
      // The processor now manages streams. To validate, check getInputSummary().pipeStreams
      const summary = stream.getInputSummary();
      expect(summary.pipeStreams.length).toBe(1);
      expect(summary.pipeStreams[0]).toMatch(/^pipe:\d+$/);
    });
  });

  describe("State Management", () => {
    it("clear() resets all state", () => {
      stream.input(TEST_AUDIO).audioCodec("aac").output("foo.aac");
      stream.clear();
      expect(stream.getArgs().length).toBe(0);
      // getInputSummary reflects streams and filters
      const summary = stream.getInputSummary();
      expect(summary.stringInputs.length).toBe(0);
      expect(summary.pipeStreams.length).toBe(0);
      expect(summary.complexFilters.length).toBe(0);
    });

    it("getArgs returns a copy", () => {
      stream.input(TEST_AUDIO).output("foo.ogg");
      const args1 = stream.getArgs();
      args1.push("-x");
      expect(stream.getArgs()).not.toContain("-x");
    });
  });

  describe("Argument Building", () => {
    it("builds correct argument order", () => {
      // Use __outDir for the output file
      const outFile = path.join(__outDir, "output.aac");
      stream
        .seekInput(10)
        .input("input.mp3")
        .audioCodec("aac")
        .audioBitrate("128k")
        .output(outFile)
        .overwrite();

      const args = stream.getArgs();
      
      // Check order: -ss before -i
      const ssIdx = args.indexOf("-ss");
      const iIdx = args.indexOf("-i");
      expect(ssIdx).toBeLessThan(iIdx);
      
      // Check all required args are present
      expect(args).toContain("-ss");
      expect(args).toContain("10");
      expect(args).toContain("-i");
      expect(args).toContain("input.mp3");
      expect(args).toContain("-c:a");
      expect(args).toContain("aac");
      expect(args).toContain("-b:a");
      expect(args).toContain("128k");
      expect(args).toContain(outFile);
      expect(args).toContain("-y");
    });

    it("handles multiple inputs correctly", () => {
      // Use __outDir for the output
      const outFile = path.join(__outDir, "output.mp3");
      stream
        .input("input1.mp3")
        .input("input2.mp3")
        .crossfadeAudio(5)
        .output(outFile);

      const args = stream.getArgs();
      
      // Should have two -i flags
      const iIndices = args.reduce((acc, arg, idx) => {
        if (arg === "-i") acc.push(idx);
        return acc;
      }, [] as number[]);
      
      expect(iIndices).toHaveLength(2);
      expect(args[iIndices[0] + 1]).toBe("input1.mp3");
      expect(args[iIndices[1] + 1]).toBe("input2.mp3");
      expect(args).toContain(outFile);
    });
  });
});
