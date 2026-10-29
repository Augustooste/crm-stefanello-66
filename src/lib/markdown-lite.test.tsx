import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  MarkdownLite,
  isSafeHref,
  parseMarkdown,
  renderInline,
  slugify,
  tocFromBlocks,
} from "./markdown-lite";

function renderMd(source: string) {
  return render(<MarkdownLite blocks={parseMarkdown(source)} />);
}

describe("slugify", () => {
  it("tira acento, caixa e pontuação", () => {
    expect(slugify("Regras de entrada: Stripe")).toBe("regras-de-entrada-stripe");
    expect(slugify("Histórico e solução de problemas")).toBe("historico-e-solucao-de-problemas");
    expect(slugify("  --  ")).toBe("secao");
  });
});

describe("parseMarkdown: títulos e âncoras", () => {
  it("gera id por slug e desduplica repetidos", () => {
    const blocks = parseMarkdown("## Exemplo\n\n## Exemplo\n\n### Saída e entrada");
    expect(blocks.map((b) => (b.type === "heading" ? b.id : null))).toEqual([
      "exemplo",
      "exemplo-2",
      "saida-e-entrada",
    ]);
  });

  it("usa a âncora explícita <a id> da linha anterior", () => {
    const blocks = parseMarkdown('<a id="saida"></a>\n\n## Webhooks de saída');
    expect(blocks).toEqual([{ type: "heading", level: 2, text: "Webhooks de saída", id: "saida" }]);
  });

  it("recusa âncora explícita que repete o id de um título anterior", () => {
    expect(() => parseMarkdown('## X\n\n<a id="x"></a>\n\n## Outro')).toThrow(/âncora duplicada/);
  });

  it("ignora âncora com id fora do padrão e comentário HTML", () => {
    const blocks = parseMarkdown('<!-- prettier-ignore -->\n<a id="x y"></a>\n\n## Título');
    expect(blocks[0]).toMatchObject({ type: "paragraph" });
    expect(blocks.find((b) => b.type === "heading")).toMatchObject({ id: "titulo" });
    expect(JSON.stringify(blocks)).not.toContain("prettier-ignore");
  });

  it("renderiza h1 a h4 com id e índice só dos h2", () => {
    const blocks = parseMarkdown("# Um\n\n## Dois\n\n### Três\n\n#### Quatro");
    renderMd("# Um\n\n## Dois\n\n### Três\n\n#### Quatro");
    for (const [level, name] of [
      [1, "Um"],
      [2, "Dois"],
      [3, "Três"],
      [4, "Quatro"],
    ] as const) {
      expect(screen.getByRole("heading", { level, name })).toHaveAttribute("id", slugify(name));
    }
    expect(tocFromBlocks(blocks)).toEqual([{ id: "dois", text: "Dois" }]);
  });
});

describe("parseMarkdown: blocos", () => {
  it("lista com e sem número", () => {
    renderMd("- um\n- dois\n\n1. primeiro\n2. segundo");
    const lists = screen.getAllByRole("list");
    expect(lists[0].tagName).toBe("UL");
    expect(lists[1].tagName).toBe("OL");
    expect(within(lists[1]).getAllByRole("listitem")).toHaveLength(2);
  });

  it("tabela com cabeçalho, alinhamento e pipe escapado", () => {
    renderMd("| Código | Quando |\n| :----: | ------ |\n| `200` | a \\| b |\n| 401 | nunca |");
    const table = screen.getByRole("table");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((c) => c.textContent),
    ).toEqual(["Código", "Quando"]);
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(within(table).getByText("a | b")).toBeInTheDocument();
    expect(table.closest("div")).toHaveClass("overflow-x-auto");
  });

  it("blockquote vira aviso (role note), sem role alert", () => {
    renderMd("> **Atenção:** guarde o segredo.\n> Segunda linha.");
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("Atenção: guarde o segredo. Segunda linha.");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("bloco de código preserva o conteúdo e copia exatamente", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    const code = 'curl -X POST "https://exemplo.com"\n  -d \'{"a": 1}\'';
    renderMd("```bash\n" + code + "\n```");
    expect(screen.getByText(/curl -X POST/).closest("pre")).toHaveClass("overflow-x-auto");
    await user.click(screen.getByRole("button", { name: "Copiar código (bash)" }));
    expect(writeText).toHaveBeenLastCalledWith(code);
  });

  it("linha horizontal", () => {
    const { container } = renderMd("antes\n\n---\n\ndepois");
    expect(container.querySelector("hr")).not.toBeNull();
  });
});

