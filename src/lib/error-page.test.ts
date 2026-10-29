import { describe, expect, it } from "vitest";
import { renderErrorPage } from "./error-page";

describe("renderErrorPage", () => {
  it("retorna um documento HTML completo", () => {
    const html = renderErrorPage();
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("</html>");
  });

  it("inclui o título e a mensagem de erro", () => {
    const html = renderErrorPage();
    expect(html).toContain("Esta página não carregou");
    expect(html).toContain("Algo deu errado do nosso lado");
  });

  it("inclui as ações de tentar novamente e voltar para a home", () => {
    const html = renderErrorPage();
    expect(html).toContain("Tentar novamente");
    expect(html).toContain('href="/"');
    expect(html).toContain("Voltar ao início");
  });
});
