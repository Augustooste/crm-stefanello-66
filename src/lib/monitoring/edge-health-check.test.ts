import { afterEach, describe, expect, it, vi } from "vitest";

import { runEdgeHealthCheck } from "./edge-health-check";

const BASE = "https://example.supabase.co";

afterEach(() => vi.restoreAllMocks());

describe("runEdgeHealthCheck", () => {
  it("marca ok quando todas respondem 2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    const report = await runEdgeHealthCheck(BASE, ["a", "b"]);
    expect(report.overall).toBe("ok");
    expect(report.functions.map((f) => f.name)).toEqual(["a", "b"]);
    expect(report.functions.every((f) => f.status === "ok")).toBe(true);
  });

  it("marca down quando alguma responde 5xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).endsWith("/b")
          ? new Response(null, { status: 500 })
          : new Response(null, { status: 204 }),
      ),
    );
    const report = await runEdgeHealthCheck(BASE, ["a", "b"]);
    expect(report.overall).toBe("down");
    expect(report.functions.find((f) => f.name === "b")?.status).toBe("down");
  });

  it("marca degraded em 4xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    const report = await runEdgeHealthCheck(BASE, ["a"]);
    expect(report.overall).toBe("degraded");
    expect(report.functions[0].http_status).toBe(401);
  });

  it("trata erro de rede/timeout como down sem vazar a mensagem", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED https://example.supabase.co?apikey=segredo");
      }),
    );
    const report = await runEdgeHealthCheck(BASE, ["a"]);
    expect(report.functions[0]).toMatchObject({ name: "a", status: "down", http_status: null });
    expect(JSON.stringify(report)).not.toContain("segredo");
  });
});
