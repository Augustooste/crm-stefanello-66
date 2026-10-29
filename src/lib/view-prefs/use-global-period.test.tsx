// Testes do filtro global de período. O caso central é o compartilhamento
// entre instâncias: o seletor do topbar (GlobalPeriodPicker) e o inbox são
// instâncias separadas do hook; mudar o período em uma precisa refletir na
// outra sem remontar.
import { act, renderHook } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PeriodKey } from "@/lib/view-prefs/use-global-period";
import { createTestQueryClient } from "@/test/render";

// `mockPrefs` precisa ser hoisted porque o factory do vi.mock é içado.
const h = vi.hoisted(() => ({
  mockPrefs: {} as Record<string, unknown>,
}));

vi.mock("@/lib/api/view-prefs", () => ({
  useViewPrefs: () => ({ prefs: h.mockPrefs, isVisible: () => false }),
}));

// Variáveis sem anotação; tipos inferidos do módulo dinâmico.
// Exceção: dynamic import é necessário aqui para exercitar reset de módulo
// (vi.resetModules()) e estado compartilhado entre instâncias.
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
let useGlobalPeriod: (typeof import("./use-global-period"))["useGlobalPeriod"];
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
let rangeFor: (typeof import("./use-global-period"))["rangeFor"];

beforeEach(async () => {
  vi.resetModules();
  window.sessionStorage.clear();
  h.mockPrefs = {};
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const mod = await import("./use-global-period");
  useGlobalPeriod = mod.useGlobalPeriod;
  rangeFor = mod.rangeFor;
});

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = createTestQueryClient();
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useGlobalPeriod", () => {
  it("reflete a mudança de período em outra instância já montada", () => {
    const { result: a } = renderHook(() => useGlobalPeriod(), { wrapper });
    const { result: b } = renderHook(() => useGlobalPeriod(), { wrapper });

    expect(a.current.period).toBe("last_30d");
    expect(b.current.period).toBe("last_30d");

    act(() => {
      a.current.setPeriod("last_90d");
    });

    expect(a.current.period).toBe("last_90d");
    expect(b.current.period).toBe("last_90d");
    expect(b.current.range.from.getTime()).toBe(rangeFor("last_90d").from.getTime());
  });

  it("persiste no sessionStorage e uma nova montagem lê o valor salvo", () => {
    const { result: a, unmount } = renderHook(() => useGlobalPeriod(), { wrapper });
    act(() => {
      a.current.setPeriod("last_90d");
    });
    unmount();

    expect(window.sessionStorage.getItem("aceleraflow.global.period")).toBe("last_90d");

    const { result: fresh } = renderHook(() => useGlobalPeriod(), { wrapper });
    expect(fresh.current.period).toBe("last_90d");
  });

  it("mantém a prioridade sessão > default do tenant > last_30d", () => {
    h.mockPrefs = { global: { period: "today" } };
    const { result } = renderHook(() => useGlobalPeriod(), { wrapper });

    // Sem sessão, vale o default do tenant.
    expect(result.current.period).toBe("today");

    act(() => {
      result.current.setPeriod("last_90d");
    });

    // A escolha da sessão vence o default do tenant.
    expect(result.current.period).toBe("last_90d");
  });
});
