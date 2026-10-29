import type {
  CapabilityId,
  EngineId,
  EngineManifest,
  NavigationContribution,
  RouteContribution,
} from "./contracts";

const NAMESPACED_ID = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;
const CONTRIBUTION_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export class EngineRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineRegistryError";
  }
}

export interface EngineRegistry {
  engines: readonly EngineManifest[];
  capabilities: ReadonlyMap<CapabilityId, EngineId>;
  navigation: readonly (NavigationContribution & {
    engineId: EngineId;
    legacyPlugin?: string;
    requiredEntitlement?: CapabilityId;
  })[];
  routes: readonly (RouteContribution & { engineId: EngineId; legacyPlugin?: string })[];
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new EngineRegistryError(message);
}

export function createEngineRegistry(manifests: readonly EngineManifest[]): EngineRegistry {
  const enginesById = new Map<EngineId, EngineManifest>();
  const capabilities = new Map<CapabilityId, EngineId>();
  const navigationIds = new Set<string>();
  const routeIds = new Set<string>();
  const routePaths = new Set<string>();

  for (const manifest of manifests) {
    assert(NAMESPACED_ID.test(manifest.id), `Invalid engine id: ${manifest.id}`);
    assert(
      SEMVER.test(manifest.version),
      `Invalid version for ${manifest.id}: ${manifest.version}`,
    );
    assert(!enginesById.has(manifest.id), `Duplicate engine id: ${manifest.id}`);
    if (manifest.requiredEntitlement) {
      assert(
        NAMESPACED_ID.test(manifest.requiredEntitlement),
        `Invalid required entitlement for ${manifest.id}: ${manifest.requiredEntitlement}`,
      );
    }
    enginesById.set(manifest.id, manifest);

    for (const capability of manifest.capabilities) {
      assert(NAMESPACED_ID.test(capability), `Invalid capability id: ${capability}`);
      assert(!capabilities.has(capability), `Duplicate capability: ${capability}`);
      capabilities.set(capability, manifest.id);
    }
    for (const item of manifest.navigation ?? []) {
      assert(CONTRIBUTION_ID.test(item.id), `Invalid navigation id: ${item.id}`);
      assert(item.url.startsWith("/"), `Navigation URL must be absolute: ${item.url}`);
      assert(!navigationIds.has(item.id), `Duplicate navigation id: ${item.id}`);
      navigationIds.add(item.id);
    }
    for (const route of manifest.routes ?? []) {
      assert(CONTRIBUTION_ID.test(route.id), `Invalid route id: ${route.id}`);
      assert(route.path.startsWith("/"), `Route path must be absolute: ${route.path}`);
      assert(
        manifest.capabilities.includes(route.requiredCapability),
        `Route ${route.id} requires capability not owned by ${manifest.id}: ${route.requiredCapability}`,
      );
      assert(!routeIds.has(route.id), `Duplicate route id: ${route.id}`);
      assert(!routePaths.has(route.path), `Duplicate route path: ${route.path}`);
      routeIds.add(route.id);
      routePaths.add(route.path);
    }
  }

  for (const manifest of manifests) {
    for (const dependency of manifest.dependencies ?? []) {
      assert(dependency.engineId !== manifest.id, `${manifest.id} cannot depend on itself`);
      assert(
        dependency.optional || enginesById.has(dependency.engineId),
        `Missing dependency for ${manifest.id}: ${dependency.engineId}`,
      );
      if (dependency.minimumVersion) {
        assert(
          SEMVER.test(dependency.minimumVersion),
          `Invalid minimum dependency version for ${manifest.id}: ${dependency.minimumVersion}`,
        );
        const installed = enginesById.get(dependency.engineId);
        if (installed) {
          const parts = (version: string) => version.split("-")[0].split(".").map(Number);
          const current = parts(installed.version);
          const minimum = parts(dependency.minimumVersion);
          const compatible =
            current[0] > minimum[0] ||
            (current[0] === minimum[0] && current[1] > minimum[1]) ||
            (current[0] === minimum[0] && current[1] === minimum[1] && current[2] >= minimum[2]);
          assert(
            compatible,
            `${manifest.id} requires ${dependency.engineId} >= ${dependency.minimumVersion}`,
          );
        }
      }
    }
  }

  const visiting = new Set<EngineId>();
  const visited = new Set<EngineId>();
  const visit = (id: EngineId) => {
    if (visiting.has(id)) throw new EngineRegistryError(`Circular engine dependency at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of enginesById.get(id)?.dependencies ?? []) {
      if (enginesById.has(dependency.engineId)) visit(dependency.engineId);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of enginesById.keys()) visit(id);

  const navigation = manifests
    .flatMap((manifest) =>
      (manifest.navigation ?? []).map((item) => ({
        ...item,
        engineId: manifest.id,
        legacyPlugin: manifest.legacyPlugin,
        requiredEntitlement: manifest.requiredEntitlement,
      })),
    )
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  const routes = manifests.flatMap((manifest) =>
    (manifest.routes ?? []).map((route) => ({
      ...route,
      engineId: manifest.id,
      legacyPlugin: manifest.legacyPlugin,
    })),
  );

  return Object.freeze({
    engines: Object.freeze([...manifests]),
    capabilities,
    navigation,
    routes,
  });
}

export function resolveEngineNavigation(
  registry: EngineRegistry,
  activeLegacyPlugins: readonly string[],
  isAdmin: boolean,
  enabledCapabilities?: ReadonlySet<string>,
) {
  return registry.navigation.filter(
    (item) =>
      (!item.admin || isAdmin) &&
      (enabledCapabilities && item.requiredEntitlement
        ? enabledCapabilities.has(item.requiredEntitlement)
        : !item.legacyPlugin || activeLegacyPlugins.includes(item.legacyPlugin)),
  );
}
