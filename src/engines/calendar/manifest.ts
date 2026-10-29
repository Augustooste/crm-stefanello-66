import type { EngineManifest } from "@/kernel/engines/contracts";
export const calendarEngine = {
  id: "calendar.core",
  name: "Calendar Core",
  version: "1.0.0",
  dependencies: [{ engineId: "crm.core", minimumVersion: "1.0.0" }],
  capabilities: ["calendar.appointments"],
  requiredEntitlement: "calendar.agenda",
  lifecycle: {
    install: "first-party.noop",
    enable: "first-party.noop",
    disable: "first-party.noop",
  },
} as const satisfies EngineManifest;
