import { CalendarDays } from "lucide-react";
import type { EngineManifest } from "@/kernel/engines/contracts";

export const agendaEngine = {
  id: "calendar.agenda",
  name: "Agenda",
  version: "1.0.0",
  dependencies: [{ engineId: "calendar.core", minimumVersion: "1.0.0" }],
  legacyPlugin: "agenda",
  capabilities: ["calendar.agenda"],
  requiredEntitlement: "calendar.agenda",
  navigation: [
    {
      id: "calendar.agenda",
      title: "Agenda",
      url: "/agenda",
      icon: CalendarDays,
      group: "Operação",
      order: 80,
    },
  ],
  routes: [{ id: "calendar.agenda", path: "/agenda", requiredCapability: "calendar.agenda" }],
} as const satisfies EngineManifest;
