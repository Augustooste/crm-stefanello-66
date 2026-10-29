import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { formatCopilotText } from "./copilot-text";

function html(text: string) {
  return render(<div>{formatCopilotText(text)}</div>).container.firstElementChild!;
}

describe("formatCopilotText", () => {
  it("negrito vira <strong> e os asteriscos somem", () => {
    const el = html("**Orion Logística — Eficiência Comercial e CRM** · R$ 250.000");
    expect(el.textContent).toBe("Orion Logística — Eficiência Comercial e CRM · R$ 250.000");
    expect(el.querySelector("strong")?.textContent).toBe(
      "Orion Logística — Eficiência Comercial e CRM",
    );
  });

  it("item de lista com * ou - vira marcador •, mantendo quebras de linha", () => {
    const el = html("Dados:\n*   **Valor:** R$ 180.000\n- Estágio: Diagnóstico");
    expect(el.textContent).toBe("Dados:\n• Valor: R$ 180.000\n• Estágio: Diagnóstico");
    expect(el.textContent).not.toContain("*");
  });

  it("texto sem markdown passa igual; ** sem par não quebra", () => {
    expect(html("Essa informação não está registrada no CRM.").textContent).toBe(
      "Essa informação não está registrada no CRM.",
    );
    expect(html("valor ** solto").textContent).toBe("valor  solto");
  });
});
