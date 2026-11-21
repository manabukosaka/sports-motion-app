import { CONTRACT_VERSION } from "@sports-motion/contracts";

export * from "./access-policy.js";
export * from "./http.js";
export * from "./lifecycle.js";
export * from "./share-token.js";
export * from "./state-store.js";

export function contractHealth() {
  return { status: "ok", contract_version: CONTRACT_VERSION } as const;
}
