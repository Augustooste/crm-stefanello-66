import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";

import { renderWithQueryClient } from "@/test/render";
import { useCurrentProfile } from "@/lib/api/session";
import {
  useReplaceViewPrefs,
  useResetPageViewPrefs,
  useUpdateViewPref,
  useViewPrefs,
} from "@/lib/api/view-prefs";
import { ViewPrefsTab } from "./ViewPrefsTab";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn() },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/api/session", () => ({ useCurrentProfile: vi.fn() }));

vi.mock("@/lib/api/view-prefs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/view-prefs")>();
  return {
    ...actual,
    useViewPrefs: vi.fn(),
    useUpdateViewPref: vi.fn(),
    useResetPageViewPrefs: vi.fn(),
    useReplaceViewPrefs: vi.fn(),
  };
});

const replaceMutate = vi.fn();

const IMPORT_FILE = new File(
  [
    JSON.stringify({
      version: 1,
      exportedAt: "2026-08-07T00:00:00.000Z",
      prefs: { dashboard: { kpi_pipeline: false } },
    }),
  ],
  "prefs.json",
  { type: "application/json" },
);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useCurrentProfile).mockReturnValue({
    data: { id: "u1", tenant_id: "t1", name: "Ana", role: "admin" },
    isLoading: false,
  } as unknown as ReturnType<typeof useCurrentProfile>);
  vi.mocked(useViewPrefs).mockReturnValue({
    prefs: {},
    isLoading: false,
    isVisible: () => true,
  } as unknown as ReturnType<typeof useViewPrefs>);
  const idleMutation = { mutate: vi.fn(), isPending: false };
  vi.mocked(useUpdateViewPref).mockReturnValue(
    idleMutation as unknown as ReturnType<typeof useUpdateViewPref>,
  );
  vi.mocked(useResetPageViewPrefs).mockReturnValue(
    idleMutation as unknown as ReturnType<typeof useResetPageViewPrefs>,
  );
  vi.mocked(useReplaceViewPrefs).mockReturnValue({
    mutate: replaceMutate,
    isPending: false,
  } as unknown as ReturnType<typeof useReplaceViewPrefs>);
});

async function uploadPrefsFile() {
  const user = userEvent.setup();
  renderWithQueryClient(<ViewPrefsTab />);
  // O input de arquivo é escondido por classe, mas continua no DOM.
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("input de arquivo não encontrado");
  await user.upload(input, IMPORT_FILE);
  return user;
}

describe("ViewPrefsTab — importar preferências", () => {
  it("confirma a importação pelo AlertDialog do projeto, não pelo window.confirm", async () => {
    // window.confirm não existe no jsdom: se o código ainda o chamasse, o
    // teste quebraria aqui em vez de encontrar o dialog.
    const user = await uploadPrefsFile();

    expect(
      await screen.findByRole("alertdialog", { name: "Aplicar as preferências do arquivo?" }),
    ).toBeInTheDocument();
    expect(replaceMutate).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Aplicar" }));

    await waitFor(() => expect(replaceMutate).toHaveBeenCalledTimes(1));
    expect(replaceMutate.mock.calls[0][0]).toEqual({
      prefs: { dashboard: { kpi_pipeline: false } },
      mode: "merge",
    });
  });

  it("cancelar no dialog não aplica nada", async () => {
    const user = await uploadPrefsFile();

    await screen.findByRole("alertdialog");
    await user.click(screen.getByRole("button", { name: "Cancelar" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(replaceMutate).not.toHaveBeenCalled();
  });

  it("arquivo que não é o JSON desta tela avisa em PT-BR, sem mensagem do parser", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<ViewPrefsTab />);
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("input de arquivo não encontrado");

    await user.upload(input, new File(["<html>"], "pagina.json", { type: "application/json" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Arquivo inválido — use o JSON exportado por esta tela.",
      ),
    );
  });

  it("não chama a interface de tenant, e sim de empresa, no aviso de somente leitura", () => {
    vi.mocked(useCurrentProfile).mockReturnValue({
      data: { id: "u2", tenant_id: "t1", name: "Bruno", role: "agent" },
      isLoading: false,
    } as unknown as ReturnType<typeof useCurrentProfile>);
    renderWithQueryClient(<ViewPrefsTab />);

    expect(
      screen.getByText(
        "Somente leitura — apenas administradores podem alterar as preferências da empresa.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/tenant/i)).not.toBeInTheDocument();
  });
});
