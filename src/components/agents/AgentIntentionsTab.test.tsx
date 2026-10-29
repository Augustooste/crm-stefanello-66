import { act } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";

import { useAgentPlatformMutation, useAgentPlatformQuery } from "@/lib/api/agent-platform";
import type { AgentPlatformIntention } from "@/lib/api/agent-platform-contract";
import { AgentIntentionsTab } from "./AgentIntentionsTab";

vi.mock("@/lib/api/agent-platform", () => ({
  useAgentPlatformQuery: vi.fn(),
  useAgentPlatformMutation: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const queryMock = vi.mocked(useAgentPlatformQuery);
const mutationMock = vi.mocked(useAgentPlatformMutation);

const AGENT_ID = "agent-1";

const SECRET_HEADER_VALUE = "Bearer super-secret-123";

const SAMPLE_INTENTION: AgentPlatformIntention = {
  id: "int-1",
  description: "Agendar demonstração",
  type: "WEBHOOK",
  httpMethod: "POST",
  url: "https://api.exemplo.com/agendar",
  autoGenerateParams: false,
  autoGenerateBody: false,
  headers: [{ name: "Authorization", value: SECRET_HEADER_VALUE }],
  params: [],
  fields: [],
  variables: [],
};

function mockList(data: AgentPlatformIntention[] = []) {
  queryMock.mockReturnValue({
    data,
    isPending: false,
    isError: false,
    error: null,
    isFetching: false,
    refetch: vi.fn(),
  } as never);
}

function mockMutations() {
  const mutateSpies: Record<string, ReturnType<typeof vi.fn>> = {
    "intentions.create": vi.fn(),
    "intention.update": vi.fn(),
    "intention.delete": vi.fn(),
  };
  mutationMock.mockImplementation(((action: string) => ({
    mutate: mutateSpies[action],
    isPending: false,
  })) as never);
  return mutateSpies;
}

function renderTab() {
  return render(<AgentIntentionsTab agentId={AGENT_ID} />);
}

describe("AgentIntentionsTab", () => {
  beforeEach(() => {
    queryMock.mockReset();
    mutationMock.mockReset();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  it("mostra estado vazio em PT-BR quando não há intenções", () => {
    mockList([]);
    mockMutations();

    renderTab();

    expect(screen.getByText("Nenhuma intenção cadastrada")).toBeInTheDocument();
  });

  it("mostra erro em PT-BR com botão 'Tentar de novo' quando a leitura falha", async () => {
    const refetch = vi.fn();
    queryMock.mockReturnValue({
      data: undefined,
      isPending: false,
      isError: true,
      error: { message: "Não foi possível falar com o provedor de agentes." },
      isFetching: false,
      refetch,
    } as never);
    mockMutations();

    renderTab();

    expect(
      screen.getByText("Não foi possível falar com o provedor de agentes."),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  // Regressão: o timer do debounce de busca agendado no mount (busca vazia)
  // ficava pendente porque `searchInput` nunca muda enquanto o usuário só
  // pagina — o efeito não re-roda, o cleanup não dispara, e 300ms depois o
  // timer chamava setPage(1), revertendo quem tinha acabado de clicar
  // "Próxima" (mesma causa do flake corrigido em #246).
  it("mantém a página 2 quando o debounce agendado no mount dispara depois do clique em Próxima", () => {
    vi.useFakeTimers();
    const fullPage = Array.from({ length: 20 }, (_, i) => ({ ...SAMPLE_INTENTION, id: `int${i}` }));
    mockList(fullPage);
    mockMutations();

    renderTab();
    fireEvent.click(screen.getByRole("button", { name: "Próxima" }));

    act(() => {
      vi.advanceTimersByTime(1_000); // bem além dos 300 ms do debounce
    });

    const lastCall = queryMock.mock.calls.at(-1) as [string, { params: { page: number } }];
    expect(lastCall[1].params.page).toBe(2);

    vi.useRealTimers();
  });

  // Timeout maior de propósito: este teste digita em muitos campos (fields +
  // headers + params + variables + JSON) — sob CPU contida (suíte completa
  // rodando em paralelo), a soma dos re-renders passa do timeout padrão de
  // 5s mesmo com userEvent sem delay artificial, o teste é cortado no meio
  // do digitar, e a sobra de eventos vaza pro próximo teste montado (bug
  // real encontrado em execução da suíte cheia — não em isolamento).
  it("cria uma intenção WEBHOOK enviando fields/headers/params/variables no formato do contrato", async () => {
    mockList([]);
    const mutateSpies = mockMutations();
    const user = userEvent.setup({ delay: null });
    renderTab();

    await user.click(screen.getByRole("button", { name: "Nova intenção" }));

    await user.type(screen.getByLabelText("Descrição *"), "Agendar demo");
    await user.type(screen.getByLabelText("URL *"), "https://api.exemplo.com/agendar");

    await user.click(screen.getByRole("button", { name: "Adicionar campo" }));
    await user.type(screen.getByPlaceholderText("Ex.: nome_do_produto"), "Produto");
    await user.type(screen.getByPlaceholderText("Ex.: productName"), "produto");
    await user.type(screen.getByPlaceholderText("O que este campo representa"), "Nome do produto");

    await user.click(screen.getByRole("button", { name: "Adicionar cabeçalho" }));
    await user.type(screen.getByPlaceholderText("Ex.: Authorization"), "Authorization");
    await user.type(screen.getByPlaceholderText("Valor do cabeçalho"), SECRET_HEADER_VALUE);

    await user.click(screen.getByRole("button", { name: "Adicionar parâmetro" }));
    await user.type(screen.getByPlaceholderText("Ex.: origem"), "origem");
    await user.type(screen.getByPlaceholderText("Valor do parâmetro"), "site");

    await user.click(screen.getByRole("button", { name: "Adicionar variável" }));
    await user.type(screen.getByPlaceholderText("Ex.: {{nome_do_produto}}"), "nome_do_produto");
    await user.type(screen.getByPlaceholderText("Ex.: contact_name"), "contact_name");

    // userEvent.type só interpreta `{`/`[` como início de tecla especial —
    // dobrar o `{` digita o caractere literal; `}` sozinho já é literal.
    // Produz o texto `{"foo": "bar"}`.
    await user.type(screen.getByLabelText("Corpo da requisição (JSON)"), '{{"foo": "bar"}');

    await user.click(screen.getByRole("button", { name: "Salvar intenção" }));

    expect(mutateSpies["intentions.create"]).toHaveBeenCalledTimes(1);
    const [variables] = mutateSpies["intentions.create"].mock.calls[0] as [
      { params: { agentId: string }; body: Record<string, unknown> },
    ];
    expect(variables.params).toEqual({ agentId: AGENT_ID });
    expect(variables.body).toEqual({
      description: "Agendar demo",
      type: "WEBHOOK",
      httpMethod: "POST",
      url: "https://api.exemplo.com/agendar",
      autoGenerateParams: true,
      autoGenerateBody: true,
      details: undefined,
      instructions: undefined,
      fields: [
        {
          name: "Produto",
          jsonName: "produto",
          description: "Nome do produto",
          type: "STRING",
          required: false,
        },
      ],
      headers: [{ name: "Authorization", value: SECRET_HEADER_VALUE }],
      params: [{ name: "origem", value: "site" }],
      variables: [
        {
          valueExpression: "nome_do_produto",
          defaultFieldKey: "contact_name",
          customField: undefined,
        },
      ],
      requestBody: '{"foo": "bar"}',
    });
  }, 15_000);

  it("cria uma intenção INSTRUCTIONS sem exigir URL/método", async () => {
    mockList([]);
    const mutateSpies = mockMutations();
    const user = userEvent.setup({ delay: null });
    renderTab();

    await user.click(screen.getByRole("button", { name: "Nova intenção" }));
    // ToggleGroup type="single" do Radix expõe cada opção com role="radio".
    await user.click(screen.getByRole("radio", { name: "Instruções" }));

    await user.type(screen.getByLabelText("Descrição *"), "Responder dúvidas sobre preço");
    await user.type(
      screen.getByLabelText("Instruções para o agente"),
      "Explique os planos disponíveis.",
    );

    await user.click(screen.getByRole("button", { name: "Salvar intenção" }));

    expect(mutateSpies["intentions.create"]).toHaveBeenCalledTimes(1);
    const [variables] = mutateSpies["intentions.create"].mock.calls[0] as [
      { params: { agentId: string }; body: Record<string, unknown> },
    ];
    expect(variables.body).toEqual({
      description: "Responder dúvidas sobre preço",
      type: "INSTRUCTIONS",
      httpMethod: "POST",
      url: "",
      autoGenerateParams: false,
      autoGenerateBody: false,
      details: undefined,
      instructions: "Explique os planos disponíveis.",
      fields: undefined,
      headers: undefined,
      params: undefined,
      variables: undefined,
      requestBody: undefined,
    });
  });

  it("bloqueia o envio com mensagem PT-BR quando o corpo da requisição é um JSON inválido", async () => {
    mockList([]);
    const mutateSpies = mockMutations();
    const user = userEvent.setup({ delay: null });
    renderTab();

    await user.click(screen.getByRole("button", { name: "Nova intenção" }));
    await user.type(screen.getByLabelText("Descrição *"), "Intenção qualquer");
    await user.type(screen.getByLabelText("URL *"), "https://api.exemplo.com/x");
    await user.type(screen.getByLabelText("Corpo da requisição (JSON)"), "{{isso nao e json");

    await user.click(screen.getByRole("button", { name: "Salvar intenção" }));

    expect(
      screen.getByText(
        "O corpo da requisição (JSON) está inválido. Corrija o texto antes de salvar.",
      ),
    ).toBeInTheDocument();
    expect(mutateSpies["intentions.create"]).not.toHaveBeenCalled();
  });

  it("edita uma intenção existente preservando o header mascarado não alterado", async () => {
    mockList([SAMPLE_INTENTION]);
    const mutateSpies = mockMutations();
    const user = userEvent.setup({ delay: null });
    renderTab();

    await user.click(screen.getByRole("button", { name: "Editar" }));

    expect(screen.getByLabelText("Descrição *")).toHaveValue("Agendar demonstração");
    // O valor real do header nunca aparece cru na tela.
    expect(screen.queryByDisplayValue(SECRET_HEADER_VALUE)).not.toBeInTheDocument();
    expect(screen.getByText("••••••••••••-123")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Substituir" })).toBeInTheDocument();

    await user.clear(screen.getByLabelText("Descrição *"));
    await user.type(screen.getByLabelText("Descrição *"), "Agendar demonstração VIP");
    await user.click(screen.getByRole("button", { name: "Salvar intenção" }));

    expect(mutateSpies["intention.update"]).toHaveBeenCalledTimes(1);
    const [variables] = mutateSpies["intention.update"].mock.calls[0] as [
      { params: { agentId: string; intentionId: string }; body: Record<string, unknown> },
    ];
    expect(variables.params).toEqual({ agentId: AGENT_ID, intentionId: "int-1" });
    // O header mascarado não foi tocado -- o valor real precisa voltar intacto.
    expect((variables.body.headers as { value: string }[])[0].value).toBe(SECRET_HEADER_VALUE);
    expect(variables.body.description).toBe("Agendar demonstração VIP");
    expect(variables.body.type).toBe("WEBHOOK");
  });

  it("substitui o valor mascarado do header quando o usuário clica em Substituir", async () => {
    mockList([SAMPLE_INTENTION]);
    const mutateSpies = mockMutations();
    const user = userEvent.setup({ delay: null });
    renderTab();

    await user.click(screen.getByRole("button", { name: "Editar" }));
    await user.click(screen.getByRole("button", { name: "Substituir" }));
    await user.type(screen.getByPlaceholderText("Valor do cabeçalho"), "Bearer novo-valor-999");
    await user.click(screen.getByRole("button", { name: "Salvar intenção" }));

    const [variables] = mutateSpies["intention.update"].mock.calls[0] as [
      { body: Record<string, unknown> },
    ];
    expect((variables.body.headers as { value: string }[])[0].value).toBe("Bearer novo-valor-999");
  });

  it("clicar em Substituir e salvar sem digitar nada bloqueia o envio (não apaga o header)", async () => {
    mockList([SAMPLE_INTENTION]);
    const mutateSpies = mockMutations();
    const user = userEvent.setup({ delay: null });
    renderTab();

    await user.click(screen.getByRole("button", { name: "Editar" }));
    await user.click(screen.getByRole("button", { name: "Substituir" }));
    await user.click(screen.getByRole("button", { name: "Salvar intenção" }));

    expect(
      screen.getByText("Preencha nome e valor de todo cabeçalho adicionado (ou remova a linha)."),
    ).toBeInTheDocument();
    expect(mutateSpies["intention.update"]).not.toHaveBeenCalled();
  });

  it("exclui uma intenção após confirmação no AlertDialog", async () => {
    mockList([SAMPLE_INTENTION]);
    const mutateSpies = mockMutations();
    const user = userEvent.setup({ delay: null });
    renderTab();

    await user.click(screen.getByRole("button", { name: "Excluir" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Excluir intenção")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Excluir" }));

    expect(mutateSpies["intention.delete"]).toHaveBeenCalledTimes(1);
    const [variables] = mutateSpies["intention.delete"].mock.calls[0] as [
      { params: { agentId: string; intentionId: string } },
    ];
    expect(variables.params).toEqual({ agentId: AGENT_ID, intentionId: "int-1" });
  });
});
