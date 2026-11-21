export {
  type EvidenceFilters,
  findEligibleNormativeMetrics,
  loadEvidenceCatalog,
} from "./catalog.js";
export { type CoachingCheckpoint, compareMetricsAgainstCatalog } from "./compare.js";
export {
  buildWaveformBandComparison,
  evaluateMeanSd,
  evaluateMedianIqr,
  evaluateThresholdRange,
  type WaveformReferenceBand,
} from "./statistics.js";
