import { describe, expect, it, vi } from "vitest";
import {
  capabilityForLegacyPlugin,
  myCapabilitiesQueryOptions,
  resolveCapability,
  type EffectiveCapability,
} from "./entitlements";

describe("capabilityForLegacyPlugin", () => {
  it("mapeia os slugs atuais para chaves estáveis", () => {
    expect(capabilityForLegacyPlugin("agenda")).toBe("calendar.agenda");
    expect(capabilityForLegacyPlugin("catalogo")).toBe("crm.catalog");
  });

  it("retorna null para plugin ainda não catalogado", () => {
    expect(capabilityForLegacyPlugin("futuro-plugin")).toBeNull();
  });
});

describe("resolveCapability", () => {
  const explicit: EffectiveCapability[] = [
    { capability_key: "calendar.agenda", enabled: false, source: "subscription" },
  ];

  it("entitlement explícito vence um legado ativo", () => {
    expect(resolveCapability("calendar.agenda", explicit, true)).toBe(false);
  });

  it("usa fallback legado durante rollout parcial", () => {
    expect(resolveCapability("crm.companies", explicit, true)).toBe(true);
    expect(resolveCapability("crm.companies", undefined, false)).toBe(false);
  });
});

// --- Gate de sessão da RPC get_my_capabilities -------------------------------
// Regressão de 2026-07-31: sem sessão a chamada chega ao banco como `anon`,
// que não tem EXECUTE, e o 42501 derrubava /app inteiro no error boundary.
describe("myCapabilitiesQueryOptions", () => {
  it("não chama a RPC quando não há sessão e devolve lista vazia", async () => {
    const { supabase } = await import("@/integrations/supabase/client");
    vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
      data: { session: null },
      error: null,
    } as Awaited<ReturnType<typeof supabase.auth.getSession>>);
    const rpc = vi.fn();
    (supabase as unknown as { rpc: unknown }).rpc = rpc;

    const options = myCapabilitiesQueryOptions();
    await expect(options.queryFn()).resolves.toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("não propaga o erro para o boundary da rota (throwOnError desligado)", () => {
    expect(myCapabilitiesQueryOptions().throwOnError).toBe(false);
  });

  it("tenta de novo em erro de permissão, dando tempo da sessão hidratar", () => {
    const { retry } = myCapabilitiesQueryOptions();
    expect(retry(0, { code: "42501", message: "permission denied" })).toBe(true);
    expect(retry(1, { code: "42501", message: "permission denied" })).toBe(true);
    expect(retry(2, { code: "42501", message: "permission denied" })).toBe(false);
    expect(retry(1, { code: "PGRST116", message: "outro erro" })).toBe(false);
  });
});
