#!/usr/bin/env node
// After npm run build: node scripts/render-live-handoff.mjs outgoing.mp3 incoming.mp3 outAnchorSeconds inAnchorSeconds outBpm inBpm output.wav [beat-handoff|seamless]
// Offline experiment using the production FluentStream prepared transition and PCM PlaybackMixer.
// Supplied anchors are manually approved; this does NOT relax automatic DJ confidence gates.
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { FluentStream } from "../dist/index.js";
import { createReturningTempoTimeline } from "../dist/Audio/analysis/Atempo.js";

const [outPath, inPath, outText, inText, outBpmText, inBpmText, output, style = "beat-handoff"] =
  process.argv.slice(2);
if (style !== "beat-handoff" && style !== "seamless")
  throw new RangeError("Unknown transition style");
if (!outPath || !inPath || !outText || !inText || !outBpmText || !inBpmText || !output)
  throw new Error(
    "Expected outgoing incoming outgoingAnchorSeconds incomingAnchorSeconds outgoingBpm incomingBpm output.wav",
  );
if (![outPath, inPath].every(existsSync)) throw new Error("Input file is missing");
if (existsSync(output) || existsSync(`${output}.json`)) throw new Error("Output already exists");
const [outAnchor, inAnchor, outBpm, inBpm] = [outText, inText, outBpmText, inBpmText].map(Number);
const factor = style === "seamless" ? 1 : outBpm / inBpm;
if (
  ![outAnchor, inAnchor, outBpm, inBpm, factor].every(Number.isFinite) ||
  outBpm < 70 ||
  outBpm > 180 ||
  inBpm < 70 ||
  inBpm > 180 ||
  Math.abs(1 - factor) > 0.08
)
  throw new RangeError("Invalid anchors or tempo difference over 8%");
const lead = 6,
  overlap = style === "seamless" ? 0.35 : 6,
  tail = 10,
  rate = 48000,
  frameBytes = 4;
const outStart = outAnchor - lead - overlap;
const cue = inAnchor - overlap * factor;
if (outStart < 0 || cue < 0) throw new RangeError("Not enough lead-in before the anchors");
function duration(file) {
  const result = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      file,
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  if (result.error || result.status !== 0) throw result.error ?? new Error(String(result.stderr));
  const seconds = Number(result.stdout);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("Invalid media duration");
  return seconds;
}
const outDuration = duration(outPath),
  inDuration = duration(inPath);
if (
  outAnchor <= outDuration / 2 ||
  outAnchor > outDuration - 1 ||
  inAnchor >= inDuration / 2 ||
  cue + createReturningTempoTimeline(factor, overlap).toSource(overlap + tail) >= inDuration - 0.1
)
  throw new RangeError("Approved anchors must fit with source tails");

const fluent = new FluentStream({
  enableCrossfade: true,
  autoDrainOutput: false,
  disableThrottling: true,
  useAudioProcessor: true,
})
  .input(outPath)
  .seekInput(outStart)
  .audioCodec("pcm_s16le")
  .outputOptions("-vn", "-f", "s16le", "-ar", String(rate), "-ac", "2", "-af", "volume=0.1")
  .output(FluentStream.stdout);
