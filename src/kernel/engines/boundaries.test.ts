import { describe, expect, it } from "vitest";
import { findEngineBoundaryViolations } from "./boundaries";

describe("engine import boundaries", () => {
  it("allows public facades and own modules", () => {
    expect(
      findEngineBoundaryViolations({
        "src/engines/ai/view.ts":
          'import { crmEngine } from "@/engines/crm"; import x from "@/engines/ai/internal/x";',
      }),
    ).toEqual(["src/engines/ai/view.ts: internal engine modules are private"]);
  });

  it("rejects cross-engine deep imports", () => {
    expect(
      findEngineBoundaryViolations({
        "src/engines/ai/view.ts": 'import x from "@/engines/crm/internal/contact";',
      }),
    ).toEqual([
      "src/engines/ai/view.ts: cross-engine import must use @/engines/crm",
      "src/engines/ai/view.ts: internal engine modules are private",
    ]);
  });
});
