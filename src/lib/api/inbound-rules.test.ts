import { createElement, type ReactNode } from "react";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  InboundRuleApiError,
  inboundWebhookUrl,
  MAX_LIMIT_PER_DAY,
  MAX_LIMIT_PER_MINUTE,
  useCreateInboundRule,
  useDeleteInboundRule,
  useInboundEventCounts24h,
  useInboundEvents,
  useInboundRule,
  useInboundRules,
  usePreviewInboundRule,
  useRotateInboundRuleSecret,
  useSetInboundRuleActive,
  useSetInboundRuleLimits,
  useUpdateInboundRule,
  type CreateInboundRuleInput,
} from "./inbound-rules";
import { DeveloperApiError } from "./developer";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile, type CurrentProfile } from "@/lib/api/session";
import { createChain } from "@/test/query-mocks";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));
vi.mock("@/lib/api/session", () => ({ useCurrentProfile: vi.fn() }));

const SECRET = "whin_segredo_super_secreto_123";
const PASTED = "whsec_colado_pelo_admin_456";
const rpcMock = vi.mocked(supabase.rpc) as unknown as ReturnType<typeof vi.fn>;
const fromMock = vi.mocked(supabase.from) as unknown as ReturnType<typeof vi.fn>;

// --- assinaturas REAIS das RPCs, lidas das migrations (lição C1: mock não esconde parâmetro) ---

const MIGRATIONS_DIR = resolve(process.cwd(), "supabase/migrations");
const RPC_NAMES = [
  "create_inbound_rule",
  "update_inbound_rule",
  "set_inbound_rule_active",
  "rotate_inbound_rule_secret",
  "delete_inbound_rule",
  "preview_inbound_rule",
  "set_inbound_rule_limits",
  "inbound_rule_stats_tenant",
] as const;

/** Migrations das regras de entrada: v2 (20261021*), v2.1 (20261022*) e v2.2 (20261023*). */
function inboundMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^2026102[123].*\.sql$/.test(f))
    .sort()
    .map((f) => readFileSync(resolve(MIGRATIONS_DIR, f), "utf8"));
}

/** Colunas de inbound_events com SELECT para authenticated (grant por coluna). */
function grantedEventColumns(): Set<string> {
  const out = new Set<string>();
  for (const sql of inboundMigrations()) {
    const re = /grant select \(([^)]*)\)\s*on public\.inbound_events to authenticated/g;
    for (const m of sql.matchAll(re)) for (const c of m[1].split(",")) out.add(c.trim());
  }
  return out;
}

/** Colunas de inbound_rules com SELECT para authenticated (grant por coluna). */
function grantedRuleColumns(): Set<string> {
  const out = new Set<string>();
  for (const sql of inboundMigrations()) {
    const re = /grant select \(([^)]*)\)\s*on public\.inbound_rules to authenticated/g;
    for (const m of sql.matchAll(re)) for (const c of m[1].split(",")) out.add(c.trim());
  }
  return out;
}

function loadRealSignatures(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const sql of inboundMigrations()) {
    for (const m of sql.matchAll(/create or replace function public\.(\w+)\s*\(([^)]*)\)/g)) {
      if (!(RPC_NAMES as readonly string[]).includes(m[1])) continue;
      // migration posterior redefine a função: a última vence
      out[m[1]] = m[2]
        .split(",")
        .map((p) => p.trim().split(/\s+/)[0])
        .filter(Boolean);
    }
  }
  return out;
}

const SIGNATURES = loadRealSignatures();

/** Falha como o PostgREST: função inexistente para o conjunto exato de nomes. */
function strictRpc(fn: string, args: Record<string, unknown> = {}, data: unknown = null) {
  const expected = SIGNATURES[fn];
  if (!expected) {
    return { data: null, error: { code: "PGRST202", message: `função desconhecida ${fn}` } };
  }
  const given = Object.keys(args).sort();
  if (JSON.stringify(given) !== JSON.stringify([...expected].sort())) {
    return {
      data: null,
      error: { code: "PGRST202", message: `Could not find the function ${fn}(${given.join(",")})` },
    };
  }
  return { data, error: null };
}

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

function mockProfile(tenantId: string | null) {
  const profile: CurrentProfile | null = tenantId
    ? { id: "u1", tenant_id: tenantId, name: "Ana", role: "admin" }
    : null;
  vi.mocked(useCurrentProfile).mockReturnValue({
    data: profile,
  } as unknown as ReturnType<typeof useCurrentProfile>);
}

