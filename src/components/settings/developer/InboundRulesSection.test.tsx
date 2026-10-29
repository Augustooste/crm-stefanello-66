import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { useBoards } from "@/lib/api/boards";
import { useCanManageDeveloper } from "@/lib/api/developer";
import {
  InboundRuleApiError,
  useDeleteInboundRule,
  useInboundEventCounts24h,
  useInboundEvents,
  useInboundRules,
  useRotateInboundRuleSecret,
  useSetInboundRuleActive,
  useSetInboundRuleLimits,
  type InboundEvent,
  type InboundRule,
} from "@/lib/api/inbound-rules";
import { renderWithQueryClient } from "@/test/render";
import { InboundRulesSection } from "./InboundRulesSection";
import { fakeMutation, queryResult } from "./test-helpers";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  const { routerOverrides } = await import("@/test/router-mocks");
  return { ...actual, ...routerOverrides() };
});
vi.mock("@/lib/api/developer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/developer")>()),
  useCanManageDeveloper: vi.fn(),
}));
vi.mock("@/lib/api/inbound-rules", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/inbound-rules")>()),
  useInboundRules: vi.fn(),
  useInboundEventCounts24h: vi.fn(),
  useInboundEvents: vi.fn(),
  useSetInboundRuleActive: vi.fn(),
  useSetInboundRuleLimits: vi.fn(),
  useRotateInboundRuleSecret: vi.fn(),
  useDeleteInboundRule: vi.fn(),
  inboundWebhookUrl: (id: string) => `https://proj.supabase.co/functions/v1/inbound-webhook/${id}`,
}));
vi.mock("@/lib/api/boards", () => ({ useBoards: vi.fn() }));
// O assistente tem teste próprio; aqui só importa que abre.
vi.mock("./InboundRuleWizard", () => ({
  InboundRuleWizard: ({ open }: { open: boolean }) =>
    open ? <div role="dialog" aria-label="Assistente de regra" /> : null,
}));

const ROTATED = "whin_SEGREDO_ROTACIONADO";
const RULE: InboundRule = {
  id: "r1",
  tenantId: "t1",
  name: "Asaas pagamentos",
  active: true,
  disabledReason: null,
  verificationMode: "aceleraflow_hmac",
  tokenHeaderName: null,
  previousSecretExpiresAt: null,
  boardId: "b1",
  allowedStageIds: ["s-pago"],
  action: "move_stage",
  actionConfig: { to_stage_id: "s-pago" },
  matchField: "email",
  matchPath: "email",
  matchCustomFieldKey: null,
  eventIdPath: "id",
  conditions: [],
  notFoundMode: "ignore",
  maxActionsPerMinute: 30,
  maxActionsPerDay: 500,
  createdBy: null,
  createdAt: "2026-10-21T10:00:00Z",
  updatedAt: "2026-10-21T10:00:00Z",
  reactivatedAt: null,
  ignoredCount: 0,
  lastIgnoredAt: null,
  lastIgnoredReason: null,
};
const EVENT: InboundEvent = {
  id: "ev1",
  ruleId: "r1",
  externalEventId: "evt_1",
  status: "processed",
  attempts: 1,
  actionTaken: "move_stage",
  dealId: "d-ana",
  errorCode: null,
  extracted: { identifier: "ana@exemplo.com" },
  receivedAt: "2026-10-21T11:00:00Z",
  processedAt: "2026-10-21T11:00:01Z",
  duplicateCount: 0,
  lastDuplicateAt: null,
};

const spies = {
  rotate: vi.fn(async (_input: unknown) => ROTATED as string | null),
  rotateReset: vi.fn(),
  active: vi.fn(async (_input: unknown) => undefined),
  del: vi.fn(async (_id: string) => undefined),
  limits: vi.fn(async (_input: unknown) => undefined),
};

type Counts = ReturnType<typeof useInboundEventCounts24h>;
const COUNTS = queryResult({ byRule: { r1: { processed: 3, not_found: 1 } } });

