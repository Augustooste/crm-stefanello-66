import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { supabase } from "@/integrations/supabase/client";
import { renderWithQueryClient } from "@/test/render";
import { createFromByTable, ok } from "@/test/supabase-mock";
import { LigarComIaDialog } from "./LigarComIaDialog";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(), functions: { invoke: vi.fn() } },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const CONTACT = { id: "c1", name: "Ana Souza", phone: "+5511988887777" };

describe("LigarComIaDialog", () => {
  beforeEach(() => {
    vi.mocked(supabase.functions.invoke).mockReset();
    vi.mocked(supabase.from).mockImplementation(
      createFromByTable({
        voice_calls: ok({
          id: "call-1",
          contact_id: "c1",
          deal_id: null,
          status: "completed",
          phone: CONTACT.phone,
          objective: "Reativar",
          is_simulation: true,
          created_at: "2026-09-25T14:30:00Z",
          answered_at: "2026-09-25T14:30:08Z",
          ended_at: "2026-09-25T14:31:00Z",
          duration_seconds: 52,
          outcome: "interested",
          transcript: null,
          summary: null,
          error_message: null,
        }),
      }),
    );
  });

  it("mostra telefone e agente; só liga depois do objetivo e da confirmação", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: { call_id: "call-1", status: "completed" },
      error: null,
    } as never);
    const user = userEvent.setup();
    renderWithQueryClient(
      <LigarComIaDialog open onOpenChange={() => {}} contact={CONTACT} deals={[]} />,
    );

    expect(screen.getByText("+5511988887777")).toBeInTheDocument();
    expect(screen.getByText("Agente de voz padrão da empresa")).toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: "Confirmar e ligar" });
    expect(confirm).toBeDisabled();

    await user.type(screen.getByLabelText("Objetivo da ligação *"), "Reativar o plano");
    await user.click(confirm);

    await waitFor(() => expect(supabase.functions.invoke).toHaveBeenCalledTimes(1));
    const [fn, opts] = vi.mocked(supabase.functions.invoke).mock.calls[0];
    expect(fn).toBe("voice-calls");
    expect(opts?.body).toMatchObject({
      action: "create",
      contact_id: "c1",
      deal_id: null,
      objective: "Reativar o plano",
    });
    expect((opts?.body as { idempotency_key: string } | undefined)?.idempotency_key).toMatch(
      /.{8,}/,
    );
    expect(await screen.findByText("Concluída")).toBeInTheDocument();
    expect(screen.getByText(/simulação/)).toBeInTheDocument();
  });

  it("clique duplo e nova tentativa após erro reusam a mesma idempotency_key", async () => {
    let release: (v: unknown) => void = () => {};
    vi.mocked(supabase.functions.invoke)
      .mockImplementationOnce(() => new Promise((r) => (release = r)) as never)
      .mockResolvedValueOnce({
        data: { call_id: "call-1", status: "completed" },
        error: null,
      } as never);
    const user = userEvent.setup();
    renderWithQueryClient(
      <LigarComIaDialog open onOpenChange={() => {}} contact={CONTACT} deals={[]} />,
    );
    await user.type(screen.getByLabelText("Objetivo da ligação *"), "Reativar o plano");
    const confirm = screen.getByRole("button", { name: "Confirmar e ligar" });

    await user.dblClick(confirm);
    await waitFor(() => expect(supabase.functions.invoke).toHaveBeenCalledTimes(1));
    expect(confirm).toBeDisabled();

    release({ data: null, error: new Error("timeout") });
    await waitFor(() => expect(confirm).toBeEnabled());
    await user.click(confirm);
    await waitFor(() => expect(supabase.functions.invoke).toHaveBeenCalledTimes(2));

    const keys = vi
      .mocked(supabase.functions.invoke)
      .mock.calls.map(
        ([, o]) => (o?.body as { idempotency_key: string } | undefined)?.idempotency_key,
      );
    expect(keys[0]).toMatch(/.{8,}/);
    expect(keys[1]).toBe(keys[0]);
  });

  it("contato sem telefone não permite ligar", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(
      <LigarComIaDialog
        open
        onOpenChange={() => {}}
        contact={{ ...CONTACT, phone: null }}
        deals={[]}
      />,
    );
    await user.type(screen.getByLabelText("Objetivo da ligação *"), "Reativar o plano");
    expect(screen.getByRole("button", { name: "Confirmar e ligar" })).toBeDisabled();
    expect(screen.getByText("Sem telefone cadastrado")).toBeInTheDocument();
  });
});
