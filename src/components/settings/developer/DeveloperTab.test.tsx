import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithQueryClient } from "@/test/render";
import { DeveloperTab } from "./DeveloperTab";
import { NODE_VERIFY_SNIPPET, PYTHON_VERIFY_SNIPPET } from "./verify-snippets";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  const { routerOverrides } = await import("@/test/router-mocks");
  return { ...actual, ...routerOverrides() };
});
vi.mock("./ApiKeysSection", () => ({ ApiKeysSection: () => <div data-testid="api-keys" /> }));
vi.mock("./WebhookEndpointsSection", () => ({
  WebhookEndpointsSection: () => <div data-testid="webhooks" />,
}));
vi.mock("./InboundRulesSection", () => ({
  InboundRulesSection: () => <div data-testid="inbound-rules" />,
}));

describe("DeveloperTab", () => {
  it("junta chaves, webhooks e o bloco de verificação de assinatura", () => {
    renderWithQueryClient(<DeveloperTab />);
    expect(screen.getByTestId("api-keys")).toBeInTheDocument();
    expect(screen.getByTestId("webhooks")).toBeInTheDocument();
    expect(screen.getByTestId("inbound-rules")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Como verificar a assinatura" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/tolerância de 300 segundos/)).toBeInTheDocument();
    expect(screen.getByText("/v1/openapi.json")).toBeInTheDocument();
  });

  it("alterna entre os exemplos Node e Python e copia o snippet certo", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    renderWithQueryClient(<DeveloperTab />);

    await user.click(screen.getByRole("button", { name: "Copiar exemplo em Node" }));
    expect(writeText).toHaveBeenLastCalledWith(NODE_VERIFY_SNIPPET);

    await user.click(screen.getByRole("tab", { name: "Python" }));
    await user.click(screen.getByRole("button", { name: "Copiar exemplo em Python" }));
    expect(writeText).toHaveBeenLastCalledWith(PYTHON_VERIFY_SNIPPET);
  });

  it("leva para a documentação de webhooks no topo e na seção de assinatura", () => {
    renderWithQueryClient(<DeveloperTab />);
    expect(
      screen.getByRole("link", { name: "Veja a documentação de webhooks e API" }),
    ).toHaveAttribute("href", "/documentacao/webhooks#comece");
    expect(screen.getByRole("link", { name: "Ajuda: verificar a assinatura" })).toHaveAttribute(
      "href",
      "/documentacao/webhooks#assinatura",
    );
  });

  it("link de documentação do topo tem tooltip, como os botões Ajuda das seções", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<DeveloperTab />);
    await user.hover(screen.getByRole("link", { name: "Veja a documentação de webhooks e API" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Abre a documentação de webhooks e API",
    );
  });
});
