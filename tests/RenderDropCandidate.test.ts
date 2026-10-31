import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
const hasDist = existsSync(new URL("../dist/Audio/analysis/Atempo.js", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "drop-candidate-preview-"));
const outgoing = join(directory, "out.wav");
const incoming = join(directory, "in.wav");
const output = join(directory, "preview.wav");
const script = new URL("../scripts/render-drop-candidate.mjs", import.meta.url).pathname;
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function run(outAnchor = "12", inAnchor = "8") {
  return spawnSync(
    process.execPath,
    [script, outgoing, incoming, outAnchor, inAnchor, "120", "120", output],
    { encoding: "utf8", timeout: 30000 },
  );
}

describe.skipIf(!hasFfmpeg || !hasDist)(
  "offline drop candidate preview (requires npm run build)",
  () => {
    beforeAll(() => {
      for (const [file, frequency] of [
        [outgoing, "440"],
        [incoming, "330"],
      ]) {
        const generated = spawnSync("ffmpeg", [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          `sine=frequency=${frequency}:duration=20`,
          "-ar",
          "48000",
          "-ac",
          "2",
          file,
        ]);
        expect(generated.status).toBe(0);
      }
    });

    it("renders a bounded continuous PCM preview and never overwrites it", () => {
      const rendered = run();
      expect(rendered.status, rendered.stderr).toBe(0);
      expect(existsSync(output)).toBe(true);
      const report = JSON.parse(readFileSync(`${output}.json`, "utf8"));
      expect(report).toMatchObject({
        previewOnly: true,
        outputDurationSeconds: 22,
        outgoingAnchorSeconds: 12,
        incomingAnchorSeconds: 8,
        incomingSourceMsAtEndOfOverlap: 8000,
      });
      expect(report.maxDigitalSilenceMs).toBeLessThan(100);
      expect(report.peak).toBeLessThanOrEqual(0.96);
      expect(run().status).not.toBe(0);
    }, 30000);

    it("renders the manually cued transition through the real mixer, without a PCM gap", () => {
      const target = join(directory, "live.wav");
      const liveScript = new URL("../scripts/render-live-handoff.mjs", import.meta.url).pathname;
      const rendered = spawnSync(
        process.execPath,
        [liveScript, outgoing, incoming, "12", "8", "120", "120", target],
        { encoding: "utf8", timeout: 30000 },
      );
      expect(rendered.status, rendered.stderr).toBe(0);
      const report = JSON.parse(readFileSync(`${target}.json`, "utf8"));
      expect(report).toMatchObject({
        renderer: "FluentStream.prepareAutomix / PlaybackMixer",
        mode: "beat-handoff",
        outputDurationSeconds: 22,
        expectedSourcePositionAtEndMs: 18000,
      });
      expect(report.maxDigitalSilenceMs).toBeLessThan(100);
      expect(report.peak).toBeLessThanOrEqual(0.96);
      expect(Math.abs(report.sourcePositionAtEndMs - 18000)).toBeLessThan(30);
      expect(existsSync(target)).toBe(true);
    }, 30000);

    it("renders the short native-speed seamless handoff without a long overlap", () => {
      const target = join(directory, "seamless.wav");
      const liveScript = new URL("../scripts/render-live-handoff.mjs", import.meta.url).pathname;
      const rendered = spawnSync(
        process.execPath,
        [liveScript, outgoing, incoming, "12", "8", "120", "120", target, "seamless"],
        { encoding: "utf8", timeout: 30000 },
      );
      expect(rendered.status, rendered.stderr).toBe(0);
      const report = JSON.parse(readFileSync(`${target}.json`, "utf8"));
      expect(report).toMatchObject({
        renderer: "FluentStream.prepareAutomix / PlaybackMixer",
        mode: "seamless",
        overlapSeconds: 0.35,
        tempoFactor: 1,
        outputDurationSeconds: 16.35,
        expectedSourcePositionAtEndMs: 18000,
      });
      expect(report.maxDigitalSilenceMs).toBeLessThan(100);
      expect(Math.abs(report.sourcePositionAtEndMs - 18000)).toBeLessThan(30);
    }, 30000);

    it("rejects anchors that do not fit before opening output", () => {
      const invalid = join(directory, "invalid.wav");
      const result = spawnSync(
        process.execPath,
        [script, outgoing, incoming, "4", "8", "120", "120", invalid],
        { encoding: "utf8", timeout: 30000 },
      );
      expect(result.status).not.toBe(0);
      expect(existsSync(invalid)).toBe(false);
    });
  },
);
