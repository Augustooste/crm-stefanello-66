/** Returns violations; build tooling can fail without coupling the check to ESLint internals. */
export function findEngineBoundaryViolations(files: Readonly<Record<string, string>>): string[] {
  const violations: string[] = [];
  const enginePath = /(?:@\/engines|src\/engines)\/([^/'"]+)\/([^'"\s;]+)/g;
  for (const [file, source] of Object.entries(files)) {
    if (file.replace(/\\/g, "/").endsWith("src/engines/registry.ts")) continue;
    const owner = file.replace(/\\/g, "/").match(/src\/engines\/([^/]+)\//)?.[1];
    for (const match of source.matchAll(enginePath)) {
      const target = match[1];
      const subpath = match[2];
      if (target !== owner && subpath !== "index" && subpath !== "index.ts") {
        violations.push(`${file}: cross-engine import must use @/engines/${target}`);
      }
      if (subpath.startsWith("internal")) {
        violations.push(`${file}: internal engine modules are private`);
      }
    }
  }
  return violations;
}
