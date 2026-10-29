import { describe, expect, it } from "vitest";
import { Route } from "./_app.agendamentos";

describe("redirect de /agendamentos (absorvida por /templates)", () => {
  it("redireciona para a aba 'agendamentos' em /templates", async () => {
    let caught: unknown;
    try {
      await Route.options.beforeLoad?.({} as never);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Response);
    const redirectOptions = (caught as Response & { options: { to: string; hash: string } })
      .options;
    expect(redirectOptions.to).toBe("/templates");
    expect(redirectOptions.hash).toBe("agendamentos");
  });
});
