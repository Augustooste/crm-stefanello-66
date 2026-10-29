import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  DeveloperApiError,
  useApiKeys,
  useAllowedApiScopes,
  useCreateApiKey,
  useRevokeApiKey,
  type ApiKey,
} from "@/lib/api/developer";
import { renderWithQueryClient } from "@/test/render";
import { fakeMutation, queryResult } from "./test-helpers";
import { ApiKeysSection } from "./ApiKeysSection";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api/developer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/developer")>()),
  useApiKeys: vi.fn(),
  useAllowedApiScopes: vi.fn(),
  useCreateApiKey: vi.fn(),
  useRevokeApiKey: vi.fn(),
}));

const TOKEN = "afk_live_SEGREDO_UNICO_123";
const KEY: ApiKey = {
  id: "k1",
  name: "Integração ERP",
  key_prefix: "afk_live_ab12",
  scopes: ["contacts:read"],
  expires_at: null,
  revoked_at: null,
  last_used_at: null,
  created_by: null,
  created_at: "2026-10-01T10:00:00Z",
};

const resetSpy = vi.fn();
const createSpy = vi.fn(async (_input: unknown) => ({ id: "k2", token: TOKEN }));
const revokeSpy = vi.fn(async (_id: string) => undefined);

function setup(
  keys: ReturnType<typeof queryResult<ApiKey[]>>,
  scopes: string[] = ["contacts:read", "contacts:write"],
) {
  vi.mocked(useApiKeys).mockReturnValue(keys as unknown as ReturnType<typeof useApiKeys>);
  vi.mocked(useAllowedApiScopes).mockReturnValue(
    queryResult(scopes) as unknown as ReturnType<typeof useAllowedApiScopes>,
  );
  vi.mocked(useCreateApiKey).mockImplementation(
    fakeMutation(createSpy, resetSpy) as unknown as typeof useCreateApiKey,
  );
  vi.mocked(useRevokeApiKey).mockImplementation(
    fakeMutation(revokeSpy) as unknown as typeof useRevokeApiKey,
  );
  return renderWithQueryClient(<ApiKeysSection />);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ApiKeysSection", () => {
  it("lista nome, prefixo e escopos sem expor o token", () => {
    setup(queryResult([KEY]));
    expect(screen.getByText("Integração ERP")).toBeInTheDocument();
    expect(screen.getByText("afk_live_ab12")).toBeInTheDocument();
    expect(screen.getByText("contacts:read")).toBeInTheDocument();
    expect(screen.queryByText(TOKEN)).not.toBeInTheDocument();
  });

  it("mostra o token só no dialog e chama reset ao fechar", async () => {
    const user = userEvent.setup();
    setup(queryResult([KEY]));

    await user.click(screen.getByRole("button", { name: "Criar chave de API" }));
    await user.type(screen.getByLabelText("Nome"), "Nova chave");
    await user.click(screen.getByRole("checkbox", { name: "contacts:read" }));
    await user.click(screen.getByRole("button", { name: "Criar chave" }));

    const reveal = await screen.findByRole("dialog", { name: /chave criada/i });
    expect(within(reveal).getByText(TOKEN)).toBeInTheDocument();
    expect(within(reveal).getByText(/não será mostrad[ao] novamente/i)).toBeInTheDocument();
    expect(within(reveal).getByText(/X-Api-Key/)).toBeInTheDocument();
    expect(resetSpy).not.toHaveBeenCalled();

    await user.click(within(reveal).getByRole("button", { name: "Já guardei a chave" }));

    expect(resetSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(TOKEN)).not.toBeInTheDocument();
  });

  it("deals:write aparece rotulado como reservado, sem rotas na v1", async () => {
    const user = userEvent.setup();
    setup(queryResult([KEY]), ["contacts:read", "deals:write"]);
    await user.click(screen.getByRole("button", { name: "Criar chave de API" }));
    expect(screen.getByRole("checkbox", { name: "deals:write" })).toBeInTheDocument();
    expect(screen.getAllByText("reservado, sem rotas na v1")).toHaveLength(1);
  });

  async function openTokenDialog(user: ReturnType<typeof userEvent.setup>) {
    setup(queryResult([KEY]));
    await user.click(screen.getByRole("button", { name: "Criar chave de API" }));
    await user.type(screen.getByLabelText("Nome"), "Nova chave");
    await user.click(screen.getByRole("checkbox", { name: "contacts:read" }));
    await user.click(screen.getByRole("button", { name: "Criar chave" }));
    await screen.findByRole("dialog", { name: /chave criada/i });
  }

  it("Escape no dialog do token chama reset e o token some do DOM", async () => {
    const user = userEvent.setup();
    await openTokenDialog(user);
    await user.keyboard("{Escape}");
    expect(resetSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(TOKEN)).not.toBeInTheDocument();
  });

  it("clique fora do dialog do token chama reset e o token some do DOM", async () => {
    const user = userEvent.setup();
    await openTokenDialog(user);
    const overlay = document.querySelector("[data-state='open'].fixed.inset-0");
    expect(overlay).not.toBeNull();
    await user.click(overlay as Element);
    expect(resetSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(TOKEN)).not.toBeInTheDocument();
  });

  it("revogar pede confirmação antes de chamar a API", async () => {
    const user = userEvent.setup();
    setup(queryResult([KEY]));

    await user.click(screen.getByRole("button", { name: "Revogar chave Integração ERP" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(revokeSpy).not.toHaveBeenCalled();

    await user.click(within(confirm).getByRole("button", { name: "Cancelar" }));
    expect(revokeSpy).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Revogar chave Integração ERP" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Revogar" }),
    );
    expect(revokeSpy).toHaveBeenCalledWith("k1");
  });

  it("chave revogada aparece como revogada e sem botão de revogar", () => {
    setup(queryResult([{ ...KEY, revoked_at: "2026-10-02T10:00:00Z" }]));
    expect(screen.getByText("Revogada")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Revogar chave/ })).not.toBeInTheDocument();
  });

  it("lista vazia mostra o EmptyState", () => {
    setup(queryResult([]));
    expect(screen.getByText("Nenhuma chave de API")).toBeInTheDocument();
  });

  it("erro 42501 mostra a mensagem e não a lista vazia", () => {
    setup(queryResult(undefined, { error: new DeveloperApiError("42501") }));
    expect(screen.getByRole("alert")).toHaveTextContent("Sem permissão para esta ação.");
    expect(screen.queryByText("Nenhuma chave de API")).not.toBeInTheDocument();
  });

  it("distingue carregando de atualizando", () => {
    const { unmount } = setup(queryResult(undefined, { isLoading: true }));
    expect(screen.getByRole("status", { name: "Carregando chaves de API" })).toBeInTheDocument();
    expect(screen.queryByText("Nenhuma chave de API")).not.toBeInTheDocument();
    unmount();

    setup(queryResult([KEY], { isFetching: true }));
    expect(screen.getByText("Atualizando…")).toBeInTheDocument();
    expect(screen.getByText("Integração ERP")).toBeInTheDocument();
  });
});
