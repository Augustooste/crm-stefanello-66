import { Building2 } from "lucide-react";
import type { EngineManifest } from "@/kernel/engines/contracts";

export const companiesEngine = {
  id: "crm.companies",
  name: "Empresas",
  version: "1.0.0",
  dependencies: [{ engineId: "crm.core", minimumVersion: "1.0.0" }],
  legacyPlugin: "companies",
  capabilities: ["crm.companies"],
  requiredEntitlement: "crm.companies",
  navigation: [
    {
      id: "crm.companies",
      title: "Empresas",
      url: "/empresas",
      icon: Building2,
      group: "Operação",
      order: 60,
    },
  ],
  routes: [
    { id: "crm.companies", path: "/empresas", requiredCapability: "crm.companies" },
    { id: "crm.companies.detail", path: "/empresas/$id", requiredCapability: "crm.companies" },
  ],
} as const satisfies EngineManifest;
