import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { findEngineBoundaryViolations } from "./boundaries";

function collect(dir: string, root = process.cwd()): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(files, collect(path, root));
    else if (/\.[jt]sx?$/.test(entry.name))
      files[relative(root, path)] = readFileSync(path, "utf8");
  }
  return files;
}

describe("repository engine boundaries", () => {
  it("contains no cross-engine deep imports", () => {
    expect(findEngineBoundaryViolations(collect(join(process.cwd(), "src", "engines")))).toEqual(
      [],
    );
  });
});