describe("inline", () => {
  it("negrito, itálico, código e link interno", () => {
    renderMd("Use **forte**, _leve_, *também* e `x_y_z` com [âncora](#saida).");
    expect(screen.getByText("forte").tagName).toBe("STRONG");
    expect(screen.getByText("leve").tagName).toBe("EM");
    expect(screen.getByText("também").tagName).toBe("EM");
    expect(screen.getByText("x_y_z").tagName).toBe("CODE");
    const link = screen.getByRole("link", { name: "âncora" });
    expect(link).toHaveAttribute("href", "#saida");
    expect(link).not.toHaveAttribute("target");
  });

  it("não vira itálico dentro de snake_case", () => {
    renderMd("modo aceleraflow_hmac_x aqui");
    expect(screen.getByText("modo aceleraflow_hmac_x aqui").tagName).toBe("P");
  });

  it("link externo abre em nova aba com noopener noreferrer", () => {
    renderMd("Veja [Stripe](https://docs.stripe.com/webhooks).");
    // O nome acessível avisa a nova aba (WCAG 3.2.5), como o botão da OpenAPI.
    const link = screen.getByRole("link", { name: "Stripe (abre em nova aba)" });
    expect(link).toHaveAttribute("href", "https://docs.stripe.com/webhooks");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });
});

describe("segurança", () => {
  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    " javascript:alert(1)",
    "\tjavascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox",
    "//evil.example.com",
    "/\\evil.example.com",
    "#x y",
    "https://exemplo.com\nhttps://outro",
  ])("isSafeHref recusa %j", (href) => {
    expect(isSafeHref(href)).toBe(false);
  });

  it.each(["https://exemplo.com/a?b=1", "http://exemplo.com", "/configuracoes", "#saida"])(
    "isSafeHref aceita %j",
    (href) => {
      expect(isSafeHref(href)).toBe(true);
    },
  );

  it("link perigoso vira texto, sem <a>", () => {
    const { container } = renderMd("[clique](javascript:alert(1)) e [x](JAVASCRIPT:void0)");
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("clique e x");
  });

  it("HTML cru aparece escapado como texto", () => {
    const { container } = renderMd(
      '<script>alert(1)</script>\n\nTexto <img src=x onerror="alert(1)"> e <b>negrito</b>',
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
  });

  it("HTML dentro de bloco de código e de célula de tabela fica como texto", () => {
    const { container } = renderMd(
      '```html\n<iframe src="https://evil"></iframe>\n```\n\n| a |\n| - |\n| <svg onload=alert(1)> |',
    );
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector("[onload]")).toBeNull();
    expect(container.textContent).toContain("<svg onload=alert(1)>");
  });
});

describe("desempenho do inline", () => {
  // Antes era O(n²): 60 KB de " *a" levavam cerca de 1,1 s só na regex. Mede renderInline
  // (regex + árvore React), sem o custo do DOM do jsdom.
  it.each([" *a", " _a", " [a", " **a *b"])("60 KB de %j processam em menos de 200 ms", (unit) => {
    const text = unit.repeat(Math.ceil(60_000 / unit.length));
    const started = performance.now();
    const nodes = renderInline(text);
    expect(performance.now() - started).toBeLessThan(200);
    expect(nodes.length).toBeGreaterThan(0);
  });

  it("itálico, negrito e link continuam funcionando", () => {
    const { container } = renderMd("um *dois* _três_ [quatro](#x) **cinco**");
    expect([...container.querySelectorAll("em")].map((e) => e.textContent)).toEqual([
      "dois",
      "três",
    ]);
    expect(container.querySelector('a[href="#x"]')?.textContent).toBe("quatro");
    expect(container.querySelector("strong")?.textContent).toBe("cinco");
  });
});
