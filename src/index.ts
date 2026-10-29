export { Processor } from "./Core/index.js";
export { FluentStream } from "./Fluent/index.js";

export type * from "./Types/index.js";
export { analyzePcm, analyzePcmAsync, analyzeTrack } from "./Audio/analysis/DjAnalysis.js";
export type {
  DjAnalysis,
  DjAnalysisOptions,
  PcmAnalysisOptions,
} from "./Audio/analysis/DjAnalysis.js";
export type { PlaybackMixerStats } from "./Audio/PlaybackMixer.js";
export { planAutomix } from "./Audio/analysis/AutomixPlan.js";
export type {
  AutomixPlan,
  AutomixPlanOptions,
  AutomixDiagnostic,
  AutomixFallbackReason,
} from "./Audio/analysis/AutomixPlan.js";
export type { PrepareAutomixOptions, PreparedAutomix } from "./Fluent/FluentStream.js";

export { planSectionTransition } from "./Audio/analysis/SectionTransitionPlan.js";
export type {
  SectionTransitionPlan,
  SectionTransitionOptions,
} from "./Audio/analysis/SectionTransitionPlan.js";
