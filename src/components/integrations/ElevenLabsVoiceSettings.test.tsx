import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ElevenLabsVoiceSettings } from "./ElevenLabsVoiceSettings";
import { renderWithQueryClient } from "@/test/render";

const invokeMock = vi.fn();
const maybeSingleMock = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: () => maybeSingleMock() }),
      }),
      upsert: () => Promise.resolve({ error: null }),
    }),
    functions: { invoke: (...args: unknown[]) => invokeMock(...args) },
  },
}));

vi.mock("@/lib/api/session", () => ({
  useCurrentProfile: () => ({ data: { tenant_id: "t1" } }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const VOICES = [
  {
    voice_id: "v-fem",
    name: "Sarah",
    gender: "feminina",
    accent: "brazilian",
    language: "pt",
    category: "premade",
    description: null,
    preview_url: "https://storage.elevenlabs.io/sarah.mp3",
  },
  {
    voice_id: "v-masc",
    name: "Bill",
    gender: "masculina",
    accent: null,
    language: null,
    category: "premade",
    description: null,
    preview_url: null,
  },
  {
    voice_id: "v-clone",
    name: "Voz Clonada",
    gender: "neutra",
    accent: null,
    language: null,
    category: "cloned",
    description: null,
    preview_url: null,
  },
];

describe("ElevenLabsVoiceSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    maybeSingleMock.mockResolvedValue({
      data: { voice_id: "v-fem", voice_model: "eleven_multilingual_v2" },
      error: null,
    });
    invokeMock.mockResolvedValue({ data: { ok: true, voices: VOICES }, error: null });
  });

  it("lista as vozes da conta com nome e ID e marca a voz salva", async () => {
    renderWithQueryClient(<ElevenLabsVoiceSettings />);

    await waitFor(() => expect(invokeMock).toHaveBeenCalled());
    expect(invokeMock.mock.calls[0][0]).toBe("integration-connect");
    expect(invokeMock.mock.calls[0][1]).toMatchObject({
      body: { action: "list_voices", slug: "elevenlabs" },
    });

    // A voz salva aparece com o ID visível para conferência.
    await screen.findByText("ID: v-fem");
    expect(screen.getByText("Voz selecionada e salva.")).toBeInTheDocument();
  });

  it("informa ao checklist que existe uma voz salva", async () => {
    const onVoiceConfigured = vi.fn();
    renderWithQueryClient(<ElevenLabsVoiceSettings onVoiceConfigured={onVoiceConfigured} />);

    await waitFor(() => expect(onVoiceConfigured).toHaveBeenCalledWith(true));
  });

  it("filtra por gênero sem perder a lista carregada", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<ElevenLabsVoiceSettings />);

    const masculinas = await screen.findByRole("button", { name: "Masculinas" });
    await user.click(masculinas);

    // O filtro é aplicado sobre a lista já carregada; nenhuma chamada extra.
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("marca no dropdown as vozes que não são 'premade' como plano pago", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<ElevenLabsVoiceSettings />);

    const trigger = await screen.findByLabelText("Voz do assistente");
    await user.click(trigger);

    const options = await screen.findAllByRole("option");
    const clonada = options.find((o) => o.textContent?.includes("Voz Clonada"));
    const premade = options.find((o) => o.textContent?.includes("Sarah"));
    expect(clonada).toBeDefined();
    expect(premade).toBeDefined();

    // Categoria "cloned" exige plano pago: precisa do aviso na própria opção.
    expect(within(clonada!).getByText("Plano pago")).toBeInTheDocument();
    // Categoria "premade" funciona no free: não pode ganhar o aviso.
    expect(within(premade!).queryByText("Plano pago")).not.toBeInTheDocument();
  });

  it("mostra o aviso de plano pago ao selecionar voz fora de 'premade'", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<ElevenLabsVoiceSettings />);

    // Voz salva (v-fem) é "premade": sem aviso na área de detalhes.
    await screen.findByText("ID: v-fem");
    const details = screen.getByTestId("selected-voice-details");
    expect(within(details).queryByText("Plano pago")).not.toBeInTheDocument();

    const trigger = screen.getByLabelText("Voz do assistente");
    await user.click(trigger);
    const options = await screen.findAllByRole("option");
    const clonada = options.find((o) => o.textContent?.includes("Voz Clonada"));
    await user.click(clonada!);

    await screen.findByText("ID: v-clone");
    expect(within(details).getByText("Plano pago")).toBeInTheDocument();
  });

  it("cai no campo manual de ID quando a listagem falha", async () => {
    invokeMock.mockResolvedValue({
      data: { ok: false, error: "A ElevenLabs recusou a chave de API." },
      error: null,
    });

    renderWithQueryClient(<ElevenLabsVoiceSettings />);

    await screen.findByText("A ElevenLabs recusou a chave de API.");
    const input = screen.getByLabelText("Voz do assistente") as HTMLInputElement;
    expect(input.value).toBe("v-fem");
  });

  // Defeito visual visto em produção (2026-08-04): cada voz ocupava DUAS linhas
  // e a segunda era o voice_id cru. Além do ruído, quando o scroll cortava o
  // item de cima sobrava um ID órfão sem nome no topo da lista — e o
  // SelectValue reaproveita este markup, então o campo fechado herdava tudo.
  it("não exibe o voice_id cru nas opções do dropdown", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<ElevenLabsVoiceSettings />);

    const trigger = await screen.findByLabelText("Voz do assistente");
    await user.click(trigger);

    const options = await screen.findAllByRole("option");
    expect(options.length).toBeGreaterThan(0);
    for (const o of options) {
      const txt = o.textContent ?? "";
      expect(txt).not.toContain("v-fem");
      expect(txt).not.toContain("v-masc");
      expect(txt).not.toContain("v-clone");
    }
  });
});
