import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";

import { useAppearance, __resetAppearanceStoreForTests } from "./useAppearance";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

afterEach(() => {
  document.documentElement.className = "";
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-skin");
  localStorage.clear();
  __resetAppearanceStoreForTests();
});

// Dois consumidores independentes do hook — provam que compartilham a fonte.
function Probe({ id }: { id: string }) {
  const { theme, skin, setTheme, setSkin } = useAppearance();
  return (
    <div>
      <span data-testid={`theme-${id}`}>{theme}</span>
      <span data-testid={`skin-${id}`}>{skin}</span>
      <button onClick={() => setTheme("light")}>{`light-${id}`}</button>
      <button onClick={() => setSkin("power")}>{`skin-btn-${id}`}</button>
      <button onClick={() => setSkin("profundo")}>{`profundo-${id}`}</button>
    </div>
  );
}

describe("useAppearance (store compartilhado)", () => {
  it("mudança em um consumidor reflete imediatamente no outro (tema)", async () => {
    document.documentElement.classList.add("dark");
    const user = userEvent.setup();
    render(
      <>
        <Probe id="a" />
        <Probe id="b" />
      </>,
    );
    expect(screen.getByTestId("theme-a")).toHaveTextContent("dark");
    expect(screen.getByTestId("theme-b")).toHaveTextContent("dark");

    await user.click(screen.getByRole("button", { name: "light-a" }));

    // O consumidor B (não clicado) também atualiza — sem estado obsoleto.
    expect(screen.getByTestId("theme-b")).toHaveTextContent("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem("theme")).toBe("light");
  });

  it("mudança de skin também sincroniza entre consumidores", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Probe id="a" />
        <Probe id="b" />
      </>,
    );
    await user.click(screen.getByRole("button", { name: "skin-btn-a" }));

    expect(screen.getByTestId("skin-b")).toHaveTextContent("power");
    expect(document.documentElement.getAttribute("data-skin")).toBe("power");
    expect(localStorage.getItem("skin")).toBe("power");
  });

  it("avisa quando o navegador recusa salvar a preferência", async () => {
    const user = userEvent.setup();
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });

    render(<Probe id="a" />);
    await user.click(screen.getByRole("button", { name: "profundo-a" }));

    // A skin aplica na tela; o que não sobrevive ao reload é a preferência.
    expect(document.documentElement.getAttribute("data-skin")).toBe("profundo");
    expect(toast.error).toHaveBeenCalledWith(
      "Não deu para salvar sua preferência neste navegador.",
      expect.objectContaining({ description: "A aparência escolhida vale só nesta sessão." }),
    );

    setItem.mockRestore();
  });

  it("hidrata a skin do atributo data-skin já presente no <html>", () => {
    document.documentElement.setAttribute("data-skin", "profundo");

    render(<Probe id="a" />);

    expect(screen.getByTestId("skin-a")).toHaveTextContent("profundo");
  });

  it("hidrata o tema do localStorage, não da classe do <html>", () => {
    // Com skin de campo escuro o <html> fica com .dark mesmo na preferência
    // clara — ler a classe devolveria "dark" e apagaria a escolha do usuário.
    localStorage.setItem("theme", "light");
    document.documentElement.classList.add("dark");
    document.documentElement.setAttribute("data-skin", "profundo");

    render(<Probe id="a" />);

    expect(screen.getByTestId("theme-a")).toHaveTextContent("light");
  });

  it("valor desconhecido em data-skin cai em clean e sai do <html>", () => {
    document.documentElement.setAttribute("data-skin", "eletrico");

    render(<Probe id="a" />);

    expect(screen.getByTestId("skin-a")).toHaveTextContent("clean");
    // Sem remover, o store diz clean e o DOM segue com um valor que a UI nega.
    expect(document.documentElement.getAttribute("data-skin")).toBeNull();
  });

  it("skin de campo escuro segura a variante dark mesmo com tema claro", async () => {
    const user = userEvent.setup();
    render(<Probe id="a" />);

    await user.click(screen.getByRole("button", { name: "light-a" }));
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    await user.click(screen.getByRole("button", { name: "profundo-a" }));

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    // A preferência do usuário continua "light" e volta a valer no Clean.
    expect(screen.getByTestId("theme-a")).toHaveTextContent("light");
    expect(localStorage.getItem("theme")).toBe("light");
  });
});
