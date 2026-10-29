import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithQueryClient } from "@/test/render";
import {
  useAiFailureLogs,
  type AiFailureLogRow,
  type AiFailureLogsPage,
} from "@/lib/api/ai-failure-logs";
import { formatDateTime } from "@/lib/format";
import { AiFailuresTab } from "./AiFailuresTab";

// Só o hook de dados é mockado — AI_ERROR_CODE_LABELS/AI_FAILURE_LOGS_PAGE_SIZE
// continuam vindo do módulo real (importOriginal) pra não duplicar o Record de
// labels aqui e correr o risco de os dois ficarem dessincronizados.
vi.mock("@/lib/api/ai-failure-logs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/ai-failure-logs")>();
  return { ...actual, useAiFailureLogs: vi.fn() };
});

type UseAiFailureLogsReturn = ReturnType<typeof useAiFailureLogs>;

function mockLogs(
  overrides: Partial<{
    data: AiFailureLogsPage;
    isLoading: boolean;
    isError: boolean;
    error: unknown;
    refetch: () => void;
  }> = {},
) {
  const {
    data = { rows: [], total: 0 },
    isLoading = false,
    isError = false,
    error = null,
    refetch = vi.fn(),
  } = overrides;
  vi.mocked(useAiFailureLogs).mockReturnValue({
    data,
    isLoading,
    isError,
    error,
    refetch,
  } as unknown as UseAiFailureLogsReturn);
}

const ROW_FULL: AiFailureLogRow = {
  id: "log-1",
  route: "/webhook/whatsapp",
  provider: "openai",
  model: "gpt-4o-mini",
  status_code: 429,
  error_code: "RATE_LIMIT",
  error_message: "Rate limit exceeded for requests",
  created_at: "2026-07-10T14:30:00.000Z",
};

const ROW_MINIMAL: AiFailureLogRow = {
  id: "log-2",
  route: "/webhook/meta",
  provider: null,
  model: null,
  status_code: null,
  error_code: "UNKNOWN",
  error_message: "Erro desconhecido",
  created_at: "2026-07-11T09:00:00.000Z",
};

const ROW_UNMAPPED_CODE: AiFailureLogRow = {
  id: "log-3",
  route: "/webhook/voz",
  provider: "twilio",
  model: null,
  status_code: 500,
  error_code: "SOME_NEW_CODE",
  error_message: "Código de erro que a UI ainda não conhece",
  created_at: "2026-07-12T08:00:00.000Z",
};

