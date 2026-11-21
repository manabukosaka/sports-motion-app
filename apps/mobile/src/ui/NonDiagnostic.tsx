import { DEFAULT_NON_DIAGNOSTIC_DISCLAIMER_JA } from "@sports-motion/coaching";
import { Notice } from "./primitives.js";

export function NonDiagnostic({ disclaimer_text_ja }: { disclaimer_text_ja?: string }) {
  return (
    <Notice nonDiagnostic>
      {disclaimer_text_ja?.trim() ? disclaimer_text_ja : DEFAULT_NON_DIAGNOSTIC_DISCLAIMER_JA}
    </Notice>
  );
}
