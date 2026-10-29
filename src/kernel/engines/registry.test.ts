import { CalendarDays } from "lucide-react";
import { describe, expect, it } from "vitest";
import type { EngineManifest } from "./contracts";
import { createEngineRegistry, EngineRegistryError, resolveEngineNavigation } from "./registry";

const manifest = (overrides: Partial<EngineManifest> = {}): EngineManifest => ({
  id: "test.example",
  name: "Example",
  version: "1.0.0",
  capabilities: ["test.example"],
  navigation: [
    {
      id: "test.example",
      title: "Example",
      url: "/example",
      icon: CalendarDays,
      group: "Operação",
    },
  ],
  routes: [{ id: "test.example", path: "/example", requiredCapability: "test.example" }],
  ...overrides,
});

describe("createEngineRegistry", () => {
  it("indexes validated manifests and their contributions", () => {
    const registry = createEngineRegistry([manifest({ legacyPlugin: "example" })]);
    expect(registry.capabilities.get("test.example")).toBe("test.example");
    expect(registry.navigation[0]).toMatchObject({
      engineId: "test.example",
      legacyPlugin: "example",
    });
    expect(registry.routes[0]).toMatchObject({
      path: "/example",
      requiredCapability: "test.example",
    });
  });

  it.each([
    ["invalid id", () => createEngineRegistry([manifest({ id: "invalid" as never })])],
    ["duplicate engine", () => createEngineRegistry([manifest(), manifest()])],
    [
      "invalid capability",
      () => createEngineRegistry([manifest({ capabilities: ["invalid" as never] })]),
    ],
    [
      "missing dependency",
      () => createEngineRegistry([manifest({ dependencies: [{ engineId: "missing.engine" }] })]),
    ],
    [
      "unowned route capability",
      () =>
        createEngineRegistry([
          manifest({
            routes: [{ id: "test.route", path: "/x", requiredCapability: "other.capability" }],
          }),
        ]),
    ],
  ])("rejects %s", (_name, build) => {
    expect(build).toThrow(EngineRegistryError);
  });

  it("allows an absent optional dependency", () => {
    expect(() =>
      createEngineRegistry([
        manifest({ dependencies: [{ engineId: "missing.engine", optional: true }] }),
      ]),
    ).not.toThrow();
  });

  it("rejects an installed dependency below its minimum version", () => {
    const dependency = manifest({
      id: "test.dependency",
      version: "1.0.0",
      capabilities: ["test.dependency"],
      navigation: [],
      routes: [],
    });
    const consumer = manifest({
      id: "test.consumer",
      capabilities: ["test.consumer"],
      dependencies: [{ engineId: "test.dependency", minimumVersion: "2.0.0" }],
      navigation: [],
      routes: [],
    });
    expect(() => createEngineRegistry([dependency, consumer])).toThrow(/requires test.dependency/);
  });

  it("rejects circular dependencies", () => {
    const first = manifest({
      id: "test.first",
      capabilities: ["test.first"],
      dependencies: [{ engineId: "test.second" }],
      navigation: [],
      routes: [],
    });
    const second = manifest({
      id: "test.second",
      capabilities: ["test.second"],
      dependencies: [{ engineId: "test.first" }],
      navigation: [],
      routes: [],
    });
    expect(() => createEngineRegistry([first, second])).toThrow(/Circular/);
  });
});

describe("resolveEngineNavigation", () => {
  it("uses the legacy plugin bridge and preserves admin gating", () => {
    const registry = createEngineRegistry([
      manifest({ legacyPlugin: "example" }),
      manifest({
        id: "test.admin",
        capabilities: ["test.admin"],
        legacyPlugin: "admin",
        navigation: [
          {
            id: "test.admin",
            title: "Admin",
            url: "/admin",
            icon: CalendarDays,
            group: "Gestão",
            admin: true,
          },
        ],
        routes: [],
      }),
    ]);

    expect(resolveEngineNavigation(registry, [], false)).toEqual([]);
    expect(
      resolveEngineNavigation(registry, ["example", "admin"], false).map((i) => i.title),
    ).toEqual(["Example"]);
    expect(
      resolveEngineNavigation(registry, ["example", "admin"], true).map((i) => i.title),
    ).toEqual(["Example", "Admin"]);
  });

  it("uses required entitlement as the authoritative navigation gate", () => {
    const registry = createEngineRegistry([
      manifest({ legacyPlugin: "example", requiredEntitlement: "test.entitlement" }),
    ]);
    expect(resolveEngineNavigation(registry, ["example"], true, new Set())).toEqual([]);
    expect(
      resolveEngineNavigation(registry, [], true, new Set(["test.entitlement"])).map(
        (item) => item.title,
      ),
    ).toEqual(["Example"]);
  });
});
