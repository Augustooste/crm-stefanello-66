import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { MissingEnvScreen } from "./MissingEnvScreen";
import { MissingEnvError } from "@/lib/env";

describe("MissingEnvScreen", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renderiza o título e a mensagem padrão", () => {
    render(<MissingEnvScreen error={new MissingEnvError([])} />);

    expect(screen.getByRole("heading", { name: "Backend não conectado" })).toBeInTheDocument();
    expect(screen.getByText(/Conecte o Lovable Cloud nas/)).toBeInTheDocument();
  });

  it("não renderiza a lista de variáveis quando `missing` está vazio", () => {
    render(<MissingEnvScreen error={new MissingEnvError([])} />);

    expect(screen.queryByText("Variáveis ausentes")).not.toBeInTheDocument();
  });

  it("lista cada variável ausente quando `missing` tem itens", () => {
    render(
      <MissingEnvScreen
        error={new MissingEnvError(["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY"])}
      />,
    );

    expect(screen.getByText("Variáveis ausentes")).toBeInTheDocument();
    expect(screen.getByText("SUPABASE_URL")).toBeInTheDocument();
    expect(screen.getByText("SUPABASE_PUBLISHABLE_KEY")).toBeInTheDocument();
  });

  it("recarrega a página ao clicar em 'Recarregar'", async () => {
    const reloadSpy = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload: reloadSpy });
    const user = userEvent.setup();

    render(<MissingEnvScreen error={new MissingEnvError([])} />);
    await user.click(screen.getByRole("button", { name: "Recarregar" }));

    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });
});
