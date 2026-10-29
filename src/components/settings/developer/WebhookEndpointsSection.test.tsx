import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  DeveloperApiError,
  useAllowedWebhookEventTypes,
  useCreateWebhookEndpoint,
  useDeleteWebhookEndpoint,
  useRedeliver,
  useRotateWebhookSecret,
  useSendTestWebhook,
  useSetWebhookActive,
  useWebhookDeliveries,
  useWebhookDeliveryStats,
  useWebhookEndpoints,
  useUpdateWebhookEndpoint,
  type WebhookDelivery,
  type WebhookEndpoint,
} from "@/lib/api/developer";
import { useBoardStagesForBoard } from "@/hooks/use-decision-queue";
import { useBoards } from "@/lib/api/boards";
import { renderWithQueryClient } from "@/test/render";
import { fakeMutation, queryResult } from "./test-helpers";
import { WebhookEndpointsSection } from "./WebhookEndpointsSection";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  const { routerOverrides } = await import("@/test/router-mocks");
  return { ...actual, ...routerOverrides() };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api/developer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/developer")>()),
  useWebhookEndpoints: vi.fn(),
  useWebhookDeliveryStats: vi.fn(),
  useWebhookDeliveries: vi.fn(),
  useAllowedWebhookEventTypes: vi.fn(),
  useCreateWebhookEndpoint: vi.fn(),
  useRotateWebhookSecret: vi.fn(),
  useDeleteWebhookEndpoint: vi.fn(),
  useSetWebhookActive: vi.fn(),
  useSendTestWebhook: vi.fn(),
  useRedeliver: vi.fn(),
  useUpdateWebhookEndpoint: vi.fn(),
}));
vi.mock("@/lib/api/boards", () => ({ useBoards: vi.fn() }));
vi.mock("@/hooks/use-decision-queue", () => ({ useBoardStagesForBoard: vi.fn() }));

const SECRET = "whsec_PRIMEIRO_SEGREDO";
const ROTATED = "whsec_SEGREDO_ROTACIONADO";
const ENDPOINT: WebhookEndpoint = {
  id: "e1",
  url: "https://cliente.exemplo.com.br/hook",
  description: "ERP",
  event_types: ["contact.created"],
  board_ids: [],
  stage_ids: [],
  active: true,
  disabled_reason: null,
  previous_secret_expires_at: null,
  created_at: "2026-10-01T10:00:00Z",
  updated_at: "2026-10-01T10:00:00Z",
};
const DELIVERY: WebhookDelivery = {
  id: "d1",
  endpoint_id: "e1",
  event_id: "ev1",
  event_type: "contact.created",
  status: "delivered",
  attempts: 1,
  max_attempts: 6,
  available_at: "2026-10-01T10:00:00Z",
  response_status: 200,
  response_excerpt: null,
  last_error: null,
  delivered_at: "2026-10-01T10:00:01Z",
  created_at: "2026-10-01T10:00:00Z",
};

const spies = {
  create: vi.fn(async (_input: unknown) => ({ id: "e2", secret: SECRET })),
  createReset: vi.fn(),
  rotate: vi.fn(async (_id: string) => ROTATED),
  rotateReset: vi.fn(),
  del: vi.fn(async (_id: string) => undefined),
  active: vi.fn(async (_input: unknown) => undefined),
  test: vi.fn(async (_id: string) => "d9"),
  redeliver: vi.fn(async (_id: string) => undefined),
  update: vi.fn(async (_input: unknown) => undefined),
};

