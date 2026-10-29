import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";

import { KnowledgeBaseTab, type KnowledgeDocument } from "./KnowledgeBaseTab";

const useCurrentProfileMock = vi.fn();
const invokeMock = vi.fn();
// Resposta de ai_feature_catalog para "knowledge_rag" — controla se a tela
// deve avisar que a IA não consulta a base.
let consultaRow: { default_enabled: boolean; tenant_ai_features: { enabled: boolean }[] } | null =
  null;

vi.mock("@/lib/api/session", () => ({
  useCurrentProfile: () => useCurrentProfileMock(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: {
      invoke: (...args: unknown[]) => invokeMock(...args),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: consultaRow, error: null }),
        }),
      }),
    }),
  },
}));

// <Link> do TanStack Router precisa de RouterProvider real — trocamos por uma
// <a> simples, mesmo helper usado nas outras telas com Link.
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  const { routerOverrides } = await import("@/test/router-mocks");
  return { ...actual, ...routerOverrides() };
});

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

function renderTab() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <KnowledgeBaseTab />
    </QueryClientProvider>,
  );
}

function listResponse(documents: KnowledgeDocument[] = []) {
  return { data: { ok: true, documents }, error: null };
}

describe("KnowledgeBaseTab", () => {
  beforeEach(() => {
    useCurrentProfileMock.mockReset();
    invokeMock.mockReset();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    useCurrentProfileMock.mockReturnValue({
      data: { id: "profile-1", tenant_id: "tenant-1", role: "admin" },
    });
    invokeMock.mockResolvedValue(listResponse());
    // Padrão dos testes existentes: consulta ligada, para o aviso não poluir.
    consultaRow = { default_enabled: false, tenant_ai_features: [{ enabled: true }] };
  });

  // O achado: a feature nasce desligada e a tela mostrava "Disponível" em
  // verde como se a IA já usasse o documento. Sem o aviso, este teste falha.
  it("avisa que a IA não consulta a base enquanto a consulta estiver desligada", async () => {
    consultaRow = { default_enabled: false, tenant_ai_features: [] };
    renderTab();

    expect(await screen.findByText("A IA ainda não consulta esta base")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ligar agora" })).toHaveAttribute(
      "href",
      "/configuracoes#ia/features",
    );
  });

  it("não avisa nada quando a empresa já ligou a consulta", async () => {
    renderTab();

    expect(await screen.findByText("Nenhum documento processado")).toBeInTheDocument();
    expect(screen.queryByText("A IA ainda não consulta esta base")).not.toBeInTheDocument();
  });

  it("mostra estado vazio e aceita upload de texto", async () => {
    const user = userEvent.setup();
    renderTab();

    expect(await screen.findByText("Nenhum documento processado")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Título"), "Política comercial");
    await user.type(screen.getByLabelText("Texto"), "O prazo de pagamento é de 30 dias.");
    await user.click(screen.getByRole("button", { name: "Processar documento" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("kb-documents", {
        body: {
          action: "upload",
          title: "Política comercial",
          sourceType: "text",
          text: "O prazo de pagamento é de 30 dias.",
        },
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Documento enviado para processamento.");
  });

  it("exibe status/chunks e permite reprocessar documento pronto", async () => {
    const user = userEvent.setup();
    const document: KnowledgeDocument = {
      id: "doc-1",
      title: "FAQ",
      source_type: "text",
      mime_type: "text/plain",
      bytes: 40,
      status: "ready",
      error_message: null,
      chunk_count: 3,
      created_at: "2026-07-27T12:00:00.000Z",
      updated_at: "2026-07-27T12:00:00.000Z",
    };
    invokeMock.mockImplementation((_name, options: { body: { action: string } }) => {
      if (options.body.action === "list") return Promise.resolve(listResponse([document]));
      return Promise.resolve({ data: { ok: true }, error: null });
    });
    renderTab();

    expect(await screen.findByText("FAQ")).toBeInTheDocument();
    expect(screen.getByText("Disponível")).toBeInTheDocument();
    expect(screen.getByText(/3 trechos/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reprocessar" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("kb-documents", {
        body: { action: "reprocess", documentId: "doc-1" },
      }),
    );
  });

  it("mostra erro de processamento e remove o documento confirmado", async () => {
    const user = userEvent.setup();
    const failed: KnowledgeDocument = {
      id: "doc-failed",
      title: "Contrato corrompido",
      source_type: "upload",
      mime_type: "application/pdf",
      bytes: 400,
      status: "failed",
      error_message: "PDF inválido.",
      chunk_count: 0,
      created_at: "2026-07-27T12:00:00.000Z",
      updated_at: "2026-07-27T12:00:00.000Z",
    };
    invokeMock.mockImplementation((_name, options: { body: { action: string } }) => {
      if (options.body.action === "list") return Promise.resolve(listResponse([failed]));
      return Promise.resolve({ data: { ok: true }, error: null });
    });
    renderTab();

    expect(await screen.findByText("PDF inválido.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Excluir" }));

    expect(globalThis.confirm).toHaveBeenCalledWith(
      'Excluir "Contrato corrompido" e todos os trechos?',
    );
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("kb-documents", {
        body: { action: "delete", documentId: "doc-failed" },
      }),
    );
  });
});
