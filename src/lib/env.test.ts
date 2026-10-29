import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MissingEnvError,
  assertPublicSupabaseEnv,
  checkPublicSupabaseEnv,
  isMissingEnvError,
  toMissingEnvError,
} from "./env";

// Mesmos valores hardcoded em `FALLBACK_PUBLIC_SUPABASE_ENV` (src/lib/env.ts).
const FALLBACK_URL = "https://dpdtgddkvdgswndzuofv.supabase.co";
const FALLBACK_KEY = "sb_publishable_nbHDSIpyRbePTlV-XRepHw_-U4ps2-2";

/** Sempre stuba todas as vars (mesmo padrão de integrations/supabase/client.test.ts) — evita vazar `.env.local` real da máquina pro teste. */
function stubAllEnv(vars: {
  viteUrl?: string;
  viteKey?: string;
  serverUrl?: string;
  serverKey?: string;
  projectId?: string;
}) {
  vi.stubEnv("VITE_SUPABASE_URL", vars.viteUrl ?? "");
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", vars.viteKey ?? "");
  vi.stubEnv("SUPABASE_URL", vars.serverUrl ?? "");
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", vars.serverKey ?? "");
  vi.stubEnv("VITE_SUPABASE_PROJECT_ID", vars.projectId ?? "");
  vi.stubEnv("SUPABASE_PROJECT_ID", vars.projectId ?? "");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("MissingEnvError", () => {
  it("monta a mensagem com as variáveis ausentes e preserva `.missing`", () => {
    const error = new MissingEnvError(["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY"]);

    expect(error.name).toBe("MissingEnvError");
    expect(error.missing).toEqual(["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY"]);
    expect(error.message).toContain("SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY");
    expect(error.message).toContain("Conecte o Lovable Cloud");
  });

  it("aceita lista vazia de variáveis ausentes", () => {
    const error = new MissingEnvError([]);
    expect(error.missing).toEqual([]);
    expect(error.message).toContain("Variáveis de ambiente ausentes: .");
  });
});

describe("isMissingEnvError", () => {
  it("reconhece uma instância de MissingEnvError", () => {
    expect(isMissingEnvError(new MissingEnvError(["X"]))).toBe(true);
  });

  it("reconhece o erro cru lançado pelo client auto-gerado", () => {
    expect(isMissingEnvError(new Error("Missing Supabase environment variable(s): FOO"))).toBe(
      true,
    );
  });

  it("é case-insensitive ao checar o erro cru", () => {
    expect(isMissingEnvError(new Error("missing supabase environment VARIABLE: foo"))).toBe(true);
  });

  it("rejeita um Error qualquer sem relação com env vars", () => {
    expect(isMissingEnvError(new Error("network timeout"))).toBe(false);
  });

  it("rejeita valores que não são Error (string, null, undefined, número)", () => {
    expect(isMissingEnvError("erro qualquer")).toBe(false);
    expect(isMissingEnvError(null)).toBe(false);
    expect(isMissingEnvError(undefined)).toBe(false);
    expect(isMissingEnvError(42)).toBe(false);
  });
});

describe("toMissingEnvError", () => {
  it("retorna a mesma instância quando já é MissingEnvError", () => {
    const original = new MissingEnvError(["X"]);
    expect(toMissingEnvError(original)).toBe(original);
  });

  it("extrai a lista de variáveis do padrão 'variable(s): A, B.'", () => {
    const raw = new Error(
      "Missing Supabase environment variable(s): SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY.",
    );

    const converted = toMissingEnvError(raw);

    expect(converted).toBeInstanceOf(MissingEnvError);
    expect(converted.missing).toEqual(["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY"]);
  });

  it("retorna missing vazio quando o Error não bate com o padrão esperado", () => {
    const converted = toMissingEnvError(new Error("algo genérico deu errado"));
    expect(converted.missing).toEqual([]);
  });

  it("retorna missing vazio quando o valor lançado não é um Error", () => {
    expect(toMissingEnvError("string qualquer").missing).toEqual([]);
    expect(toMissingEnvError(null).missing).toEqual([]);
    expect(toMissingEnvError(undefined).missing).toEqual([]);
  });
});

describe("checkPublicSupabaseEnv", () => {
  it("usa as env vars VITE_* quando presentes, aplicando trim", () => {
    stubAllEnv({ viteUrl: "  https://tenant.example.co  ", viteKey: "  sb_publishable_abc  " });

    expect(checkPublicSupabaseEnv()).toEqual({
      ok: true,
      env: { url: "https://tenant.example.co", publishableKey: "sb_publishable_abc" },
    });
  });

  it("cai para process.env quando as VITE_* não estão definidas", () => {
    stubAllEnv({ serverUrl: "https://server.example.co", serverKey: "sb_publishable_server" });

    expect(checkPublicSupabaseEnv()).toEqual({
      ok: true,
      env: { url: "https://server.example.co", publishableKey: "sb_publishable_server" },
    });
  });

  it("cai para o fallback hardcoded quando nenhuma env var está definida", () => {
    stubAllEnv({});

    expect(checkPublicSupabaseEnv()).toEqual({
      ok: true,
      env: { url: FALLBACK_URL, publishableKey: FALLBACK_KEY },
    });
  });

  it("mantém o fallback quando o ambiente identifica ESTE projeto", () => {
    stubAllEnv({ projectId: "dpdtgddkvdgswndzuofv" });

    expect(checkPublicSupabaseEnv()).toEqual({
      ok: true,
      env: { url: FALLBACK_URL, publishableKey: FALLBACK_KEY },
    });
  });

  it("recusa o fallback num remix (outro projeto) em vez de apontar para o backend errado", () => {
    stubAllEnv({ projectId: "outroprojetoremixado" });

    expect(checkPublicSupabaseEnv()).toEqual({
      ok: false,
      missing: ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY"],
    });
  });

  it("num remix, usa as env vars do próprio projeto normalmente", () => {
    stubAllEnv({
      projectId: "outroprojetoremixado",
      viteUrl: "https://outroprojetoremixado.supabase.co",
      viteKey: "sb_publishable_remix",
    });

    expect(checkPublicSupabaseEnv()).toEqual({
      ok: true,
      env: {
        url: "https://outroprojetoremixado.supabase.co",
        publishableKey: "sb_publishable_remix",
      },
    });
  });

  it("detecta URL ausente quando a env var é só espaços em branco (passa no OR mas normaliza pra vazio)", () => {
    stubAllEnv({ viteUrl: "   ", viteKey: "sb_publishable_abc" });

    expect(checkPublicSupabaseEnv()).toEqual({ ok: false, missing: ["SUPABASE_URL"] });
  });

  it("detecta a publishable key ausente quando a env var é só espaços em branco", () => {
    stubAllEnv({ viteUrl: "https://tenant.example.co", viteKey: "   " });

    expect(checkPublicSupabaseEnv()).toEqual({
      ok: false,
      missing: ["SUPABASE_PUBLISHABLE_KEY"],
    });
  });

  it("reporta as duas variáveis ausentes quando ambas vêm em branco", () => {
    stubAllEnv({ viteUrl: "  ", viteKey: "  " });

    expect(checkPublicSupabaseEnv()).toEqual({
      ok: false,
      missing: ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY"],
    });
  });
});

describe("assertPublicSupabaseEnv", () => {
  it("retorna o env quando está tudo configurado", () => {
    stubAllEnv({ viteUrl: "https://tenant.example.co", viteKey: "sb_publishable_abc" });

    expect(assertPublicSupabaseEnv()).toEqual({
      url: "https://tenant.example.co",
      publishableKey: "sb_publishable_abc",
    });
  });

  it("lança MissingEnvError com as variáveis ausentes quando a env vem em branco", () => {
    stubAllEnv({ viteUrl: "   ", viteKey: "sb_publishable_abc" });

    expect(() => assertPublicSupabaseEnv()).toThrow(MissingEnvError);

    let caught: unknown;
    try {
      assertPublicSupabaseEnv();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MissingEnvError);
    expect((caught as MissingEnvError).missing).toEqual(["SUPABASE_URL"]);
  });
});
