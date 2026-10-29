import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { RouterPendingFallback } from "./RouterPendingFallback";

describe("RouterPendingFallback", () => {
  it("renderiza um spinner full-height (estado de carregamento do router)", () => {
    const { container } = render(<RouterPendingFallback />);

    const spinner = container.querySelector("svg.animate-spin");
    expect(spinner).toBeInTheDocument();
    expect(spinner).toHaveAttribute("aria-hidden");
  });

  it("usa fixed inset-0 (overlay full-screen que escapa de qualquer grid/flex pai)", () => {
    // `pendingComponent`/`defaultPendingComponent` é renderizado por match
    // (ver Match.js do @tanstack/react-router), podendo ficar aninhado
    // dentro do grid de 12 colunas de src/routes/_app.tsx. `min-h-screen`
    // sozinho vira um item de grid estreito nesse caso -- `fixed inset-0`
    // tira o nó do fluxo do pai e o ancora no viewport inteiro.
    render(<RouterPendingFallback />);

    const overlay = screen.getByRole("status");
    expect(overlay.className).toContain("fixed");
    expect(overlay.className).toContain("inset-0");
  });
});
