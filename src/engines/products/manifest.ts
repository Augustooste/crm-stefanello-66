import { Package } from "lucide-react";
import type { EngineManifest } from "@/kernel/engines/contracts";

export const productsEngine = {
  id: "crm.products",
  name: "Produtos",
  version: "1.0.0",
  dependencies: [{ engineId: "crm.core", minimumVersion: "1.0.0" }],
  legacyPlugin: "catalogo",
  capabilities: ["crm.products"],
  requiredEntitlement: "crm.catalog",
  navigation: [
    {
      id: "crm.products",
      title: "Produtos",
      url: "/produtos",
      icon: Package,
      group: "Operação",
      order: 70,
    },
  ],
  routes: [
    { id: "crm.products", path: "/produtos", requiredCapability: "crm.products" },
    { id: "crm.products.detail", path: "/produtos/$id", requiredCapability: "crm.products" },
  ],
} as const satisfies EngineManifest;
