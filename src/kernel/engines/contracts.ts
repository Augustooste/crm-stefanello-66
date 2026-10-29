import type { LucideIcon } from "lucide-react";

export type EngineId = `${string}.${string}`;
export type CapabilityId = `${string}.${string}`;
export type NavigationGroup = "Operação" | "Automação e IA" | "Gestão";

export interface EngineDependency {
  engineId: EngineId;
  optional?: boolean;
  minimumVersion?: string;
}

export interface EngineLifecycleContribution {
  install?: string;
  enable?: string;
  disable?: string;
  uninstall?: string;
}

export interface NavigationContribution {
  id: string;
  title: string;
  url: string;
  icon: LucideIcon;
  group: NavigationGroup;
  admin?: boolean;
  order?: number;
}

/**
 * Route metadata is deliberately build-time only. TanStack's file router still
 * owns route creation, while the registry gives the shell and future tooling a
 * single inventory of routes contributed by engines.
 */
export interface RouteContribution {
  id: string;
  path: string;
  requiredCapability: CapabilityId;
}

export interface EngineManifest {
  id: EngineId;
  name: string;
  version: string;
  capabilities: readonly CapabilityId[];
  /** Commercial capability required before this engine can be installed/enabled. */
  requiredEntitlement?: CapabilityId;
  dependencies?: readonly EngineDependency[];
  navigation?: readonly NavigationContribution[];
  routes?: readonly RouteContribution[];
  /** Temporary bridge until tenant_entitlements becomes authoritative. */
  legacyPlugin?: string;
  /** Handler ids are resolved only from the first-party lifecycle registry. */
  lifecycle?: EngineLifecycleContribution;
}
