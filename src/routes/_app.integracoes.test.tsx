import { describe, expect, it } from "vitest";
import { Route } from "./_app.integracoes";

describe("redirect de /integracoes (absorvida por /configuracoes)", () => {
  it("redireciona para a aba 'plugins' em /configuracoes", async () => {
    let caught: unknown;
    try {
      await Route.options.beforeLoad?.({} as never);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Response);
    const redirectOptions = (caught as Response & { options: { to: string; hash: string } })
      .options;
    expect(redirectOptions.to).toBe("/configuracoes");
    expect(redirectOptions.hash).toBe("plugins");
  });
});
