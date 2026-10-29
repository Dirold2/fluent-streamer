import { describe, expect, it } from "vitest";
import { buildAtempoPlan } from "../src/Audio/analysis/Atempo.js";

describe("buildAtempoPlan", () => {
  it.each([
    [1, "anull"],
    [1.08, "atempo=1.08"],
    [0.92, "atempo=0.92"],
    [4, "atempo=2,atempo=2"],
    [0.25, "atempo=0.5,atempo=0.5"],
  ])("builds %s as %s", (factor, filter) => {
    expect(buildAtempoPlan(factor).filter).toBe(filter);
  });
  it.each([0, -1, NaN, Infinity])("rejects invalid factor %s", (factor) => {
    expect(() => buildAtempoPlan(factor)).toThrow(RangeError);
  });
});

describe("return to native speed", () => {
  it.each([0.9255181866, 1.08])("returns %s to one after overlap", async (factor) => {
    const { buildReturningAtempo } = await import("../src/Audio/analysis/Atempo.js");
    const filter = buildReturningAtempo(factor, 4, 4);
    expect(filter).toContain("asetpts=N/SR/TB");
    expect(filter).toContain("atempo@automix tempo 1'");
    const commands = filter.match(/([\d.]+) atempo@automix tempo ([\d.]+)/g)!;
    expect(commands).toHaveLength(40);
    expect(Number(commands[0]!.split(" ")[0])).toBeCloseTo(factor * 4.1, 8);
  });
  it("renders real FFmpeg commands and preserves tone pitch", async () => {
    const { spawnSync } = await import("node:child_process");
    const { buildReturningAtempo } = await import("../src/Audio/analysis/Atempo.js");
    const r = spawnSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000:duration=18",
        "-af",
        buildReturningAtempo(0.9255181866, 4.7195135),
        "-f",
        "s16le",
        "pipe:1",
      ],
      { maxBuffer: 4e6, timeout: 15000 },
    );
    expect(r.status, r.stderr?.toString()).toBe(0);
    // 18 seconds plus ~0.50 seconds integrated slowing, not 18/factor (~19.45).
    expect(r.stdout.length / 96000).toBeGreaterThan(18.35);
    expect(r.stdout.length / 96000).toBeLessThan(18.65);
    for (const second of [2, 6, 12]) {
      let crossings = 0;
      for (let i = second * 48000; i < (second + 1) * 48000; i++)
        if (r.stdout.readInt16LE(i * 2) <= 0 && r.stdout.readInt16LE((i + 1) * 2) > 0) crossings++;
      expect(Math.abs(crossings - 440)).toBeLessThan(3);
    }
  });
});