function setup(
  endpoints: ReturnType<typeof queryResult<WebhookEndpoint[]>>,
  deliveries: WebhookDelivery[] = [],
) {
  vi.mocked(useWebhookEndpoints).mockReturnValue(
    endpoints as unknown as ReturnType<typeof useWebhookEndpoints>,
  );
  vi.mocked(useWebhookDeliveryStats).mockReturnValue(
    queryResult({
      delivered: 3,
      dead_letter: 1,
      pending: 0,
      processing: 0,
    }) as unknown as ReturnType<typeof useWebhookDeliveryStats>,
  );
  vi.mocked(useWebhookDeliveries).mockReturnValue(
    queryResult(deliveries) as unknown as ReturnType<typeof useWebhookDeliveries>,
  );
  vi.mocked(useAllowedWebhookEventTypes).mockReturnValue(
    queryResult(["contact.created", "message.received"]) as unknown as ReturnType<
      typeof useAllowedWebhookEventTypes
    >,
  );
  vi.mocked(useCreateWebhookEndpoint).mockImplementation(
    fakeMutation(spies.create, spies.createReset) as unknown as typeof useCreateWebhookEndpoint,
  );
  vi.mocked(useRotateWebhookSecret).mockImplementation(
    fakeMutation(spies.rotate, spies.rotateReset) as unknown as typeof useRotateWebhookSecret,
  );
  vi.mocked(useDeleteWebhookEndpoint).mockImplementation(
    fakeMutation(spies.del) as unknown as typeof useDeleteWebhookEndpoint,
  );
  vi.mocked(useSetWebhookActive).mockImplementation(
    fakeMutation(spies.active) as unknown as typeof useSetWebhookActive,
  );
  vi.mocked(useSendTestWebhook).mockImplementation(
    fakeMutation(spies.test) as unknown as typeof useSendTestWebhook,
  );
  vi.mocked(useRedeliver).mockImplementation(
    fakeMutation(spies.redeliver) as unknown as typeof useRedeliver,
  );
  vi.mocked(useUpdateWebhookEndpoint).mockImplementation(
    fakeMutation(spies.update) as unknown as typeof useUpdateWebhookEndpoint,
  );
  vi.mocked(useBoards).mockReturnValue(
    queryResult([
      { id: "b-evento", name: "Evento", is_default: false, position: 0 },
    ]) as unknown as ReturnType<typeof useBoards>,
  );
  vi.mocked(useBoardStagesForBoard).mockImplementation(
    (boardId) =>
      queryResult(
        boardId === "b-evento" ? [{ id: "s-pago", name: "Pago", position: 0 }] : undefined,
      ) as unknown as ReturnType<typeof useBoardStagesForBoard>,
  );
  return renderWithQueryClient(<WebhookEndpointsSection />);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("WebhookEndpointsSection: lista e estados", () => {
  it("mostra URL, eventos, estado e taxa de sucesso", () => {
    setup(queryResult([ENDPOINT]));
    expect(screen.getByText(ENDPOINT.url)).toBeInTheDocument();
    expect(screen.getByText("contact.created")).toBeInTheDocument();
    expect(screen.getByText("Ativo")).toBeInTheDocument();
    expect(screen.getByText(/Taxa de sucesso: 75%/)).toBeInTheDocument();
  });

  it("endpoint pausado mostra o estado e o motivo", () => {
    setup(queryResult([{ ...ENDPOINT, active: false, disabled_reason: "falhas consecutivas" }]));
    expect(screen.getByText("Pausado")).toBeInTheDocument();
    expect(screen.getByText(/falhas consecutivas/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Ativar/ })).toBeInTheDocument();
  });

  it("lista vazia mostra o EmptyState", () => {
    setup(queryResult([]));
    expect(screen.getByText("Nenhum webhook")).toBeInTheDocument();
  });
  it("botão Ajuda e link da lista vazia levam à documentação de saída", () => {
    setup(queryResult([]));
    expect(screen.getByRole("link", { name: "Ajuda: webhooks de saída" })).toHaveAttribute(
      "href",
      "/documentacao/webhooks#saida",
    );
    expect(
      screen.getByRole("link", { name: "Como funcionam os webhooks de saída" }),
    ).toHaveAttribute("href", "/documentacao/webhooks#saida");
  });

  it("falha de rede mostra o erro e não a lista vazia", () => {
    setup(queryResult(undefined, { error: new DeveloperApiError(null, "Failed to fetch") }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Não foi possível concluir a operação. Tente novamente.",
    );
    expect(screen.queryByText("Nenhum webhook")).not.toBeInTheDocument();
  });

  it("erro 42501 mostra a mensagem de permissão e não a lista vazia", () => {
    setup(queryResult(undefined, { error: new DeveloperApiError("42501") }));
    expect(screen.getByRole("alert")).toHaveTextContent("Sem permissão para esta ação.");
    expect(screen.queryByText("Nenhum webhook")).not.toBeInTheDocument();
  });

  it("distingue carregando de atualizando", () => {
    const { unmount } = setup(queryResult(undefined, { isLoading: true }));
    expect(screen.getByRole("status", { name: "Carregando webhooks" })).toBeInTheDocument();
    expect(screen.queryByText("Nenhum webhook")).not.toBeInTheDocument();
    unmount();

    setup(queryResult([ENDPOINT], { isFetching: true }));
    expect(screen.getByText("Atualizando…")).toBeInTheDocument();
    expect(screen.getByText(ENDPOINT.url)).toBeInTheDocument();
  });
});

describe("WebhookEndpointsSection: criar", () => {
  it("URL http:// mostra erro em português e não chama a API", async () => {
    const user = userEvent.setup();
    setup(queryResult([ENDPOINT]));

    await user.click(screen.getByRole("button", { name: "Criar webhook" }));
    await user.type(screen.getByLabelText("URL de destino"), "http://inseguro.exemplo.com.br/hook");
    await user.click(screen.getByRole("checkbox", { name: "contact.created" }));
    await user.click(screen.getByRole("button", { name: "Criar webhook" }));

    expect(await screen.findByText("A URL precisa usar https://.")).toBeInTheDocument();
    expect(spies.create).not.toHaveBeenCalled();
  });

  it("rejeita usuário e senha na URL, URL longa demais, descrição longa e zero eventos", async () => {
    const user = userEvent.setup();
    setup(queryResult([]));
    await user.click(screen.getAllByRole("button", { name: "Criar webhook" })[0]);
    const dialog = screen.getByRole("dialog");
    const submit = () => within(dialog).getByRole("button", { name: "Criar webhook" });
    const urlField = within(dialog).getByLabelText("URL de destino");

    await user.type(urlField, "https://u:p@exemplo.com.br/hook");
    await user.click(within(dialog).getByRole("checkbox", { name: "contact.created" }));
    await user.click(submit());
    expect(await within(dialog).findByText("A URL não pode conter usuário e senha.")).toBeVisible();

    await user.clear(urlField);
    await user.click(urlField);
    await user.paste(`https://exemplo.com.br/${"a".repeat(2050)}`);
    await user.click(submit());
    expect(await within(dialog).findByText(/no máximo 2048 caracteres/)).toBeVisible();

    await user.clear(urlField);
    await user.type(urlField, "https://exemplo.com.br/hook");
    await user.click(within(dialog).getByLabelText("Descrição (opcional)"));
    await user.paste("d".repeat(501));
    await user.click(submit());
    expect(await within(dialog).findByText(/descrição pode ter no máximo 500/)).toBeVisible();

    await user.clear(within(dialog).getByLabelText("Descrição (opcional)"));
    await user.click(within(dialog).getByRole("checkbox", { name: "contact.created" }));
    await user.click(submit());
    expect(await within(dialog).findByText("Selecione ao menos um evento.")).toBeVisible();
    expect(spies.create).not.toHaveBeenCalled();
  });

  it("recusa na UI as URLs que o CHECK do banco recusa e aceita as válidas", async () => {
    const user = userEvent.setup();
    setup(queryResult([]));
    await user.click(screen.getAllByRole("button", { name: "Criar webhook" })[0]);
    const dialog = screen.getByRole("dialog");
    const urlField = within(dialog).getByLabelText("URL de destino");
    await user.click(within(dialog).getByRole("checkbox", { name: "contact.created" }));
    const submit = () => within(dialog).getByRole("button", { name: "Criar webhook" });
    const tryUrl = async (url: string) => {
      await user.clear(urlField);
      await user.click(urlField);
      await user.paste(url);
      await user.click(submit());
    };

    const rejected: [string, RegExp][] = [
      ["https://exemplo.com.br/a b", /não pode conter espaços/],
      ["HTTPS://exemplo.com.br/hook", /precisa usar https/],
      ["ftp://exemplo.com.br/hook", /precisa usar https/],
      ["https://user@exemplo.com.br/hook", /usuário e senha/],
      ["https://", /URL válida/],
      ["https:///hook", /URL válida/],
    ];
    for (const [url, message] of rejected) {
      await tryUrl(url);
      expect(await within(dialog).findByText(message)).toBeVisible();
    }
    expect(spies.create).not.toHaveBeenCalled();

    // O banco aceita porta, caminho, query e fragmento: a UI também.
    await tryUrl("https://exemplo.com.br:8443/hook?x=1#f");
    expect(await screen.findByRole("dialog", { name: "Webhook criado" })).toBeInTheDocument();
    expect(spies.create).toHaveBeenCalledTimes(1);
  });

  it("cria e mostra o segredo só no dialog; fechar chama reset", async () => {
    const user = userEvent.setup();
    setup(queryResult([ENDPOINT]));

    await user.click(screen.getByRole("button", { name: "Criar webhook" }));
    await user.type(screen.getByLabelText("URL de destino"), "https://novo.exemplo.com.br/hook");
    await user.click(screen.getByRole("checkbox", { name: "message.received" }));
    const form = screen.getByRole("dialog");
    await user.click(within(form).getByRole("button", { name: "Criar webhook" }));

    const reveal = await screen.findByRole("dialog", { name: "Webhook criado" });
    expect(spies.create).toHaveBeenCalledWith({
      url: "https://novo.exemplo.com.br/hook",
      eventTypes: ["message.received"],
      description: null,
      boardIds: [],
      stageIds: [],
    });
    expect(within(reveal).getByText(SECRET)).toBeInTheDocument();

    await user.click(within(reveal).getByRole("button", { name: "Já guardei o segredo" }));
    expect(spies.createReset).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
  });
});

describe("WebhookEndpointsSection: fechar a revelação de segredo", () => {
  async function openReveal(user: ReturnType<typeof userEvent.setup>) {
    setup(queryResult([ENDPOINT]));
    await user.click(screen.getByRole("button", { name: "Rotacionar segredo" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Rotacionar" }),
    );
    await screen.findByRole("dialog", { name: "Novo segredo gerado" });
  }

  it("Escape chama reset e o segredo some do DOM", async () => {
    const user = userEvent.setup();
    await openReveal(user);
    await user.keyboard("{Escape}");
    expect(spies.rotateReset).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(ROTATED)).not.toBeInTheDocument();
  });

  it("clique fora chama reset e o segredo some do DOM", async () => {
    const user = userEvent.setup();
    await openReveal(user);
    const overlay = document.querySelector("[data-state='open'].fixed.inset-0");
    expect(overlay).not.toBeNull();
    await user.click(overlay as Element);
    expect(spies.rotateReset).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(ROTATED)).not.toBeInTheDocument();
  });
});

describe("WebhookEndpointsSection: ações", () => {
  it("rotacionar pede confirmação e mostra o novo segredo uma vez", async () => {
    const user = userEvent.setup();
    setup(queryResult([ENDPOINT]));

    await user.click(screen.getByRole("button", { name: "Rotacionar segredo" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(spies.rotate).not.toHaveBeenCalled();
    expect(within(confirm).getByText(/24 horas/)).toBeInTheDocument();
    await user.click(within(confirm).getByRole("button", { name: "Rotacionar" }));

    const reveal = await screen.findByRole("dialog", { name: "Novo segredo gerado" });
    expect(spies.rotate).toHaveBeenCalledWith("e1");
    expect(within(reveal).getByText(ROTATED)).toBeInTheDocument();
    expect(within(reveal).getByText(/24 horas/)).toBeInTheDocument();

    await user.click(within(reveal).getByRole("button", { name: "Já guardei o segredo" }));
    expect(spies.rotateReset).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(ROTATED)).not.toBeInTheDocument();
  });

  it("excluir pede confirmação e só chama a API ao confirmar", async () => {
    const user = userEvent.setup();
    setup(queryResult([ENDPOINT]));

    await user.click(screen.getByRole("button", { name: /^Excluir/ }));
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: "Cancelar" }));
    expect(spies.del).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /^Excluir/ }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Excluir" }),
    );
    expect(spies.del).toHaveBeenCalledWith("e1");
  });

  it("pausa, ativa e envia evento de teste", async () => {
    const user = userEvent.setup();
    setup(queryResult([ENDPOINT]));

    await user.click(screen.getByRole("button", { name: /^Pausar/ }));
    expect(spies.active).toHaveBeenCalledWith({ id: "e1", active: false });

    await user.click(screen.getByRole("button", { name: "Enviar evento de teste" }));
    expect(spies.test).toHaveBeenCalledWith("e1");
  });
});

