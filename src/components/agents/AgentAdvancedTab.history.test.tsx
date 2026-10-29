import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";

import { BehaviorHistorySection } from "./BehaviorHistorySection";
import { createQueryWrapper } from "@/test/query-mocks";

const useAgentPlatformQueryMock = vi.fn();

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/lib/api/agent-platform", () => ({
  useAgentPlatformQuery: (action: string, input: unknown) =>
    useAgentPlatformQueryMock(action, input),
}));

function renderSection() {
  return render(<BehaviorHistorySection agentId="agent-1" />, { wrapper: createQueryWrapper() });
}

// `userEvent.setup()` substitui `navigator.clipboard` pelo próprio polyfill —
// por isso o mock precisa ser reaplicado DEPOIS do setup (mesmo padrão de
// TeamTab.test.tsx).
function mockClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

const HISTORY_ITEM = {
  id: "hist-1",
  userLogin: "ana@empresa.com",
  userName: "Ana",
  userId: "u1",
  userPicture: null,
  createdAt: 1735689600000, // epoch ms — o contrato devolve número, não string ISO
  behaviorText: "Seja sempre educado e objetivo.",
};

describe("BehaviorHistorySection", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("sempre envia page e pageSize (D5) — inclusive ao trocar de página", async () => {
    // página cheia (10 itens = PAGE_SIZE) para o botão "Próxima" ficar habilitado
    const fullPage = Array.from({ length: 10 }, (_, i) => ({ ...HISTORY_ITEM, id: `hist-${i}` }));
    useAgentPlatformQueryMock.mockReturnValue({
      data: fullPage,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    const user = userEvent.setup();

    renderSection();

    expect(useAgentPlatformQueryMock).toHaveBeenCalledWith("agent.behaviorHistory.list", {
      params: { agentId: "agent-1", page: 0, pageSize: 10 },
    });

    await user.click(screen.getByRole("button", { name: "Próxima" }));

    await waitFor(() =>
      expect(useAgentPlatformQueryMock).toHaveBeenCalledWith("agent.behaviorHistory.list", {
        params: { agentId: "agent-1", page: 1, pageSize: 10 },
      }),
    );
  });

  it("ACHADO: normaliza resposta de objeto único do contrato e formata createdAt (número em ms)", async () => {
    useAgentPlatformQueryMock.mockReturnValue({
      data: HISTORY_ITEM,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });

    renderSection();

    expect(await screen.findByText("Ana (ana@empresa.com)")).toBeInTheDocument();
  });

  it("copia o comportamento para a área de transferência a partir da lista", async () => {
    useAgentPlatformQueryMock.mockReturnValue({
      data: [HISTORY_ITEM],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    const user = userEvent.setup();
    const writeText = mockClipboard();

    renderSection();

    await screen.findByText("Ana (ana@empresa.com)");
    await user.click(screen.getByRole("button", { name: "Copiar para o editor" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(HISTORY_ITEM.behaviorText));
    expect(toast.success).toHaveBeenCalledWith(
      "Comportamento copiado — cole no editor de Perfil e salve",
    );
  });

  it("abre o texto completo no diálogo e copia por lá também", async () => {
    useAgentPlatformQueryMock.mockReturnValue({
      data: [HISTORY_ITEM],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    const user = userEvent.setup();
    const writeText = mockClipboard();

    renderSection();

    await screen.findByText("Ana (ana@empresa.com)");
    await user.click(screen.getByRole("button", { name: "Ver texto completo" }));

    expect(await screen.findByText("Seja sempre educado e objetivo.")).toBeInTheDocument();
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /Copiar para o editor/ }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(HISTORY_ITEM.behaviorText));
  });

  it("desabilita Anterior na página 0 e desabilita Próxima quando a página vem incompleta", async () => {
    useAgentPlatformQueryMock.mockReturnValue({
      data: [HISTORY_ITEM],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });

    renderSection();

    await screen.findByText("Ana (ana@empresa.com)");
    expect(screen.getByRole("button", { name: "Anterior" })).toBeDisabled();
    // só 1 item < pageSize (10) => última página
    expect(screen.getByRole("button", { name: "Próxima" })).toBeDisabled();
  });

  it("mostra o erro do provedor (não mascara como lista vazia)", async () => {
    const refetch = vi.fn();
    useAgentPlatformQueryMock.mockReturnValue({
      data: null,
      isLoading: false,
      error: { message: "Sua sessão expirou ou chave do provedor de agentes inválida." },
      refetch,
    });
    const user = userEvent.setup();

    renderSection();

    expect(
      await screen.findByText("Sua sessão expirou ou chave do provedor de agentes inválida."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(refetch).toHaveBeenCalled();
  });
});
