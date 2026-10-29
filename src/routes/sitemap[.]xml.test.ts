import { describe, expect, it } from "vitest";
import { Route } from "./sitemap[.]xml";

function getHandler() {
  const handler = Route.options.server?.handlers;
  if (!handler || !("GET" in handler) || typeof handler.GET !== "function") {
    throw new Error("Handler GET não encontrado na rota /sitemap.xml");
  }
  return handler.GET as (...args: never[]) => Promise<Response> | Response;
}

describe("rota GET /sitemap.xml", () => {
  it("retorna XML válido com a URL base e content-type correto", async () => {
    const response = await getHandler()();
    expect(response.headers.get("Content-Type")).toBe("application/xml");

    const body = await response.text();
    expect(body).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(body).toContain("<urlset");
    expect(body).toContain("<loc>https://aceleraflow.lovable.app/</loc>");
    expect(body).toContain("<changefreq>weekly</changefreq>");
    expect(body).toContain("<priority>1.0</priority>");
  });

  it("define cache-control público de 1 hora", async () => {
    const response = await getHandler()();
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=3600");
  });
});
