import { CONTRACT_VERSION } from "@sports-motion/contracts";

export * from "./access-policy.js";
export type { AnalysisReceipt, AnalysisSubmission } from "./analysis.js";
export * from "./http.js";
export * from "./lifecycle.js";
export * from "./share-token.js";
export * from "./state-store.js";
export {
  InvalidMotionInput,
  type MotionWorker,
  UvMotionWorker,
  type WorkerAnalysisRequest,
  type WorkerAnalysisResult,
} from "./worker.js";

export function contractHealth() {
  return { status: "ok", contract_version: CONTRACT_VERSION } as const;
}
