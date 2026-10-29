import { describe, expect, it, vi, afterEach } from "vitest";
import { render } from "@testing-library/react";

import { ServiceWorkerRegister } from "./ServiceWorkerRegister";

describe("ServiceWorkerRegister", () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, "serviceWorker");
  });

  it("não renderiza nenhum elemento visível", () => {
    const { container } = render(<ServiceWorkerRegister />);
    expect(container).toBeEmptyDOMElement();
  });

  it("registra /sw.js quando o navegador suporta serviceWorker", () => {
    const register = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register },
    });

    render(<ServiceWorkerRegister />);

    expect(register).toHaveBeenCalledWith("/sw.js");
  });

  it("não quebra quando o navegador não suporta serviceWorker", () => {
    Reflect.deleteProperty(navigator, "serviceWorker");
    expect(() => render(<ServiceWorkerRegister />)).not.toThrow();
  });
});
