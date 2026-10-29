import { afterEach, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithQueryClient } from "@/test/render";
import { __resetAppearanceStoreForTests } from "@/lib/useAppearance";
import { AppearanceTab } from "./AppearanceTab";

afterEach(() => {
  document.documentElement.className = "";
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-skin");
  localStorage.clear();
  __resetAppearanceStoreForTests();
});

describe("AppearanceTab", () => {
  it("troca o tema para claro, refletindo em <html> e localStorage", async () => {
    document.documentElement.classList.add("dark");
    const user = userEvent.setup();
    renderWithQueryClient(<AppearanceTab />);

    await user.click(screen.getByRole("radio", { name: "Tema claro" }));

    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem("theme")).toBe("light");
  });

  it("ativa e desativa a skin power via data-skin/localStorage", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<AppearanceTab />);

    await user.click(screen.getByRole("radio", { name: "Visual Power" }));
    expect(document.documentElement.getAttribute("data-skin")).toBe("power");
    expect(localStorage.getItem("skin")).toBe("power");

    await user.click(screen.getByRole("radio", { name: "Visual Clean" }));
    expect(document.documentElement.getAttribute("data-skin")).toBeNull();
    expect(localStorage.getItem("skin")).toBe("clean");
  });

  it("ativa a skin profundo e volta para clean sem resíduo no <html>", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<AppearanceTab />);

    await user.click(screen.getByRole("radio", { name: "Visual Profundo" }));
    expect(document.documentElement.getAttribute("data-skin")).toBe("profundo");
    expect(localStorage.getItem("skin")).toBe("profundo");

    await user.click(screen.getByRole("radio", { name: "Visual Clean" }));
    expect(document.documentElement.getAttribute("data-skin")).toBeNull();
    expect(localStorage.getItem("skin")).toBe("clean");
  });

  it("desabilita o Tema enquanto a skin tem campo escuro próprio", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<AppearanceTab />);

    expect(screen.getByRole("radio", { name: "Tema claro" })).toBeEnabled();

    await user.click(screen.getByRole("radio", { name: "Visual Profundo" }));

    // A escolha de tema não muda nada sob Profundo/Power: melhor desabilitar do
    // que oferecer um controle que a tela ignora.
    expect(screen.getByRole("radio", { name: "Tema claro" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Tema escuro" })).toBeDisabled();

    await user.click(screen.getByRole("radio", { name: "Visual Clean" }));

    expect(screen.getByRole("radio", { name: "Tema claro" })).toBeEnabled();
  });

  it("troca direto de profundo para power (sem passar por clean)", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<AppearanceTab />);

    await user.click(screen.getByRole("radio", { name: "Visual Profundo" }));
    await user.click(screen.getByRole("radio", { name: "Visual Power" }));

    expect(document.documentElement.getAttribute("data-skin")).toBe("power");
    expect(localStorage.getItem("skin")).toBe("power");
  });
});