function setup(
  rules: InboundRule[] | undefined,
  events: InboundEvent[] = [EVENT],
  allowed = true,
  counts: unknown = COUNTS,
  permissionLoading = false,
) {
  vi.mocked(useCanManageDeveloper).mockReturnValue({ allowed, isLoading: permissionLoading });
  vi.mocked(useInboundRules).mockReturnValue(
    queryResult(rules) as unknown as ReturnType<typeof useInboundRules>,
  );
  vi.mocked(useInboundEventCounts24h).mockReturnValue(counts as unknown as Counts);
  vi.mocked(useInboundEvents).mockReturnValue(
    queryResult(events) as unknown as ReturnType<typeof useInboundEvents>,
  );
  vi.mocked(useRotateInboundRuleSecret).mockImplementation(
    fakeMutation(spies.rotate, spies.rotateReset) as unknown as typeof useRotateInboundRuleSecret,
  );
  vi.mocked(useSetInboundRuleActive).mockImplementation(
    fakeMutation(spies.active) as unknown as typeof useSetInboundRuleActive,
  );
  vi.mocked(useSetInboundRuleLimits).mockImplementation(
    fakeMutation(spies.limits) as unknown as typeof useSetInboundRuleLimits,
  );
  vi.mocked(useDeleteInboundRule).mockImplementation(
    fakeMutation(spies.del) as unknown as typeof useDeleteInboundRule,
  );
  vi.mocked(useBoards).mockReturnValue(
    queryResult([
      { id: "b1", name: "Vendas", is_default: true, position: 0 },
    ]) as unknown as ReturnType<typeof useBoards>,
  );
  renderWithQueryClient(<InboundRulesSection />);
}

beforeEach(() => vi.clearAllMocks());