describe("WebhookDeliveriesDialog", () => {
  it("reenviar só aparece em entregas dead_letter", async () => {
    const user = userEvent.setup();
    setup(queryResult([ENDPOINT]), [
      DELIVERY,
      { ...DELIVERY, id: "d2", status: "dead_letter", response_status: 500, last_error: "timeout" },
      { ...DELIVERY, id: "d3", status: "pending", response_status: null },
    ]);

    await user.click(screen.getByRole("button", { name: "Ver entregas" }));
    const dialog = await screen.findByRole("dialog", { name: "Entregas do webhook" });

    expect(within(dialog).getAllByRole("listitem")).toHaveLength(3);
    const resend = within(dialog).getAllByRole("button", { name: /Reenviar/ });
    expect(resend).toHaveLength(1);
    expect(within(dialog).getByText("timeout")).toBeInTheDocument();

    await user.click(resend[0]);
    expect(spies.redeliver).toHaveBeenCalledWith("d2");
  });

  it("mostra response_excerpt como texto puro, nunca como HTML", async () => {
    const user = userEvent.setup();
    const html = '<img src=x onerror="alert(1)"><b>negrito</b>';
    setup(queryResult([ENDPOINT]), [{ ...DELIVERY, response_excerpt: html }]);

    await user.click(screen.getByRole("button", { name: "Ver entregas" }));
    const dialog = await screen.findByRole("dialog", { name: "Entregas do webhook" });

    const excerpt = within(dialog).getByLabelText("Início da resposta do seu sistema");
    expect(excerpt.textContent).toBe(html);
    expect(dialog.querySelector("img")).toBeNull();
    expect(dialog.querySelector("b")).toBeNull();

    const toggle = within(dialog).getByRole("button", { name: "Mostrar mais da resposta" });
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("carregar mais só aparece com página cheia e pede o próximo deslocamento", async () => {
    const user = userEvent.setup();
    const full = Array.from({ length: 50 }, (_, i) => ({ ...DELIVERY, id: `d${i}` }));
    setup(queryResult([ENDPOINT]), full);

    await user.click(screen.getByRole("button", { name: "Ver entregas" }));
    await user.click(await screen.findByRole("button", { name: "Carregar mais" }));

    expect(vi.mocked(useWebhookDeliveries)).toHaveBeenCalledWith("e1", { limit: 50, offset: 50 });
  });

  it("sem entregas mostra o EmptyState, e erro mostra a mensagem", async () => {
    const user = userEvent.setup();
    setup(queryResult([ENDPOINT]), []);
    await user.click(screen.getByRole("button", { name: "Ver entregas" }));
    expect(await screen.findByText("Nenhuma entrega ainda")).toBeInTheDocument();
  });
});

describe("WebhookEndpointsSection: filtro por funil e etapa", () => {
  it("sem filtro mostra Todos os negócios; com filtro mostra funil e etapas", () => {
    setup(
      queryResult([
        ENDPOINT,
        { ...ENDPOINT, id: "e2", board_ids: ["b-evento"], stage_ids: ["s-pago"] },
      ]),
    );
    expect(screen.getByText("Todos os negócios")).toBeInTheDocument();
    expect(screen.getByText("Funil: Evento · Etapas: Pago")).toBeInTheDocument();
  });

  it("filter_target_deleted mostra o aviso e Editar abre o dialog preenchido e salva", async () => {
    const user = userEvent.setup();
    setup(
      queryResult([
        {
          ...ENDPOINT,
          board_ids: ["b-apagado"],
          active: false,
          disabled_reason: "filter_target_deleted",
        },
      ]),
    );
    expect(
      screen.getByText(
        "Desativado: o funil ou a etapa do filtro foi apagado. Edite o filtro para reativar.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Motivo: filter_target_deleted/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Editar/ }));
    const dialog = await screen.findByRole("dialog", { name: "Editar webhook" });
    expect(within(dialog).getByLabelText("URL de destino")).toHaveValue(ENDPOINT.url);
    await user.click(within(dialog).getByRole("combobox", { name: "Funil" }));
    await user.click(await screen.findByRole("option", { name: "Evento" }));
    await user.click(within(dialog).getByRole("checkbox", { name: "Pago" }));
    await user.click(within(dialog).getByRole("button", { name: "Salvar" }));
    expect(spies.update).toHaveBeenCalledWith({
      id: "e1",
      url: ENDPOINT.url,
      eventTypes: ["contact.created"],
      description: "ERP",
      boardIds: ["b-evento"],
      stageIds: ["s-pago"],
    });
  });
});

describe("WebhookEndpointsSection: resumo enquanto os funis carregam", () => {
  it("não mostra funil apagado antes de os funis carregarem", () => {
    setup(queryResult([{ ...ENDPOINT, board_ids: ["b-evento"], stage_ids: [] }]));
    vi.mocked(useBoards).mockReturnValue(
      queryResult(undefined, { isLoading: true }) as unknown as ReturnType<typeof useBoards>,
    );
    renderWithQueryClient(<WebhookEndpointsSection />);
    expect(screen.queryByText(/funil apagado/)).toBeNull();
    expect(screen.getAllByText("Carregando filtro…").length).toBeGreaterThan(0);
  });
});
