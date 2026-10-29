import { describe, expect, it, vi } from "vitest";
import { isPermissionError, rpcRetry, waitForSession } from "./session-guard";
import { supabase } from "@/integrations/supabase/client";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { getSession: vi.fn() } },
}));

// Regressão de 2026-08-10: RPC saindo antes do token da sessão anexar
// resolvia o papel como `anon` no PostgREST e voltava 42501. Cobre a lógica
// compartilhada por dashboard-widgets.ts (3 sites) e reports.ts (1 site).

describe("isPermissionError", () => {
  it("reconhece 42501 (permission denied do Postgres)", () => {
    expect(isPermissionError({ code: "42501", message: "permission denied for function x" })).toBe(
      true,
    );
  });

  it("reconhece 401", () => {
    expect(isPermissionError({ code: "401", message: "unauthorized" })).toBe(true);
  });

  it("reconhece pela mensagem quando o code não vem preenchido", () => {
    expect(isPermissionError({ message: "permission denied for relation deals" })).toBe(true);
  });

  it("não reconhece outros erros", () => {
    expect(isPermissionError({ code: "PGRST116", message: "outro erro" })).toBe(false);
  });

  it("não quebra com valores que não são objeto", () => {
    expect(isPermissionError(null)).toBe(false);
    expect(isPermissionError(undefined)).toBe(false);
    expect(isPermissionError("boom")).toBe(false);
  });
});

describe("rpcRetry", () => {
  it("tenta de novo até 2x em erro de permissão, dando tempo da sessão hidratar", () => {
    const permissionError = { code: "42501", message: "permission denied" };
    expect(rpcRetry(0, permissionError)).toBe(true);
    expect(rpcRetry(1, permissionError)).toBe(true);
    expect(rpcRetry(2, permissionError)).toBe(false);
  });

  it("tenta só 1x em erro que não é de permissão", () => {
    const outroErro = { code: "PGRST116", message: "outro erro" };
    expect(rpcRetry(0, outroErro)).toBe(true);
    expect(rpcRetry(1, outroErro)).toBe(false);
  });
});

describe("waitForSession", () => {
  it("aguarda supabase.auth.getSession() antes de resolver", async () => {
    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: { session: {} },
      error: null,
    } as Awaited<ReturnType<typeof supabase.auth.getSession>>);

    await waitForSession();

    expect(supabase.auth.getSession).toHaveBeenCalledTimes(1);
  });
});
