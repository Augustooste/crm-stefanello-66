import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { useBoards } from "@/lib/api/boards";
import {
  useCreateInboundRule,
  usePreviewInboundRule,
  useUpdateInboundRule,
  type InboundPreview,
} from "@/lib/api/inbound-rules";
import { renderWithQueryClient } from "@/test/render";
import { useBoardStageKinds, useDealCustomFields } from "./inbound-rule-form";
import { InboundRuleWizard } from "./InboundRuleWizard";
import { fakeMutation, queryResult } from "./test-helpers";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api/inbound-rules", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/inbound-rules")>()),
  useCreateInboundRule: vi.fn(),
  useUpdateInboundRule: vi.fn(),
  usePreviewInboundRule: vi.fn(),
  inboundWebhookUrl: (id: string) => `https://proj.supabase.co/functions/v1/inbound-webhook/${id}`,
}));
vi.mock("@/lib/api/boards", () => ({ useBoards: vi.fn() }));
vi.mock("./inbound-rule-form", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./inbound-rule-form")>()),
  useBoardStageKinds: vi.fn(),
  useDealCustomFields: vi.fn(),
}));

const SECRET = "whin_SEGREDO_DE_TESTE";
const spies = {
  create: vi.fn(async (_input: unknown) => ({ id: "r-nova", secret: SECRET as string | null })),
  update: vi.fn(async (_input: unknown) => undefined),
  preview: vi.fn(async (_input: unknown): Promise<InboundPreview> => ({
    externalEventId: "evt_1",
    conditionsOk: true,
    identifier: "ana@exemplo.com",
    outcome: "ambiguous",
    dealId: null,
    dealTitle: null,
    fromStageId: null,
    targetStageId: "s-pago",
    reason: null,
    noteText: null,
  })),
};

let customFields = [{ key: "pedido", label: "Número do pedido" }];

beforeEach(() => {
  vi.clearAllMocks();
  customFields = [{ key: "pedido", label: "Número do pedido" }];
  vi.mocked(useCreateInboundRule).mockImplementation(
    fakeMutation(spies.create) as unknown as typeof useCreateInboundRule,
  );
  vi.mocked(useUpdateInboundRule).mockImplementation(
    fakeMutation(spies.update) as unknown as typeof useUpdateInboundRule,
  );
  vi.mocked(usePreviewInboundRule).mockImplementation(
    fakeMutation(spies.preview) as unknown as typeof usePreviewInboundRule,
  );
  vi.mocked(useBoards).mockReturnValue(
    queryResult([
      { id: "b1", name: "Vendas", is_default: true, position: 0 },
    ]) as unknown as ReturnType<typeof useBoards>,
  );
  vi.mocked(useBoardStageKinds).mockImplementation(
    (boardId) =>
      queryResult(
        boardId === "b1"
          ? [
              { id: "s-novo", name: "Novo", isWon: false, isLost: false },
              { id: "s-pago", name: "Pago", isWon: false, isLost: false },
              { id: "s-ganho", name: "Ganho", isWon: true, isLost: false },
              { id: "s-perdido", name: "Perdido", isWon: false, isLost: true },
            ]
          : undefined,
      ) as unknown as ReturnType<typeof useBoardStageKinds>,
  );
  vi.mocked(useDealCustomFields).mockImplementation(
    () => queryResult(customFields) as unknown as ReturnType<typeof useDealCustomFields>,
  );
});

type User = ReturnType<typeof userEvent.setup>;

function renderWizard() {
  const onOpenChange = vi.fn();
  const view = renderWithQueryClient(<InboundRuleWizard open onOpenChange={onOpenChange} />);
  // Como a seção faz: key nova a cada abertura, o componente é desmontado e montado de novo.
  const reopen = () => {
    view.rerender(<InboundRuleWizard key="segunda-abertura" open onOpenChange={onOpenChange} />);
  };
  return { onOpenChange, dialog: screen.getByRole("dialog"), reopen };
}

async function pick(user: User, combobox: string, option: string) {
  await user.click(screen.getByRole("combobox", { name: combobox }));
  await user.click(await screen.findByRole("option", { name: option }));
}

const next = (user: User) => user.click(screen.getByRole("button", { name: "Avançar" }));