describe("AiFailuresTab", () => {
  beforeEach(() => {
    vi.mocked(useAiFailureLogs).mockReset();
  });

  it("mostra skeletons enquanto a primeira página carrega", () => {
    mockLogs({ data: undefined as unknown as AiFailureLogsPage, isLoading: true });

    const { container } = renderWithQueryClient(<AiFailuresTab />);

    expect(screen.getByText("Falhas de IA")).toBeInTheDocument();
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("mostra estado de erro e chama refetch ao clicar em 'Tentar novamente'", async () => {
    const refetch = vi.fn();
    mockLogs({ isError: true, error: new Error("Falha ao consultar o banco"), refetch });
    const user = userEvent.setup();

    renderWithQueryClient(<AiFailuresTab />);

    expect(screen.getByText("Erro ao carregar falhas")).toBeInTheDocument();
    expect(screen.getByText("Falha ao consultar o banco")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("mostra estado vazio genérico quando não há falhas e nenhum filtro está ativo", () => {
    mockLogs({ data: { rows: [], total: 0 } });

    renderWithQueryClient(<AiFailuresTab />);

    expect(screen.getByText("Nenhuma falha registrada")).toBeInTheDocument();
    expect(
      screen.getByText("Quando a IA falhar ao gerar uma resposta, o registro aparece aqui."),
    ).toBeInTheDocument();
    expect(screen.getByText("0 falhas registrada(s)")).toBeInTheDocument();
  });

  it("usa singular ('1 falha') quando o total é exatamente 1", () => {
    mockLogs({ data: { rows: [ROW_FULL], total: 1 } });

    renderWithQueryClient(<AiFailuresTab />);

    expect(screen.getByText("1 falha registrada(s)")).toBeInTheDocument();
    expect(screen.queryByText("1 falhas registrada(s)")).not.toBeInTheDocument();
  });

  it("troca para o estado vazio específico do filtro ao selecionar um tipo de erro sem resultados", async () => {
    // Hook sempre devolve página vazia — o texto do empty-state depende do
    // estado local `errorCode` do componente, não do retorno do hook.
    mockLogs({ data: { rows: [], total: 0 } });
    const user = userEvent.setup();

    renderWithQueryClient(<AiFailuresTab />);
    expect(screen.getByText("Nenhuma falha registrada")).toBeInTheDocument();

    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("option", { name: "Limite de IA atingido" }));

    expect(screen.getByText("Nenhuma falha desse tipo")).toBeInTheDocument();
    expect(screen.getByText("Ajuste o filtro para ver outros tipos de erro.")).toBeInTheDocument();
  });

  it("renderiza a tabela com os campos de cada falha, incluindo fallbacks de provedor/status e código sem label", () => {
    mockLogs({ data: { rows: [ROW_FULL, ROW_MINIMAL, ROW_UNMAPPED_CODE], total: 3 } });

    renderWithQueryClient(<AiFailuresTab />);

    expect(screen.getByText("3 falhas registrada(s)")).toBeInTheDocument();

    // Linha completa: rota, provedor/modelo combinados, status, label mapeado, mensagem, data.
    expect(screen.getByText("/webhook/whatsapp")).toBeInTheDocument();
    expect(screen.getByText("openai / gpt-4o-mini")).toBeInTheDocument();
    expect(screen.getByText("429")).toBeInTheDocument();
    expect(screen.getByText("Limite de IA atingido")).toBeInTheDocument();
    expect(screen.getByText("Rate limit exceeded for requests")).toBeInTheDocument();
    expect(screen.getByText(formatDateTime(ROW_FULL.created_at))).toBeInTheDocument();

    // Linha sem provider/model/status_code: cai no fallback "—".
    expect(screen.getByText("/webhook/meta")).toBeInTheDocument();
    expect(screen.getByText("Falha ao gerar resposta")).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);

    // error_code sem entrada em AI_ERROR_CODE_LABELS cai no próprio código cru.
    expect(screen.getByText("SOME_NEW_CODE")).toBeInTheDocument();
  });

  it("pagina: 'Anterior' começa desabilitado, 'Próxima' avança e desabilita na última página", async () => {
    mockLogs({ data: { rows: [ROW_FULL], total: 125 } }); // 125 / 50 = 3 páginas
    const user = userEvent.setup();

    renderWithQueryClient(<AiFailuresTab />);

    expect(screen.getByText("Página 1 de 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Anterior" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Próxima" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Próxima" }));
    expect(screen.getByText("Página 2 de 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Anterior" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Próxima" }));
    expect(screen.getByText("Página 3 de 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Próxima" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Anterior" }));
    expect(screen.getByText("Página 2 de 3")).toBeInTheDocument();
  });

  it("selecionar um tipo de erro reseta a página para 1 e reconsulta o hook com o filtro certo", async () => {
    mockLogs({ data: { rows: [ROW_FULL], total: 125 } });
    const user = userEvent.setup();

    renderWithQueryClient(<AiFailuresTab />);

    await user.click(screen.getByRole("button", { name: "Próxima" }));
    expect(screen.getByText("Página 2 de 3")).toBeInTheDocument();

    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("option", { name: "Provedor de IA instável" }));

    expect(screen.getByText("Página 1 de 3")).toBeInTheDocument();
    const lastCallArgs = vi.mocked(useAiFailureLogs).mock.calls.at(-1);
    expect(lastCallArgs).toEqual([1, "PROVIDER_5XX"]);

    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("option", { name: "Todos os tipos" }));

    expect(screen.getByText("Página 1 de 3")).toBeInTheDocument();
    const finalCallArgs = vi.mocked(useAiFailureLogs).mock.calls.at(-1);
    expect(finalCallArgs).toEqual([1, null]);
  });

  it("traduz o jargão do Postgres no estado de erro em vez de exibi-lo cru", async () => {
    mockLogs({
      isError: true,
      error: { message: 'relation "public.ai_failure_logs" does not exist' },
    });

    renderWithQueryClient(<AiFailuresTab />);

    expect(
      await screen.findByText("Não foi possível carregar as falhas agora."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/relation "public/i)).not.toBeInTheDocument();
  });
});
