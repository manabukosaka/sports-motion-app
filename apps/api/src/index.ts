import { CONTRACT_VERSION } from "@sports-motion/contracts";

export function contractHealth() {
  return { status: "ok", contract_version: CONTRACT_VERSION } as const;
}
