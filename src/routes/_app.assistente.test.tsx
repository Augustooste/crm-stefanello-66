import { describe, expect, it } from "vitest";
import { Route } from "./_app.assistente";

describe("redirect de /assistente (absorvida por /configuracoes)", () => {
  it("redireciona para a aba 'assistente' em /configuracoes", async () => {
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
    expect(redirectOptions.hash).toBe("ia/assistente");
  });
});
