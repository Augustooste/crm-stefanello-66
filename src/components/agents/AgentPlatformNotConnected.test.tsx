import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// <Link> do TanStack Router precisa de RouterProvider real -- trocamos por
// uma <a> simples (mesmo helper compartilhado usado em outras rotas/telas
// com Link, ver src/test/router-mocks.tsx).
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  const { routerOverrides } = await import("@/test/router-mocks");
  return { ...actual, ...routerOverrides() };
});

import { AgentPlatformNotConnected } from "./AgentPlatformNotConnected";

describe("AgentPlatformNotConnected", () => {
  it("explica que o provedor de agentes não está conectado e linka para Integrações e Plugins", () => {
    render(<AgentPlatformNotConnected />);

    expect(screen.getByText("provedor de agentes não conectado")).toBeInTheDocument();
    expect(screen.getByText(/Configurações > Integrações e Plugins/)).toBeInTheDocument();

    const link = screen.getByRole("link", { name: /Integrações e Plugins/i });
    expect(link).toHaveAttribute("href", "/configuracoes#plugins");
  });

  it("não mostra nenhum formulário de credencial nesta tela", () => {
    render(<AgentPlatformNotConnected />);

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});