const result = await fluent.run();
const reader = result.output.getReader();
const deadline = AbortSignal.timeout(60000);
let onDeadline;
const timedOut = new Promise((_, reject) => {
  onDeadline = () => reject(new Error("Prepared mixer render timed out"));
  deadline.addEventListener("abort", onDeadline, { once: true });
});
const cached = {
  bpm: null,
  bpmConfidence: 0,
  beatPhaseMs: null,
  beatPhaseConfidence: 0,
  dropMs: null,
  dropConfidence: 0,
  analyzedDurationMs: 0,
};
let transition;
try {
  const prepared = await Promise.race([
    fluent.prepareAutomix(inPath, {
      outgoingRemainingMs: (outDuration - outStart) * 1000,
      incomingDurationMs: inDuration * 1000,
      outgoingAnalysis: cached,
      incomingAnalysis: cached,
      enableTempoMatch: style !== "seamless",
      transitionMode: style,
      transitionOverride: {
        startMs: (outAnchor - overlap) * 1000,
        cueMs: cue * 1000,
        seconds: overlap,
        ...(style === "beat-handoff" ? { tempoFactor: factor } : {}),
      },
    }),
    timedOut,
  ]);
  if (prepared.plan.startMs !== (outAnchor - overlap) * 1000)
    throw new Error("Prepared plan did not retain the approved cue");
  transition = prepared.start();
  void transition.catch(() => {});
  const targetBytes = Math.round((lead + overlap + tail) * rate) * frameBytes;
  const chunks = [];
  let size = 0;
  while (size < targetBytes) {
    const chunk = await Promise.race([reader.read(), timedOut]);
    if (chunk.done) throw new Error(`Mixed PCM ended early after ${size / rate / frameBytes} s`);
    chunks.push(Buffer.from(chunk.value));
    size += chunk.value.byteLength;
  }
  await Promise.race([transition, timedOut]);
  const pcm = Buffer.concat(chunks).subarray(0, targetBytes);
  if (pcm.length !== targetBytes) throw new Error("Incorrect PCM length");
  let peak = 0,
    peakFrame = 0,
    clipped = 0,
    square = 0,
    silent = 0,
    maxSilent = 0;
  for (let frame = 0; frame < pcm.length / frameBytes; frame++) {
    const left = pcm.readInt16LE(frame * frameBytes) / 32768;
    const right = pcm.readInt16LE(frame * frameBytes + 2) / 32768;
    if (Math.abs(left) > peak || Math.abs(right) > peak) {
      peak = Math.max(Math.abs(left), Math.abs(right));
      peakFrame = frame;
    }
    if (Math.abs(left) >= 32767 / 32768 || Math.abs(right) >= 32767 / 32768) clipped++;
    square += left * left + right * right;
    if (Math.abs(left) + Math.abs(right) < 1 / 32768) maxSilent = Math.max(maxSilent, ++silent);
    else silent = 0;
  }
  if (maxSilent >= rate / 10) throw new Error("Mixed PCM contains >=100 ms digital silence");
  if (peak > 0.96)
    throw new Error(
      `Mixed PCM peak ${peak} at ${peakFrame / rate}s, clipped frames=${clipped} exceeded the 0.96 guard`,
    );
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * frameBytes, 28);
  header.writeUInt16LE(frameBytes, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  const report = {
    previewOnly: true,
    output,
    renderer: "FluentStream.prepareAutomix / PlaybackMixer",
    mode: style,
    outgoingAnchorSeconds: outAnchor,
    incomingAnchorSeconds: inAnchor,
    outgoingStartSeconds: outStart,
    incomingCueSeconds: cue,
    overlapSeconds: overlap,
    tempoFactor: factor,
    tempoReturnSeconds: style === "beat-handoff" ? 4 : 0,
    inputGain: 0.1,
    outputDurationSeconds: lead + overlap + tail,
    peak,
    rms: Math.sqrt(square / (pcm.length / 2)),
    maxDigitalSilenceMs: maxSilent / 48,
    sourcePositionAtEndMs: fluent.getPlaybackPositionMs(),
    expectedSourcePositionAtEndMs: Math.round(
      (cue + createReturningTempoTimeline(factor, overlap).toSource(overlap + tail)) * 1000,
    ),
    mixerStats: fluent.getPlaybackStats(),
    warning:
      "Explicit manual cue override; automatic DJ confidence gates deliberately not used. PCM diagnostics cannot certify audible musical alignment or downstream Discord/WebRTC pacing.",
  };
  writeFileSync(output, Buffer.concat([header, pcm]), { flag: "wx" });
  writeFileSync(`${output}.json`, JSON.stringify(report, null, 2), { flag: "wx" });
  console.log(JSON.stringify(report, null, 2));
} finally {
  deadline.removeEventListener("abort", onDeadline);
  await reader.cancel().catch(() => {});
  reader.releaseLock();
  await result.stop("SIGKILL").catch(() => {});
  await result.done.catch(() => {});
  await transition?.catch(() => {});
}
