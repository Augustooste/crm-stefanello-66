import type { EngineManifest } from "@/kernel/engines/contracts";
export const aiEngine = {
  id: "ai.core",
  name: "AI & HITL",
  version: "1.0.0",
  dependencies: [{ engineId: "crm.core", minimumVersion: "1.0.0" }],
  capabilities: ["ai.assistant", "ai.hitl", "ai.insights"],
  requiredEntitlement: "ai.assistant",
  lifecycle: {
    install: "first-party.noop",
    enable: "first-party.noop",
    disable: "first-party.noop",
  },
} as const satisfies EngineManifest;
