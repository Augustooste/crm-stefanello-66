import type { EngineManifest } from "@/kernel/engines/contracts";
export const nurtureEngine = {
  id: "automation.nurture",
  name: "Nurture",
  version: "1.0.0",
  dependencies: [{ engineId: "crm.core", minimumVersion: "1.0.0" }],
  capabilities: ["automation.nurture"],
  requiredEntitlement: "automation.nurture",
  lifecycle: {
    install: "first-party.noop",
    enable: "first-party.noop",
    disable: "first-party.noop",
  },
} as const satisfies EngineManifest;
