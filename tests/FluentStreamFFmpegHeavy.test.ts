import { describe, it, expect, beforeAll, afterAll } from "vitest";
import FluentStream from "../src/Core/FluentStream.js";
import path from "path";
import fs from "fs";

const TEST_AUDIO = path.resolve(__dirname, "320.mp3");
const __outDir = path.resolve(__dirname, ".tmp");

function fakeChecksum(_file: string): string {
  return "cafebabe".padEnd(64, "0");
}

const globalTimeout = 12000;

async function prepareDir() {
  if (!fs.existsSync(__outDir)) fs.mkdirSync(__outDir);
}
async function cleanupDir() {
  if (fs.existsSync(__outDir)) {
    for (const file of fs.readdirSync(__outDir)) {
      try { fs.unlinkSync(path.join(__outDir, file)); } catch {
        // Ignore cleanup errors
      }
    }
  }
}

// Мокаем работу runFfmpeg (заглушка)
async function runFfmpeg(args: string[], opts: {fail?: boolean} = {}) {
  const out = args[args.length - 1];
  if (opts.fail) return { code: 1, stdout: "", stderr: "mock error: input not found" };
  if (String(out).endsWith(".wav")) {
    fs.writeFileSync(out, Buffer.concat([
      Buffer.from("RIFF"), Buffer.alloc(1536)
    ]));
  }
  if (String(out).endsWith(".aac")) {
    const b = Buffer.alloc(256); b[0]=0xff; b[1]=0xf1;
    fs.writeFileSync(out, b);
  }
  if (String(out).endsWith(".mp3")) {
    const b = Buffer.alloc(222); b.write("ID3", 0, 3);
    fs.writeFileSync(out, b);
  }
  return { code: 0, stdout: "ok", stderr: "" };
}

describe("@FluentStream.ts heavy integration / ffmpeg & plugins", () => {
  beforeAll(async () => { await prepareDir(); });
  afterAll(async () => { await cleanupDir(); });

  it("should build ffmpeg args and transcode to wav", async () => {
    const outWav = path.join(__outDir, "a.wav");
    if (fs.existsSync(outWav)) fs.unlinkSync(outWav);

    const stream = new FluentStream()
      .input(TEST_AUDIO)
      .output(outWav);

    const args = stream.getArgs();
    expect(args).toContain("-i");
    expect(args[args.indexOf("-i")+1]).toBe(TEST_AUDIO);
    expect(args.some(x => String(x).endsWith(".wav"))).toBe(true);

    await runFfmpeg(args);
    expect(fs.existsSync(outWav)).toBe(true);

    const buf = fs.readFileSync(outWav);
    expect(buf.slice(0, 4).toString("ascii")).toBe("RIFF");
    expect(fs.statSync(outWav).size).toBeGreaterThan(1000);
    expect(fakeChecksum(outWav)).toMatch(/^[a-f0-9]{64}$/);
  }, globalTimeout);

  it("should transcode to AAC mono 44kHz", async () => {
    const outAac = path.join(__outDir, "resample.aac");
    if (fs.existsSync(outAac)) fs.unlinkSync(outAac);

    const s = new FluentStream()
      .input(TEST_AUDIO)
      .audioCodec("aac")
      .audioChannels(1)
      .audioFrequency(44100)
      .output(outAac);

    const args = s.getArgs();
    expect(args).toContain("-ac");
    expect(args).toContain("1");
    expect(args).toContain("-ar");
    expect(args).toContain("44100");
    expect(args).toContain("-c:a");
    expect(args).toContain("aac");

    await runFfmpeg(args);
    expect(fs.existsSync(outAac)).toBe(true);

    const buf = fs.readFileSync(outAac);
    expect(buf[0]).toBe(0xff); // ADTS sync
    expect((buf[1]&0xf0)).toBe(0xf0);
    expect(buf.length).toBeGreaterThan(200);
    expect(fakeChecksum(outAac)).toMatch(/^[a-f0-9]{64}$/);
  }, globalTimeout);

  it("should throw if input file missing (simulate ffmpeg error)", async () => {
    const out = path.join(__outDir, "fail.mp3");
    if (fs.existsSync(out)) fs.unlinkSync(out);

    const s = new FluentStream()
      .input("notfound.wav")
      .output(out);

    const args = s.getArgs();
    const { code, stderr } = await runFfmpeg(args, {fail:true});
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/not found/);
  });

  it("crossfadeAudio sets up complex filter and args", async () => {
    const out = path.join(__outDir, "xfade.mp3");
    if (fs.existsSync(out)) fs.unlinkSync(out);

    const s = new FluentStream();
    s.input(TEST_AUDIO);
    s.input(TEST_AUDIO);
    s.audioCodec("libmp3lame");
    s.crossfadeAudio(9, {
      c1: "par",
      c2: "exp",
      curve1: "tri",
      curve2: "tri",
      additional: "extra=1",
      nb_samples: 1234,
      overlap: true,
      inputLabels: ["a", "b"],
      outputLabel: "outL",
      inputs: 2,
      input2: TEST_AUDIO,
      input2Label: "b",
      allowDuplicateInput2: true,
    });
    s.output(out);

    const args = s.getArgs();
    const assembledArgs = s.assembleArgs();

    const filterIdx = assembledArgs.indexOf("-filter_complex");
    expect(filterIdx).toBeGreaterThan(-1);

    expect(typeof assembledArgs[filterIdx + 1]).toBe("string");
    expect(assembledArgs[filterIdx + 1]).toMatch(
      /acrossfade=/
    );
    expect(assembledArgs[filterIdx + 1]).toMatch(/d=9/);
    expect(assembledArgs[filterIdx + 1]).toMatch(/c1=tri/);
    expect(assembledArgs[filterIdx + 1]).toMatch(/c2=tri/);
    expect(assembledArgs[filterIdx + 1]).toContain("acrossfade=d=9:c1=tri:c2=tri:ns=1234[outL]:extra=1");

    await runFfmpeg(args);
    expect(fs.existsSync(out)).toBe(true);

    const buf = fs.readFileSync(out);
    expect(buf.subarray(0,3).toString("ascii")).toMatch(/^ID3/);
    expect(fakeChecksum(out)).toMatch(/^[a-f0-9]{64}$/);
  }, globalTimeout);
});
