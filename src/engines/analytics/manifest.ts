import type { EngineManifest } from "@/kernel/engines/contracts";
export const analyticsEngine = {
  id: "analytics.core",
  name: "Analytics",
  version: "1.0.0",
  dependencies: [{ engineId: "crm.core", minimumVersion: "1.0.0" }],
  capabilities: ["analytics.dashboards", "analytics.reports"],
  requiredEntitlement: "analytics.basic",
  lifecycle: {
    install: "first-party.noop",
    enable: "first-party.noop",
    disable: "first-party.noop",
  },
} as const satisfies EngineManifest;
