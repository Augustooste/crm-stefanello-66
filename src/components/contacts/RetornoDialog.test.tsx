import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { RetornoDialog } from "./RetornoDialog";

// O dialogo depende de 4 fontes externas (rotulo do modulo de agenda, perfil da
// sessao, mutation de appointments e a RPC de inscricao). Todas mockadas: o que
// este arquivo cobre e a ligacao entre o retorno da inscricao e o que o
// operador ve, nao a criacao do compromisso em si.
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/routes/_app.agenda", () => ({ useAppointmentLabel: () => "Retorno" }));
vi.mock("@/lib/api/session", () => ({
  useCurrentProfile: () => ({ data: { id: "u1", tenant_id: "t1" } }),
}));

const mutate = vi.fn();
vi.mock("@/lib/api/appointments", () => ({
  useCreateAppointment: () => ({ mutate, isPending: false }),
}));

const enrollInManualNurtureSequence = vi.fn();
vi.mock("@/lib/api/retornos", () => ({
  enrollInManualNurtureSequence: (...args: unknown[]) => enrollInManualNurtureSequence(...args),
}));

/** Dispara o onSuccess da mutation como o react-query faria apos o insert. */
async function agendar() {
  const user = userEvent.setup();
  render(<RetornoDialog open onOpenChange={vi.fn()} contactId="c1" />);

  await user.click(screen.getByRole("button", { name: /agendar/i }));

  await waitFor(() => expect(mutate).toHaveBeenCalled());
  const [, handlers] = mutate.mock.calls[0] as [unknown, { onSuccess: () => Promise<void> }];
  await handlers.onSuccess();
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("RetornoDialog", () => {
  it("inscricao concluida: toast de sucesso sem ressalva", async () => {
    enrollInManualNurtureSequence.mockResolvedValue(true);

    await agendar();

    expect(toast.success).toHaveBeenCalledWith("Retorno agendado", { description: undefined });
  });

  it("inscricao nao aconteceu: o toast avisa que o acompanhamento nao comecou", async () => {
    enrollInManualNurtureSequence.mockResolvedValue(false);

    await agendar();

    expect(toast.success).toHaveBeenCalledWith(
      "Retorno agendado",
      expect.objectContaining({
        description: expect.stringContaining("acompanhamento automático não foi iniciado"),
      }),
    );
  });
});
