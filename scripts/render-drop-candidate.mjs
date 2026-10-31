#!/usr/bin/env node
// Offline *candidate* renderer, not a production DJ plan or a musical-drop detector.
// Run after npm run build: node scripts/render-drop-candidate.mjs outgoing.mp3 incoming.mp3 outAnchorSec inAnchorSec outBpm inBpm output.wav
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import {
  buildReturningAtempo,
  createReturningTempoTimeline,
} from "../dist/Audio/analysis/Atempo.js";

const [outPath, inPath, outText, inText, outBpmText, inBpmText, output] = process.argv.slice(2);
if (!outPath || !inPath || !outText || !inText || !outBpmText || !inBpmText || !output) {
  throw new Error(
    "Expected outgoing incoming outgoingAnchorSeconds incomingAnchorSeconds outgoingBpm incomingBpm output.wav",
  );
}
for (const file of [outPath, inPath])
  if (!existsSync(file)) throw new Error(`Input missing: ${file}`);
if (existsSync(output) || existsSync(`${output}.json`))
  throw new Error(`Output already exists: ${output}`);
const [outAnchor, inAnchor, outBpm, inBpm] = [outText, inText, outBpmText, inBpmText].map(Number);
if (
  ![outAnchor, inAnchor, outBpm, inBpm].every(Number.isFinite) ||
  outBpm < 70 ||
  outBpm > 180 ||
  inBpm < 70 ||
  inBpm > 180
)
  throw new RangeError("Expected finite anchors and plausible 70–180 BPM estimates");
const factor = outBpm / inBpm;
if (Math.abs(1 - factor) > 0.08) throw new RangeError("Tempo difference exceeds 8%");
const lead = 6;
const overlap = 6;
const tail = 10;
const outgoingStart = outAnchor - lead - overlap;
const incomingCue = inAnchor - overlap * factor;
if (outgoingStart < 0 || incomingCue < 0)
  throw new RangeError("Not enough lead-in before an anchor");
function run(program, args, options = {}) {
  const result = spawnSync(program, args, {
    encoding: "utf8",
    timeout: 90000,
    maxBuffer: 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${program} failed (${result.status}): ${result.stderr.toString()}`);
  return result.stdout;
}
function duration(file) {
  const value = Number(
    run("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      file,
    ]),
  );
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Duration unavailable: ${file}`);
  return value;
}
const outDuration = duration(outPath);
const inDuration = duration(inPath);
if (
  outAnchor <= outDuration / 2 ||
  outAnchor > outDuration - 1 ||
  inAnchor >= inDuration / 2 ||
  incomingCue + createReturningTempoTimeline(factor, overlap).toSource(overlap + tail) >=
    inDuration - 0.1
)
  throw new RangeError(
    "Anchors must fit the outgoing second half and incoming first half with full preview tails",
  );

// Render one continuous WAV. The input excerpts contain 6 s of lead-in, a
// six-second overlap ending at both chosen anchors, and 10 s of incoming solo.
// This is a simple equal-power crossfade, not the PCM PlaybackMixer bass split.
const filter =
  `[0:a]aresample=48000,aformat=channel_layouts=stereo,atrim=duration=${lead + overlap},asetpts=N/SR/TB[o];` +
  `[1:a]aresample=48000,aformat=channel_layouts=stereo,${buildReturningAtempo(factor, overlap)},atrim=duration=${overlap + tail},asetpts=N/SR/TB[i];` +
  `[o][i]acrossfade=d=${overlap}:curve1=qsin:curve2=qsin,volume=0.707106781187,alimiter=limit=0.95:level=0:latency=1[a]`;
run(
  "ffmpeg",
  [
    "-v",
    "error",
    "-nostdin",
    "-n",
    "-ss",
    String(outgoingStart),
    "-t",
    String(lead + overlap),
    "-i",
    outPath,
    "-ss",
    String(incomingCue),
    "-t",
    String(createReturningTempoTimeline(factor, overlap).toSource(overlap + tail) + 1),
    "-i",
    inPath,
    "-filter_complex",
    filter,
    "-map",
    "[a]",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-c:a",
    "pcm_s16le",
    output,
  ],
  { timeout: 120000 },
);
const expectedDuration = lead + overlap + tail;
const actualDuration = duration(output);
if (Math.abs(actualDuration - expectedDuration) > 0.1)
  throw new Error(`Unexpected render duration: ${actualDuration}`);
const bytes = run(
  "ffmpeg",
  ["-v", "error", "-i", output, "-f", "s16le", "-c:a", "pcm_s16le", "pipe:1"],
  { encoding: null, maxBuffer: 5 * 1024 * 1024, timeout: 30000 },
);
const frames = bytes.length / 4;
if (!Number.isInteger(frames) || frames === 0)
  throw new Error("No valid stereo PCM frames rendered");
let peak = 0,
  gapFrames = 0,
  maxGapFrames = 0,
  sum = 0;
for (let frame = 0; frame < frames; frame++) {
  const left = bytes.readInt16LE(frame * 4) / 32768;
  const right = bytes.readInt16LE(frame * 4 + 2) / 32768;
  peak = Math.max(peak, Math.abs(left), Math.abs(right));
  sum += left * left + right * right;
  if (Math.abs(left) + Math.abs(right) < 1 / 32768) {
    gapFrames++;
    maxGapFrames = Math.max(maxGapFrames, gapFrames);
  } else gapFrames = 0;
}
if (maxGapFrames >= 4800)
  throw new Error("Rendered output contains at least 100 ms of digital silence");
if (peak > 0.96) throw new Error("Rendered output exceeded the peak ceiling");
const report = {
  previewOnly: true,
  output,
  outgoingAnchorSeconds: outAnchor,
  incomingAnchorSeconds: inAnchor,
  outgoingExcerptStartSeconds: outgoingStart,
  incomingExcerptCueSeconds: incomingCue,
  tempoFactor: factor,
  tempoReturnSeconds: 4,
  incomingSourceMsAtEndOfOverlap: Math.round(
    (incomingCue + createReturningTempoTimeline(factor, overlap).toSource(overlap)) * 1000,
  ),
  overlapSeconds: overlap,
  leadSeconds: lead,
  incomingSoloSeconds: tail,
  outputDurationSeconds: actualDuration,
  peak,
  rms: Math.sqrt(sum / (frames * 2)),
  maxDigitalSilenceMs: maxGapFrames / 48,
  outputFrames: frames,
  warning:
    "These are unverified arrangement anchors, not annotated drops or downbeats. Rendered-audio PCM checks cannot certify phase, vocals, or musical quality. Not the live mixer.",
};
writeFileSync(`${output}.json`, JSON.stringify(report, null, 2), { flag: "wx" });
console.log(JSON.stringify(report, null, 2));
