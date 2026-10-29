// Guard de SSR. `supabase` é um Proxy preguiçoso que LANÇA "Missing Supabase
// environment variable(s)" no primeiro acesso a qualquer propriedade, e
// `__root.tsx` renderiza no servidor. Se o `typeof window` de logClientError
// descer para depois do `.rpc(...)`, a telemetria passa a derrubar o SSR em vez
// de reportar erro — o oposto do objetivo desta feature.
//
// Não basta afirmar que a chamada resolve `false`: o try/catch de
// logClientError engole o throw do Proxy e devolve `false` de qualquer jeito.
// Por isso o mock registra QUALQUER acesso de propriedade e o teste afirma que
// nenhum aconteceu.
import { beforeEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({ touched: [] as string[] }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: new Proxy(
    {},
    {
      get(_target, prop) {
        probe.touched.push(String(prop));
        throw new Error("Missing Supabase environment variable(s)");
      },
    },
  ),
}));

import { installClientErrorHandlers, logClientError } from "./client-error-telemetry";

describe("telemetria durante o SSR (sem window)", () => {
  beforeEach(() => {
    probe.touched = [];
    // jsdom define window; aqui simulamos o runtime do servidor.
    vi.stubGlobal("window", undefined);
  });

  it("logClientError não toca no client Supabase e vira no-op silencioso", async () => {
    await expect(logClientError(new Error("boom"), { origin: "query" })).resolves.toBe(false);
    expect(probe.touched).toEqual([]);
  });

  it("installClientErrorHandlers devolve cleanup inócuo sem registrar listener", () => {
    const cleanup = installClientErrorHandlers();
    expect(cleanup).toBeTypeOf("function");
    expect(() => cleanup()).not.toThrow();
    expect(probe.touched).toEqual([]);
  });

  it("controle positivo: com window, o client Supabase é de fato acessado", async () => {
    vi.unstubAllGlobals();
    await expect(logClientError(new Error("boom"), { origin: "query" })).resolves.toBe(false);
    expect(probe.touched).toContain("rpc");
  });
});