async function fillStep1(user: User, preset?: string) {
  await user.type(screen.getByLabelText("Nome da regra"), "Pagamentos");
  await pick(user, "Funil", "Vendas");
  if (preset) await pick(user, "Modelo", preset);
  await next(user);
}

async function toActionStep(user: User) {
  await fillStep1(user);
  await next(user); // verificação HMAC
  await next(user); // identificação do modelo Personalizado
}

describe("InboundRuleWizard", () => {
  it("valida o passo 1 antes de avançar", async () => {
    const user = userEvent.setup();
    renderWizard();
    await next(user);
    expect(await screen.findByText(/Informe o nome da regra/)).toBeVisible();
    expect(screen.getByText("Passo 1 de 5: Modelo")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Nome da regra"), "Pagamentos");
    await next(user);
    expect(await screen.findByText("Escolha o funil da regra.")).toBeVisible();
  });

  it("Voltar retorna ao passo anterior mantendo os dados", async () => {
    const user = userEvent.setup();
    renderWizard();
    await fillStep1(user);
    expect(screen.getByText("Passo 2 de 5: Verificação")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Voltar" }));
    expect(screen.getByLabelText("Nome da regra")).toHaveValue("Pagamentos");
  });

  it("campo de segredo do gateway não aciona gerenciadores de senha", async () => {
    const user = userEvent.setup();
    renderWizard();
    await fillStep1(user, "Hotmart (compra aprovada)");
    const secret = screen.getByLabelText("Segredo do gateway");
    expect(secret).toHaveAttribute("type", "password");
    expect(secret).toHaveAttribute("autocomplete", "off");
    expect(secret).toHaveAttribute("data-1p-ignore");
    expect(secret).toHaveAttribute("data-lpignore", "true");
  });

  // Overflow real não é medível em jsdom: as classes são o contrato (grid do DialogContent
  // com coluna minmax(0,1fr) para o conteúdo não alargar a coluna a 390 px).
  it("diálogo do assistente tem coluna que encolhe (minmax(0,1fr))", () => {
    renderWizard();
    expect(screen.getByRole("dialog").className).toContain("grid-cols-[minmax(0,1fr)]");
  });

  it("header reservado bloqueia avançar", async () => {
    const user = userEvent.setup();
    renderWizard();
    await fillStep1(user, "Hotmart (compra aprovada)");
    const header = screen.getByLabelText("Nome do header do token");
    await user.clear(header);
    await user.type(header, "Authorization");
    await user.type(screen.getByLabelText("Segredo do gateway"), "token-da-hotmart");
    await next(user);
    expect(await screen.findByText(/Esse nome de header é reservado/)).toBeVisible();
    expect(screen.getByText("Passo 2 de 5: Verificação")).toBeInTheDocument();
  });

  it("preset Asaas exige escolher um campo personalizado do negócio", async () => {
    const user = userEvent.setup();
    renderWizard();
    await fillStep1(user, "Asaas (cobrança recebida)");
    await user.type(screen.getByLabelText("Segredo do gateway"), "token-do-asaas");
    await next(user);
    await next(user);
    expect(await screen.findByText(/Escolha o campo personalizado do negócio/)).toBeVisible();
    await pick(user, "Campo personalizado do negócio", "Número do pedido");
    await next(user);
    expect(screen.getByText("Passo 4 de 5: Ação")).toBeInTheDocument();
  });

  it("sem campo personalizado de negócio avisa e não deixa avançar", async () => {
    customFields = [];
    const user = userEvent.setup();
    renderWizard();
    await fillStep1(user, "Asaas (cobrança recebida)");
    await user.type(screen.getByLabelText("Segredo do gateway"), "token-do-asaas");
    await next(user);
    expect(screen.getAllByText(/Nenhum campo personalizado de negócio existe/)[0]).toBeVisible();
    await next(user);
    expect(screen.getByText("Passo 3 de 5: Identificação")).toBeInTheDocument();
  });

  it("destino fora das etapas permitidas não pode ser escolhido", async () => {
    const user = userEvent.setup();
    renderWizard();
    await toActionStep(user);
    await user.click(screen.getByRole("checkbox", { name: "Pago" }));
    await user.click(screen.getByRole("combobox", { name: "Etapa de destino" }));
    const listbox = await screen.findByRole("listbox");
    expect(within(listbox).getByRole("option", { name: "Pago" })).toBeInTheDocument();
    expect(within(listbox).queryByRole("option", { name: "Novo" })).toBeNull();
    expect(within(listbox).queryByRole("option", { name: "Ganho" })).toBeNull();
  });

  it("mark_lost sem motivo bloqueia avançar", async () => {
    const user = userEvent.setup();
    renderWizard();
    await toActionStep(user);
    await pick(user, "Ação", "Marcar como perdido");
    await user.click(screen.getByRole("checkbox", { name: "Perdido" }));
    await pick(user, "Etapa de destino", "Perdido");
    await next(user);
    expect(await screen.findByText(/Informe o motivo da perda/)).toBeVisible();
    expect(screen.getByText("Passo 4 de 5: Ação")).toBeInTheDocument();
  });

  it("bloqueia campo de segredo no modelo da nota", async () => {
    const user = userEvent.setup();
    renderWizard();
    await toActionStep(user);
    await pick(user, "Ação", "Registrar nota");
    await user.click(screen.getByRole("checkbox", { name: "Pago" }));
    await user.type(screen.getByLabelText("Texto da nota"), "Pago {{{{data.hottok}}");
    await next(user);
    expect(
      await screen.findByText(/Não use campos de segredo ou token \(data\.hottok\) na nota/),
    ).toBeVisible();
    expect(screen.getByText("Passo 4 de 5: Ação")).toBeInTheDocument();
    // O aviso preventivo fica visível ao lado do campo, antes de qualquer erro.
    expect(screen.getByText(/hottok, token, secret, signature, authorization/)).toBeVisible();
  });

  it("cria regra HMAC, mostra o segredo uma vez e testa com Mais de um negócio", async () => {
    const user = userEvent.setup();
    const { reopen } = renderWizard();
    await toActionStep(user);
    await user.click(screen.getByRole("checkbox", { name: "Pago" }));
    await pick(user, "Etapa de destino", "Pago");
    await next(user);
    expect(screen.getByText("Passo 5 de 5: Revisar e testar")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Testar" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Criar regra" }));
    expect(spies.create).toHaveBeenCalledWith(
      expect.objectContaining({
        verificationMode: "aceleraflow_hmac",
        secret: null,
        actionConfig: { to_stage_id: "s-pago" },
      }),
    );
    expect(await screen.findByText(SECRET)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Já guardei o segredo" }));
    expect(screen.queryByText(SECRET)).toBeNull();
    expect(
      screen.getByText("https://proj.supabase.co/functions/v1/inbound-webhook/r-nova"),
    ).toBeInTheDocument();

    const sample = screen.getByLabelText("JSON de exemplo");
    await user.clear(sample);
    await user.click(sample);
    await user.paste('{"id":"evt_1","email":"ana@exemplo.com"}');
    await user.click(screen.getByRole("button", { name: "Testar" }));
    expect(spies.preview).toHaveBeenCalledWith({
      ruleId: "r-nova",
      sample: { id: "evt_1", email: "ana@exemplo.com" },
    });
    expect(await screen.findByText("Mais de um negócio: nenhuma ação")).toBeVisible();
    expect(screen.getByText("Teste não altera nada")).toBeInTheDocument();
    expect(screen.queryByText(SECRET)).toBeNull();

    // Fechar e reabrir o assistente (remontagem com key nova) não traz o segredo de volta.
    reopen();
    expect(screen.getByText("Passo 1 de 5: Modelo")).toBeInTheDocument();
    expect(screen.getByLabelText("Nome da regra")).toHaveValue("");
    expect(screen.queryByText(SECRET)).toBeNull();
    expect(screen.queryByRole("button", { name: "Já guardei o segredo" })).toBeNull();
  });

  it("JSON inválido no teste mostra erro e não chama o preview", async () => {
    const user = userEvent.setup();
    renderWizard();
    await toActionStep(user);
    await user.click(screen.getByRole("checkbox", { name: "Pago" }));
    await pick(user, "Etapa de destino", "Pago");
    await next(user);
    await user.click(screen.getByRole("button", { name: "Criar regra" }));
    await user.click(await screen.findByRole("button", { name: "Já guardei o segredo" }));
    const sample = screen.getByLabelText("JSON de exemplo");
    await user.clear(sample);
    await user.type(sample, "nao e json");
    await user.click(screen.getByRole("button", { name: "Testar" }));
    expect(await screen.findByText(/JSON inválido/)).toBeVisible();
    expect(spies.preview).not.toHaveBeenCalled();
  });
  it("erro ao carregar campos personalizados mostra Tentar novamente, não acusa campo inexistente", async () => {
    const refetch = vi.fn();
    vi.mocked(useDealCustomFields).mockImplementation(
      () =>
        ({
          ...queryResult(undefined, { error: new Error("rede") }),
          refetch,
        }) as unknown as ReturnType<typeof useDealCustomFields>,
    );
    const user = userEvent.setup();
    renderWizard();
    await fillStep1(user, "Asaas (cobrança recebida)");
    await user.type(screen.getByLabelText("Segredo do gateway"), "token-do-asaas");
    await next(user);
    expect(screen.getByText("Não foi possível carregar os campos personalizados.")).toBeVisible();
    expect(screen.queryByText(/Nenhum campo personalizado de negócio existe/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(refetch).toHaveBeenCalled();
    await next(user);
    expect(await screen.findByText(/ainda não carregaram/)).toBeVisible();
    expect(screen.queryByText(/Nenhum campo personalizado de negócio existe/)).toBeNull();
  });

  it("campos personalizados pendentes (query desabilitada) mostram carregando, não vazio", async () => {
    vi.mocked(useDealCustomFields).mockImplementation(
      () => queryResult(undefined) as unknown as ReturnType<typeof useDealCustomFields>,
    );
    const user = userEvent.setup();
    renderWizard();
    await fillStep1(user, "Asaas (cobrança recebida)");
    await user.type(screen.getByLabelText("Segredo do gateway"), "token-do-asaas");
    await next(user);
    expect(screen.getByRole("status", { name: "Carregando campos personalizados" })).toBeVisible();
    expect(screen.queryByText(/Nenhum campo personalizado de negócio existe/)).toBeNull();
    await next(user);
    expect(await screen.findByText(/ainda não carregaram/)).toBeVisible();
  });

  it("erro ao carregar etapas mostra Tentar novamente e o motivo do bloqueio", async () => {
    const refetch = vi.fn();
    vi.mocked(useBoardStageKinds).mockImplementation(
      () =>
        ({
          ...queryResult(undefined, { error: new Error("rede") }),
          refetch,
        }) as unknown as ReturnType<typeof useBoardStageKinds>,
    );
    const user = userEvent.setup();
    renderWizard();
    await toActionStep(user);
    expect(screen.getByText("Não foi possível carregar as etapas do funil.")).toBeVisible();
    expect(screen.queryByText(/Marque uma etapa/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(refetch).toHaveBeenCalled();
  });

  it("condição alterna Igual a e Qualquer um de; resumo e envio mostram a lista", async () => {
    const user = userEvent.setup();
    renderWizard();
    await fillStep1(user, "Stripe: checkout concluído");
    await user.type(screen.getByLabelText("Segredo do gateway"), "whsec_teste_123");
    await next(user);
    // v2.2: preset Stripe traz id da sessão e e-mail alternativo.
    expect(screen.getByLabelText("Caminho do id do evento")).toHaveValue("data.object.id");
    expect(screen.getByLabelText("Caminho alternativo do identificador (opcional)")).toHaveValue(
      "data.object.customer_email",
    );
    expect(screen.getByRole("combobox", { name: "Tipo da condição 1" })).toHaveTextContent(
      "Qualquer um de",
    );
    expect(screen.getByLabelText("Valores da condição 1")).toHaveValue(
      "checkout.session.completed,checkout.session.async_payment_succeeded",
    );

    await pick(user, "Tipo da condição 1", "Igual a");
    expect(screen.queryByLabelText("Valores da condição 1")).toBeNull();
    expect(screen.getByLabelText("Valor da condição 1")).toHaveValue("checkout.session.completed");

    await pick(user, "Tipo da condição 1", "Qualquer um de");
    const values = screen.getByLabelText("Valores da condição 1");
    expect(values).toHaveValue("checkout.session.completed");
    await user.clear(values);
    await next(user);
    expect(await screen.findByText(/Condição 1: informe de 1 a 10 valores/)).toBeVisible();
    await user.click(values);
    await user.paste("checkout.session.completed, checkout.session.async_payment_succeeded");
    await next(user);
    await user.click(screen.getByRole("checkbox", { name: "Pago" }));
    await pick(user, "Etapa de destino", "Pago");
    await next(user);

    const summary = screen.getByLabelText("Resumo da regra").textContent ?? "";
    expect(summary).toContain(
      "type é um de: checkout.session.completed, checkout.session.async_payment_succeeded",
    );
    expect(summary).toContain("data.object.payment_status é um de: paid, no_payment_required");
    expect(summary).toContain("(alternativo: data.object.customer_email)");
    await user.click(screen.getByRole("button", { name: "Criar regra" }));
    expect(spies.create).toHaveBeenCalledWith(
      expect.objectContaining({
        eventIdPath: "data.object.id",
        actionConfig: expect.objectContaining({
          match_fallback_path: "data.object.customer_email",
        }),
        conditions: [
          {
            path: "type",
            in: ["checkout.session.completed", "checkout.session.async_payment_succeeded"],
          },
          { path: "data.object.payment_status", in: ["paid", "no_payment_required"] },
        ],
      }),
    );
    // Fluxo de 5 passos: sob carga da suíte inteira passa de 5 s (mesmo teto de AgentIntentionsTab).
  }, 15_000);

  it("caminho alternativo só aparece para e-mail e telefone", async () => {
    const user = userEvent.setup();
    renderWizard();
    await fillStep1(user);
    await next(user);
    expect(screen.getByLabelText("Caminho alternativo do identificador (opcional)")).toHaveValue(
      "",
    );
    await pick(user, "Identificar o negócio por", "Campo personalizado do negócio");
    expect(screen.queryByLabelText("Caminho alternativo do identificador (opcional)")).toBeNull();
    await pick(user, "Identificar o negócio por", "Telefone");
    expect(screen.getByLabelText("Caminho alternativo do identificador (opcional)")).toBeVisible();
  });

  it("condição com Igual a vazio bloqueia avançar", async () => {
    const user = userEvent.setup();
    renderWizard();
    await fillStep1(user);
    await next(user);
    await user.click(screen.getByRole("button", { name: "Adicionar condição" }));
    await user.type(screen.getByLabelText("Caminho da condição 1"), "type");
    await next(user);
    expect(await screen.findByText(/Condição 1: informe o valor de "Igual a"/)).toBeVisible();
    expect(screen.getByText("Passo 3 de 5: Identificação")).toBeInTheDocument();
  });

  it("caminho do identificador com nome de segredo bloqueia avançar", async () => {
    const user = userEvent.setup();
    renderWizard();
    await fillStep1(user);
    await next(user);
    const path = screen.getByLabelText("Caminho do identificador no evento");
    await user.clear(path);
    await user.type(path, "data.hottok");
    await next(user);
    expect(
      await screen.findByText(
        /Não use campos de segredo ou token \(data\.hottok\) no identificador/,
      ),
    ).toBeVisible();
  });

  it("amostra que não é objeto JSON é recusada sem chamar o preview", async () => {
    const user = userEvent.setup();
    renderWizard();
    await toActionStep(user);
    await user.click(screen.getByRole("checkbox", { name: "Pago" }));
    await pick(user, "Etapa de destino", "Pago");
    await next(user);
    await user.click(screen.getByRole("button", { name: "Criar regra" }));
    await user.click(await screen.findByRole("button", { name: "Já guardei o segredo" }));
    const sample = screen.getByLabelText("JSON de exemplo");
    await user.click(sample);
    await user.paste('[{"id":"evt_1"}]');
    await user.click(screen.getByRole("button", { name: "Testar" }));
    expect(await screen.findByText(/precisa ser um objeto JSON/)).toBeVisible();
    expect(spies.preview).not.toHaveBeenCalled();
  });
});