function withRange<T>(chain: T) {
  const c = chain as T & { range: ReturnType<typeof vi.fn>; gte: ReturnType<typeof vi.fn> };
  c.range = vi.fn(() => c);
  c.gte = vi.fn(() => c);
  return c;
}

const BASE_INPUT = {
  name: "Pagamento Asaas",
  boardId: "b1",
  allowedStageIds: ["s1", "s2"],
  action: "mark_won" as const,
  actionConfig: { to_stage_id: "s2" },
  matchField: "email" as const,
  matchPath: "payment.customer.email",
  eventIdPath: "id",
  conditions: [{ path: "event", equals: "PAYMENT_RECEIVED" }],
  notFoundMode: "ignore" as const,
};

const CREATE_INPUT: CreateInboundRuleInput = {
  ...BASE_INPUT,
  verificationMode: "aceleraflow_hmac",
};

/** Mutations de RPC: nome, chamada com a entrada válida e retorno do banco. */
const RPC_CASES = [
  {
    fn: "create_inbound_rule",
    hook: useCreateInboundRule,
    input: CREATE_INPUT,
    dbData: [{ id: "r1", secret: SECRET }],
  },
  {
    fn: "update_inbound_rule",
    hook: useUpdateInboundRule,
    input: { ...BASE_INPUT, id: "r1" },
    dbData: null,
  },
  {
    fn: "set_inbound_rule_active",
    hook: useSetInboundRuleActive,
    input: { id: "r1", active: false },
    dbData: null,
  },
  {
    fn: "rotate_inbound_rule_secret",
    hook: useRotateInboundRuleSecret,
    input: { id: "r1" },
    dbData: SECRET,
  },
  { fn: "delete_inbound_rule", hook: useDeleteInboundRule, input: "r1", dbData: null },
  {
    fn: "preview_inbound_rule",
    hook: usePreviewInboundRule,
    input: { ruleId: "r1", sample: { id: "e1" } },
    dbData: [{ outcome: "act" }],
  },
  {
    fn: "set_inbound_rule_limits",
    hook: useSetInboundRuleLimits,
    input: { id: "r1", perMinute: 60, perDay: 1000 },
    dbData: null,
  },
] as const;

describe("inbound-rules: contrato com as migrations", () => {
  it("as migrations expõem as 8 RPCs esperadas", () => {
    expect(Object.keys(SIGNATURES).sort()).toEqual([...RPC_NAMES].sort());
    expect(SIGNATURES.set_inbound_rule_limits).toEqual(["p_id", "p_per_minute", "p_per_day"]);
    expect(SIGNATURES.inbound_rule_stats_tenant).toEqual([]);
    expect(SIGNATURES.create_inbound_rule).toHaveLength(14);
    expect(SIGNATURES.update_inbound_rule).toHaveLength(13);
  });

  it("o mock estrito recusa parametro extra e parametro ausente", () => {
    const ok = Object.fromEntries(SIGNATURES.delete_inbound_rule.map((p) => [p, "x"]));
    expect(strictRpc("delete_inbound_rule", ok).error).toBeNull();
    expect(strictRpc("delete_inbound_rule", { ...ok, p_extra: 1 }).error?.code).toBe("PGRST202");
    expect(strictRpc("delete_inbound_rule", {}).error?.code).toBe("PGRST202");
  });

  it("v2.1: a migration dá grant de duplicate_count e last_duplicate_at (e nada de segredo)", () => {
    const granted = grantedEventColumns();
    expect(granted.has("duplicate_count")).toBe(true);
    expect(granted.has("last_duplicate_at")).toBe(true);
    expect(granted.has("external_event_id")).toBe(true);
  });

  it("v2.2: toda coluna lida da regra tem grant (inclui ignored_count e companhia)", () => {
    const granted = grantedRuleColumns();
    const source = readFileSync(resolve(process.cwd(), "src/lib/api/inbound-rules.ts"), "utf8");
    const cols = /const RULE_COLUMNS =\s*"([^"]+)"/
      .exec(source)?.[1]
      .split(",")
      .map((c) => c.trim());
    expect(cols).toEqual(
      expect.arrayContaining(["ignored_count", "last_ignored_at", "last_ignored_reason"]),
    );
    expect((cols ?? []).filter((c) => !granted.has(c))).toEqual([]);
  });
});

