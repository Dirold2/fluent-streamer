export { AudioProcessor } from "./AudioProcessor.js";
export { analyzePcm, analyzePcmAsync, analyzeTrack } from "./analysis/DjAnalysis.js";
export type { DjAnalysis, DjAnalysisOptions, PcmAnalysisOptions } from "./analysis/DjAnalysis.js";
export type { PlaybackMixerStats } from "./PlaybackMixer.js";
export { planAutomix } from "./analysis/AutomixPlan.js";
export type {
  AutomixPlan,
  AutomixPlanOptions,
  AutomixDiagnostic,
  AutomixFallbackReason,
} from "./analysis/AutomixPlan.js";
export type { PrepareAutomixOptions, PreparedAutomix } from "../Fluent/FluentStream.js";

export { planSectionTransition } from "./analysis/SectionTransitionPlan.js";
export type {
  SectionTransitionPlan,
  SectionTransitionOptions,
} from "./analysis/SectionTransitionPlan.js";