describe("InboundRulesSection", () => {
  it("enquanto a permissão carrega a seção não monta nem consulta dados", () => {
    setup([RULE], [], true, COUNTS, true);
    expect(screen.queryByRole("heading", { name: "Regras de entrada" })).toBeNull();
    expect(useInboundRules).not.toHaveBeenCalled();
    expect(useInboundEventCounts24h).not.toHaveBeenCalled();
  });

  it("contagem pendente mostra carregando, não zero eventos", () => {
    setup([RULE], [], true, queryResult(undefined));
    expect(screen.getByText("Carregando contagem…")).toBeInTheDocument();
    expect(screen.queryByText(/Nenhum evento nas últimas 24 h/)).toBeNull();
  });

  it("contagem agregada pela RPC mostra o total sem aviso de números parciais", () => {
    setup([RULE], [], true, queryResult({ byRule: { r1: { processed: 1500 } } }));
    expect(screen.getByText(/Processado: 1500/)).toBeInTheDocument();
    expect(screen.queryByText(/números parciais/)).toBeNull();
  });

  it("mostra os limites da regra e o contador de ignorados com motivo traduzido", () => {
    setup([
      {
        ...RULE,
        maxActionsPerMinute: 60,
        maxActionsPerDay: 2000,
        ignoredCount: 4,
        lastIgnoredAt: "2026-10-23T10:00:00Z",
        lastIgnoredReason: "missing_event_id",
      },
    ]);
    const row = screen.getByRole("listitem");
    expect(
      within(row).getByText(/Limites: 60 ações por minuto · 2000 por dia/),
    ).toBeInTheDocument();
    expect(within(row).getByText(/^4 ignorados \(último: evento sem id, /)).toBeInTheDocument();
  });

  it("sem ignorados não mostra o contador", () => {
    setup([RULE]);
    expect(screen.queryByText(/ignorados? \(último/)).toBeNull();
    expect(screen.queryByText("Ignorados antes do histórico")).toBeNull();
  });

  it("Limites abre o diálogo com os valores atuais, avisa do diário e salva", async () => {
    const user = userEvent.setup();
    setup([RULE]);
    await user.click(screen.getByRole("button", { name: /^Limites/ }));
    const dialog = await screen.findByRole("dialog", { name: "Limites da regra" });
    const minute = within(dialog).getByLabelText("Ações por minuto");
    const day = within(dialog).getByLabelText("Ações por dia (últimas 24 horas)");
    expect(minute).toHaveValue("30");
    expect(day).toHaveValue("500");
    expect(
      within(dialog).getByText(/igual ou menor que as ações das últimas 24 horas/),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/o reenvio depende do gateway/)).toBeInTheDocument();
    await user.clear(minute);
    await user.type(minute, "121");
    await user.click(within(dialog).getByRole("button", { name: "Salvar limites" }));
    expect(spies.limits).not.toHaveBeenCalled();
    expect(within(dialog).getByText(/de 1 a 120/)).toBeInTheDocument();
    await user.clear(minute);
    await user.type(minute, "120");
    await user.clear(day);
    await user.type(day, "5000");
    await user.click(within(dialog).getByRole("button", { name: "Salvar limites" }));
    expect(spies.limits).toHaveBeenCalledWith({ id: "r1", perMinute: 120, perDay: 5000 });
    expect(screen.queryByRole("dialog", { name: "Limites da regra" })).toBeNull();
  });

  it("erro de limite marca só o campo inválido e some ao digitar valor válido", async () => {
    const user = userEvent.setup();
    setup([RULE]);
    await user.click(screen.getByRole("button", { name: /^Limites/ }));
    const dialog = await screen.findByRole("dialog", { name: "Limites da regra" });
    const minute = within(dialog).getByLabelText("Ações por minuto");
    const day = within(dialog).getByLabelText("Ações por dia (últimas 24 horas)");
    expect(minute).not.toHaveAttribute("aria-invalid");
    await user.clear(minute);
    await user.type(minute, "121");
    await user.click(within(dialog).getByRole("button", { name: "Salvar limites" }));
    const minuteError = dialog.querySelector("#inbound-limit-minute-error");
    expect(minuteError).toHaveTextContent(/Ações por minuto: use um número inteiro de 1 a 120/);
    expect(minute).toHaveAttribute("aria-invalid", "true");
    expect(minute.getAttribute("aria-describedby")).toContain("inbound-limit-minute-error");
    expect(minute).toHaveFocus();
    expect(day).not.toHaveAttribute("aria-invalid");
    expect(day.getAttribute("aria-describedby")).not.toContain("error");
    expect(dialog.querySelector("#inbound-limit-day-error")).toBeNull();

    await user.clear(minute);
    await user.type(minute, "20");
    expect(minute).not.toHaveAttribute("aria-invalid");
    expect(minute.getAttribute("aria-describedby")).not.toContain("error");
    expect(dialog.querySelector("#inbound-limit-minute-error")).toBeNull();
    expect(spies.limits).not.toHaveBeenCalled();
  });

  it("dia inválido marca só o dia; os dois inválidos marcam os dois", async () => {
    const user = userEvent.setup();
    setup([RULE]);
    await user.click(screen.getByRole("button", { name: /^Limites/ }));
    const dialog = await screen.findByRole("dialog", { name: "Limites da regra" });
    const minute = within(dialog).getByLabelText("Ações por minuto");
    const day = within(dialog).getByLabelText("Ações por dia (últimas 24 horas)");
    await user.clear(day);
    await user.type(day, "0");
    await user.click(within(dialog).getByRole("button", { name: "Salvar limites" }));
    expect(day).toHaveAttribute("aria-invalid", "true");
    expect(day.getAttribute("aria-describedby")).toContain("inbound-limit-day-error");
    expect(minute).not.toHaveAttribute("aria-invalid");
    expect(day).toHaveFocus();
    await user.clear(minute);
    await user.type(minute, "abc");
    await user.click(within(dialog).getByRole("button", { name: "Salvar limites" }));
    expect(minute).toHaveAttribute("aria-invalid", "true");
    expect(day).toHaveAttribute("aria-invalid", "true");
    expect(spies.limits).not.toHaveBeenCalled();
  });

  it("enquanto salva, Cancelar fica desabilitado e Esc não fecha o diálogo", async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    spies.limits.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => (release = () => resolve(undefined))),
    );
    setup([RULE]);
    await user.click(screen.getByRole("button", { name: /^Limites/ }));
    const dialog = await screen.findByRole("dialog", { name: "Limites da regra" });
    await user.click(within(dialog).getByRole("button", { name: "Salvar limites" }));
    expect(within(dialog).getByRole("button", { name: "Cancelar" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Limites da regra" })).toBeInTheDocument();
    release();
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Limites da regra" })).toBeNull(),
    );
  });

  it("erro do banco ao salvar limites fica no diálogo, em português", async () => {
    const user = userEvent.setup();
    spies.limits.mockRejectedValueOnce(
      new InboundRuleApiError("42501", "permission denied") as never,
    );
    setup([RULE]);
    await user.click(screen.getByRole("button", { name: /^Limites/ }));
    const dialog = await screen.findByRole("dialog", { name: "Limites da regra" });
    await user.click(within(dialog).getByRole("button", { name: "Salvar limites" }));
    expect(
      await within(dialog).findByText("Você não tem permissão para gerenciar integrações."),
    ).toBeInTheDocument();
  });

  it("lista de regras pendente (perfil carregando) mostra carregando, não lista vazia", () => {
    setup(undefined);
    expect(
      screen.getByRole("status", { name: "Carregando regras de entrada" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Nenhuma regra de entrada")).toBeNull();
  });

  it("botão Ajuda e link da lista vazia levam à documentação de entrada", () => {
    setup([]);
    expect(screen.getByText("Nenhuma regra de entrada")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ajuda: regras de entrada" })).toHaveAttribute(
      "href",
      "/documentacao/webhooks#entrada",
    );
    expect(
      screen.getByRole("link", { name: "Como configurar Stripe, Asaas, Hotmart ou n8n" }),
    ).toHaveAttribute("href", "/documentacao/webhooks#entrada");
  });

  it("usuário sem permissão não vê a seção", () => {
    setup([RULE], [], false);
    expect(screen.queryByRole("heading", { name: "Regras de entrada" })).toBeNull();
    expect(useInboundRules).not.toHaveBeenCalled();
  });

  it("lista nome, funil, ação, ativo e a contagem de 24 h por status", () => {
    setup([RULE]);
    const row = screen.getByRole("listitem");
    expect(within(row).getByText("Asaas pagamentos")).toBeInTheDocument();
    expect(within(row).getByText(/Funil: Vendas/)).toBeInTheDocument();
    expect(within(row).getByText(/Mover de etapa/)).toBeInTheDocument();
    expect(within(row).getByText("Ativa")).toBeInTheDocument();
    expect(within(row).getByText(/Processado: 3/)).toBeInTheDocument();
    expect(within(row).getByText(/Não encontrado: 1/)).toBeInTheDocument();
  });

  it("copiar URL coloca a URL da regra na área de transferência", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    setup([RULE]);
    await user.click(screen.getByRole("button", { name: /Copiar URL/ }));
    expect(writeText).toHaveBeenCalledWith(
      "https://proj.supabase.co/functions/v1/inbound-webhook/r1",
    );
  });

  it("regra pausada por limite diário mostra o motivo e o aviso da fila do gateway", () => {
    setup([{ ...RULE, active: false, disabledReason: "daily_limit" }]);
    expect(screen.getByText("Pausada")).toBeInTheDocument();
    expect(
      screen.getByText(/pausada por limite diário; reative para voltar a aceitar/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Asaas: pausa a fila após 15 falhas/)).toBeInTheDocument();
    expect(screen.getByText(/Stripe: reenvia por até 3 dias/)).toBeInTheDocument();
    expect(screen.getByText(/Hotmart: pode desativar a configuração/)).toBeInTheDocument();
    expect(screen.queryByText(/reenvia quando (ela|a regra) volta/)).toBeNull();
  });

  it("rotação pede confirmação citando as 24 horas e o segredo não reaparece ao fechar", async () => {
    const user = userEvent.setup();
    setup([RULE]);
    await user.click(screen.getByRole("button", { name: /Rotacionar segredo/ }));
    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText(/continua válido por 24 horas/)).toBeInTheDocument();
    expect(spies.rotate).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole("button", { name: "Rotacionar" }));
    expect(spies.rotate).toHaveBeenCalledWith({ id: "r1", newSecret: null });
    expect(await screen.findByText(ROTATED)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Já guardei o segredo" }));
    expect(spies.rotateReset).toHaveBeenCalled();
    expect(screen.queryByText(ROTATED)).toBeNull();
  });

  it("rotação em modo externo pede o segredo novo e não abre a revelação", async () => {
    const user = userEvent.setup();
    spies.rotate.mockResolvedValueOnce(null);
    setup([{ ...RULE, verificationMode: "header_token", tokenHeaderName: "asaas-access-token" }]);
    await user.click(screen.getByRole("button", { name: /Rotacionar segredo/ }));
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: "Rotacionar" }));
    expect(spies.rotate).not.toHaveBeenCalled();
    await user.type(within(confirm).getByLabelText("Novo segredo do gateway"), "novo-token-123");
    await user.click(within(confirm).getByRole("button", { name: "Rotacionar" }));
    expect(spies.rotate).toHaveBeenCalledWith({ id: "r1", newSecret: "novo-token-123" });
    expect(screen.queryByRole("button", { name: "Já guardei o segredo" })).toBeNull();
  });

  it("histórico mostra status, ação e link para o negócio, sem payload", async () => {
    const user = userEvent.setup();
    setup([RULE]);
    await user.click(screen.getByRole("button", { name: /Histórico/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Processado")).toBeInTheDocument();
    expect(within(dialog).getByText(/Mover de etapa/)).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: /Abrir negócio/ })).toHaveAttribute(
      "href",
      "/pipeline",
    );
    expect(within(dialog).queryByText(/ana@exemplo.com/)).toBeNull();
  });

  it("histórico pagina de 50 em 50 até 200 linhas", async () => {
    const user = userEvent.setup();
    const page = Array.from({ length: 50 }, (_, i) => ({ ...EVENT, id: `ev${i}` }));
    setup([RULE], page);
    await user.click(screen.getByRole("button", { name: /Histórico/ }));
    const dialog = await screen.findByRole("dialog");
    for (let i = 0; i < 3; i += 1) {
      await user.click(within(dialog).getByRole("button", { name: "Carregar mais" }));
    }
    expect(within(dialog).queryByRole("button", { name: "Carregar mais" })).toBeNull();
    expect(within(dialog).getByText(/limite de 200 eventos/)).toBeInTheDocument();
    expect(vi.mocked(useInboundEvents).mock.calls.map((c) => c[1]?.offset)).toContain(150);
  });

  it("Nova regra abre o assistente", async () => {
    const user = userEvent.setup();
    setup([]);
    await user.click(screen.getAllByRole("button", { name: "Nova regra" })[0]);
    expect(screen.getByRole("dialog", { name: "Assistente de regra" })).toBeInTheDocument();
  });
});
