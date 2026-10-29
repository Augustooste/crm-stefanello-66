import type { EngineManifest } from "@/kernel/engines/contracts";
export const crmEngine = {
  id: "crm.core",
  name: "CRM Core",
  version: "1.0.0",
  capabilities: ["crm.contacts", "crm.pipeline", "crm.activities"],
  requiredEntitlement: "crm.core",
  lifecycle: {
    install: "first-party.noop",
    enable: "first-party.noop",
    disable: "first-party.noop",
  },
} as const satisfies EngineManifest;