describe("inbound-rules hooks", () => {
  beforeEach(() => {
    mockProfile("t1");
    rpcMock.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
      const row = RPC_CASES.find((c) => c.fn === fn);
      return strictRpc(fn, args, row?.dbData);
    });
    fromMock.mockReturnValue(withRange(createChain({ data: [], error: null })));
  });
  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
  });

  it.each(RPC_CASES)("$fn envia exatamente os parametros da migration", async (c) => {
    const { result } = renderHook(() => c.hook(), { wrapper: makeWrapper(makeClient()) });
    await act(async () => {
      await (result.current.mutateAsync as (i: unknown) => Promise<unknown>)(c.input);
    });
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock.mock.calls[0][0]).toBe(c.fn);
    expect(Object.keys(rpcMock.mock.calls[0][1] as object).sort()).toEqual(
      [...SIGNATURES[c.fn]].sort(),
    );
  });

  it("create envia todos os valores nos parametros certos", async () => {
    const { result } = renderHook(() => useCreateInboundRule(), {
      wrapper: makeWrapper(makeClient()),
    });
    await act(async () => {
      await result.current.mutateAsync({
        ...CREATE_INPUT,
        verificationMode: "header_token",
        tokenHeaderName: "asaas-access-token",
        secret: PASTED,
        customFieldKey: null,
      });
    });
    expect(rpcMock).toHaveBeenCalledWith("create_inbound_rule", {
      p_name: "Pagamento Asaas",
      p_verification_mode: "header_token",
      p_token_header_name: "asaas-access-token",
      p_secret: PASTED,
      p_board_id: "b1",
      p_allowed_stage_ids: ["s1", "s2"],
      p_action: "mark_won",
      p_action_config: { to_stage_id: "s2" },
      p_match_field: "email",
      p_match_path: "payment.customer.email",
      p_custom_field_key: null,
      p_event_id_path: "id",
      p_conditions: [{ path: "event", equals: "PAYMENT_RECEIVED" }],
      p_not_found_mode: "ignore",
    });
  });

  it("segredo HMAC so no retorno do create, com gcTime 0 e fora do cache", async () => {
    const client = makeClient();
    const { result, unmount } = renderHook(() => useCreateInboundRule(), {
      wrapper: makeWrapper(client),
    });
    let out: { id: string; secret: string | null } | undefined;
    await act(async () => {
      out = await result.current.mutateAsync(CREATE_INPUT);
    });
    expect(out).toEqual({ id: "r1", secret: SECRET });
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain(SECRET);
    unmount();
    await waitFor(() => expect(client.getMutationCache().getAll()).toHaveLength(0));
  });

  it("create em modo externo devolve secret null (segredo colado nunca volta)", async () => {
    rpcMock.mockImplementation(async (fn: string, args: Record<string, unknown>) =>
      strictRpc(fn, args, [{ id: "r2", secret: null }]),
    );
    const { result } = renderHook(() => useCreateInboundRule(), {
      wrapper: makeWrapper(makeClient()),
    });
    let out: { id: string; secret: string | null } | undefined;
    await act(async () => {
      out = await result.current.mutateAsync({
        ...CREATE_INPUT,
        verificationMode: "stripe_signature",
        secret: PASTED,
      });
    });
    expect(out).toEqual({ id: "r2", secret: null });
  });

  it("rotate: HMAC devolve o segredo novo, modo externo devolve null, gcTime 0", async () => {
    const client = makeClient();
    const hmac = renderHook(() => useRotateInboundRuleSecret(), { wrapper: makeWrapper(client) });
    await act(async () => {
      expect(await hmac.result.current.mutateAsync({ id: "r1" })).toBe(SECRET);
    });
    hmac.unmount();
    await waitFor(() => expect(client.getMutationCache().getAll()).toHaveLength(0));

    rpcMock.mockImplementation(async (fn: string, args: Record<string, unknown>) =>
      strictRpc(fn, args, null),
    );
    const ext = renderHook(() => useRotateInboundRuleSecret(), {
      wrapper: makeWrapper(makeClient()),
    });
    await act(async () => {
      expect(await ext.result.current.mutateAsync({ id: "r1", newSecret: PASTED })).toBeNull();
    });
    expect(rpcMock).toHaveBeenLastCalledWith("rotate_inbound_rule_secret", {
      p_id: "r1",
      p_new_secret: PASTED,
    });
  });

  it("rotate rejeita resposta que nao e texto nem null", async () => {
    rpcMock.mockImplementation(async (fn: string, args: Record<string, unknown>) =>
      strictRpc(fn, args, { x: 1 }),
    );
    const { result } = renderHook(() => useRotateInboundRuleSecret(), {
      wrapper: makeWrapper(makeClient()),
    });
    await act(async () => {
      const err: unknown = await result.current.mutateAsync({ id: "r1" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InboundRuleApiError);
    });
  });

  it("preview mapeia o plano para camelCase", async () => {
    rpcMock.mockImplementation(async (fn: string, args: Record<string, unknown>) =>
      strictRpc(fn, args, {
        external_event_id: "e1",
        conditions_ok: true,
        identifier: "a@b.com",
        outcome: "ambiguous",
        deal_id: null,
        deal_title: null,
        from_stage_id: null,
        target_stage_id: "s2",
        reason: null,
        note_text: null,
      }),
    );
    const { result } = renderHook(() => usePreviewInboundRule(), {
      wrapper: makeWrapper(makeClient()),
    });
    await act(async () => {
      const out = await result.current.mutateAsync({ ruleId: "r1", sample: { id: "e1" } });
      expect(out).toMatchObject({
        externalEventId: "e1",
        conditionsOk: true,
        identifier: "a@b.com",
        outcome: "ambiguous",
        targetStageId: "s2",
      });
    });
  });

  it.each([
    ["42501", "permission denied", "Você não tem permissão para gerenciar integrações."],
    ["P0002", "regra nao encontrada", "Regra não encontrada."],
    [
      "54000",
      "limite de 20 regras de entrada por tenant",
      "Limite atingido: até 20 regras de entrada por workspace.",
    ],
    ["22023", "funil invalido", "Funil inválido para este workspace."],
    [
      "22023",
      "etapas invalidas",
      "Etapas inválidas: escolha de 1 a 20 etapas do funil selecionado.",
    ],
    ["22023", "destino invalido", "Etapa de destino inválida para esta ação."],
    ["22023", "motivo obrigatorio", "Informe o motivo da perda (caminho no evento ou texto fixo)."],
    [
      "22023",
      "header do token reservado: escolha outro nome (ex.: asaas-access-token)",
      "Esse nome de header é reservado. Escolha outro (ex.: asaas-access-token).",
    ],
    [
      "22023",
      "segredo invalido (8 a 512 caracteres)",
      "Segredo inválido: use de 8 a 512 caracteres.",
    ],
    [
      "22023",
      "condicao invalida: use exatamente um de equals ou in",
      'Condição inválida: use "Igual a" ou "Qualquer um de", não os dois.',
    ],
    [
      "22023",
      "condicao invalida: in deve ser lista de 1 a 10 textos nao vazios (ate 200 caracteres cada)",
      'Condição inválida: "Qualquer um de" aceita de 1 a 10 valores não vazios, com até 200 caracteres cada.',
    ],
    ["22023", "mensagem nova desconhecida", "Dados inválidos. Confira os campos da regra."],
    ["XX000", "boom", "Não foi possível concluir a operação. Tente novamente."],
    [undefined, "boom", "Não foi possível concluir a operação. Tente novamente."],
  ])("codigo %s / '%s' vira mensagem em portugues", async (code, original, message) => {
    rpcMock.mockResolvedValue({ data: null, error: { message: original, code } });
    const { result } = renderHook(() => useDeleteInboundRule(), {
      wrapper: makeWrapper(makeClient()),
    });
    await act(async () => {
      const err: unknown = await result.current.mutateAsync("r1").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InboundRuleApiError);
      expect(err).toBeInstanceOf(DeveloperApiError);
      expect(err).toMatchObject({ code: code ?? null, message });
    });
  });

  it("mensagem ao usuario nunca carrega texto cru do Postgres", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: `detalhe ${SECRET}`, code: "XX000" },
    });
    const { result } = renderHook(() => useDeleteInboundRule(), {
      wrapper: makeWrapper(makeClient()),
    });
    await act(async () => {
      const err = (await result.current.mutateAsync("r1").catch((e: unknown) => e)) as Error;
      expect(err.message).not.toContain(SECRET);
    });
  });

  it("inboundWebhookUrl monta <SUPABASE_URL>/functions/v1/inbound-webhook/<id>", () => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://abc.supabase.co/");
    expect(inboundWebhookUrl("11111111-2222-3333-4444-555555555555")).toBe(
      "https://abc.supabase.co/functions/v1/inbound-webhook/11111111-2222-3333-4444-555555555555",
    );
  });

  it("listagens usam so colunas com grant, mapeiam camelCase e nunca vault", async () => {
    const chain = withRange(
      createChain({
        data: [
          {
            id: "r1",
            tenant_id: "t1",
            name: "A",
            active: true,
            disabled_reason: null,
            verification_mode: "header_token",
            token_header_name: "asaas-access-token",
            previous_secret_expires_at: null,
            board_id: "b1",
            allowed_stage_ids: ["s1"],
            action: "mark_won",
            action_config: {},
            match_field: "email",
            match_path: "a.b",
            match_custom_field_key: null,
            event_id_path: "id",
            conditions: [],
            not_found_mode: "ignore",
            max_actions_per_minute: 30,
            max_actions_per_day: 500,
            created_by: null,
            created_at: "2026-10-21",
            updated_at: "2026-10-21",
            reactivated_at: null,
          },
        ],
        error: null,
      }),
    );
    fromMock.mockReturnValue(chain);
    const client = makeClient();
    const list = renderHook(() => useInboundRules(), { wrapper: makeWrapper(client) });
    renderHook(() => useInboundEvents("r1"), { wrapper: makeWrapper(client) });
    renderHook(() => useInboundRule("r1"), { wrapper: makeWrapper(client) });
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true));
    expect(list.result.current.data?.[0]).toMatchObject({
      tenantId: "t1",
      verificationMode: "header_token",
      tokenHeaderName: "asaas-access-token",
      matchCustomFieldKey: null,
      reactivatedAt: null,
    });
    await waitFor(() => expect(chain.select).toHaveBeenCalledTimes(3));
    for (const call of vi.mocked(chain.select).mock.calls) {
      const cols = String(call[0]);
      expect(cols).not.toContain("*");
      expect(cols).not.toContain("vault_secret_id");
    }
  });

  it("erro do banco na listagem sobe, nao vira lista vazia", async () => {
    fromMock.mockReturnValue(
      withRange(
        createChain({ data: null, error: { message: "permission denied", code: "42501" } }),
      ),
    );
    const { result } = renderHook(() => useInboundRules(), { wrapper: makeWrapper(makeClient()) });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({
      code: "42501",
      message: "Você não tem permissão para gerenciar integrações.",
    });
  });

  it("historico: pagina de 50, teto de 200 linhas, filtro por status", async () => {
    const chain = withRange(createChain({ data: [], error: null }));
    fromMock.mockReturnValue(chain);
    const client = makeClient();
    renderHook(() => useInboundEvents("r1", { status: "failed", offset: 9999 }), {
      wrapper: makeWrapper(client),
    });
    await waitFor(() => expect(chain.range).toHaveBeenCalled());
    // offset travado em 150: a última página termina na linha 200
    expect(chain.range).toHaveBeenCalledWith(150, 199);
    expect(chain.eq).toHaveBeenCalledWith("rule_id", "r1");
    expect(chain.eq).toHaveBeenCalledWith("status", "failed");
    renderHook(() => useInboundEvents("r2"), { wrapper: makeWrapper(client) });
    await waitFor(() => expect(chain.range).toHaveBeenCalledWith(0, 49));
  });

  it("historico v2.1: seleciona só colunas com grant e mapeia reenvios", async () => {
    const chain = withRange(
      createChain({
        data: [
          {
            id: "e1",
            rule_id: "r1",
            external_event_id: "evt_1",
            status: "processed",
            attempts: 1,
            action_taken: "mark_won",
            deal_id: "d1",
            error_code: null,
            extracted: null,
            received_at: "2026-10-22T10:00:00Z",
            processed_at: "2026-10-22T10:00:01Z",
            duplicate_count: 3,
            last_duplicate_at: "2026-10-22T11:00:00Z",
          },
        ],
        error: null,
      }),
    );
    fromMock.mockReturnValue(chain);
    const { result } = renderHook(() => useInboundEvents("r1"), {
      wrapper: makeWrapper(makeClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.[0]).toMatchObject({
      duplicateCount: 3,
      lastDuplicateAt: "2026-10-22T11:00:00Z",
    });
    const cols = String(vi.mocked(chain.select).mock.calls[0][0])
      .split(",")
      .map((c) => c.trim());
    expect(cols).toEqual(expect.arrayContaining(["duplicate_count", "last_duplicate_at"]));
    const granted = grantedEventColumns();
    expect(cols.filter((c) => !granted.has(c))).toEqual([]);
  });

  it("contagem de 24 h: uma RPC do tenant, soma total (bigint em texto) por regra e status", async () => {
    rpcMock.mockImplementation(async (fn: string, args: Record<string, unknown>) =>
      strictRpc(fn, args, [
        { rule_id: "r1", status: "processed", total: "1500" },
        { rule_id: "r1", status: "failed", total: 1 },
        { rule_id: "r2", status: "ambiguous", total: 2 },
      ]),
    );
    const { result } = renderHook(() => useInboundEventCounts24h(), {
      wrapper: makeWrapper(makeClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // Sem teto de 1000 linhas: o número vem agregado do banco.
    expect(result.current.data).toEqual({
      byRule: { r1: { processed: 1500, failed: 1 }, r2: { ambiguous: 2 } },
    });
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith("inbound_rule_stats_tenant", {});
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("contagem de 24 h: erro do Postgres sobe, não vira zero", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: "permission denied", code: "42501" },
    });
    const { result } = renderHook(() => useInboundEventCounts24h(), {
      wrapper: makeWrapper(makeClient()),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ code: "42501" });
  });

  it("ativar/pausar: envia p_active e invalida as queries da regra", async () => {
    const client = makeClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useSetInboundRuleActive(), {
      wrapper: makeWrapper(client),
    });
    await act(async () => {
      await result.current.mutateAsync({ id: "r1", active: true });
    });
    expect(rpcMock).toHaveBeenCalledWith("set_inbound_rule_active", {
      p_id: "r1",
      p_active: true,
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["inbound-rules", "t1"] });
  });

  it("limites: envia os valores e invalida as queries da regra", async () => {
    const client = makeClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useSetInboundRuleLimits(), {
      wrapper: makeWrapper(client),
    });
    await act(async () => {
      await result.current.mutateAsync({ id: "r1", perMinute: 120, perDay: 5000 });
    });
    expect(rpcMock).toHaveBeenCalledWith("set_inbound_rule_limits", {
      p_id: "r1",
      p_per_minute: 120,
      p_per_day: 5000,
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["inbound-rules", "t1"] });
  });

  it.each([
    [
      "22023",
      "limite por minuto invalido",
      `Limite por minuto inválido: use um número inteiro de 1 a ${MAX_LIMIT_PER_MINUTE}.`,
    ],
    [
      "22023",
      "limite diario invalido",
      `Limite diário inválido: use um número inteiro de 1 a ${MAX_LIMIT_PER_DAY}.`,
    ],
    ["42501", "permission denied", "Você não tem permissão para gerenciar integrações."],
    ["P0002", "regra nao encontrada", "Regra não encontrada."],
  ])("limites: %s / '%s' vira mensagem em portugues", async (code, original, message) => {
    rpcMock.mockResolvedValue({ data: null, error: { message: original, code } });
    const { result } = renderHook(() => useSetInboundRuleLimits(), {
      wrapper: makeWrapper(makeClient()),
    });
    await act(async () => {
      const err: unknown = await result.current
        .mutateAsync({ id: "r1", perMinute: 1, perDay: 1 })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InboundRuleApiError);
      expect(err).toMatchObject({ code, message });
    });
  });

  it("caminho alternativo invalido (22023) tem mensagem própria", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: "caminho alternativo invalido", code: "22023" },
    });
    const { result } = renderHook(() => useUpdateInboundRule(), {
      wrapper: makeWrapper(makeClient()),
    });
    await act(async () => {
      const err = (await result.current
        .mutateAsync({ ...BASE_INPUT, id: "r1" })
        .catch((e: unknown) => e)) as Error;
      expect(err.message).toMatch(/^Caminho alternativo inválido/);
    });
  });

  it("listagem mapeia o contador de ignorados (v2.2)", async () => {
    const chain = withRange(
      createChain({
        data: [
          {
            id: "r1",
            ignored_count: 4,
            last_ignored_at: "2026-10-23T10:00:00Z",
            last_ignored_reason: "missing_event_id",
          },
        ],
        error: null,
      }),
    );
    fromMock.mockReturnValue(chain);
    const { result } = renderHook(() => useInboundRules(), { wrapper: makeWrapper(makeClient()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.[0]).toMatchObject({
      ignoredCount: 4,
      lastIgnoredAt: "2026-10-23T10:00:00Z",
      lastIgnoredReason: "missing_event_id",
    });
    const cols = String(vi.mocked(chain.select).mock.calls[0][0])
      .split(",")
      .map((c) => c.trim());
    expect(cols).toEqual(
      expect.arrayContaining(["ignored_count", "last_ignored_at", "last_ignored_reason"]),
    );
  });
});
