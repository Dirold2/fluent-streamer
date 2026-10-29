import type { DjAnalysis } from "./DjAnalysisCore.js";

export interface AnalysisRequest {
  format: "samples" | "s16le";
  buffer: ArrayBuffer;
  sampleRate: number;
  byteLength?: number;
}

export type AnalysisResponse =
  | { ok: true; result: DjAnalysis }
  | { ok: false; error: { name: string; message: string } };
