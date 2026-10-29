import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithQueryClient } from "@/test/render";
import { NODE_VERIFY_SNIPPET } from "@/components/settings/developer/verify-snippets";
import { Route } from "./_app.documentacao.webhooks";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  const { routerOverrides } = await import("@/test/router-mocks");
  return { ...actual, ...routerOverrides() };
});

const DocsPage = Route.options.component!;

describe("head() da documentação de webhooks", () => {
  it("define título sem canonical nem og:url fixos (página autenticada, template de remix)", async () => {
    const head = await Route.options.head?.({} as never);
    expect(head?.meta?.find((m) => m && "title" in m)).toMatchObject({
      title: "Documentação de webhooks",
    });
    expect(head?.links ?? []).toEqual([]);
    expect(head?.meta?.some((m) => m && "property" in m && m.property === "og:url")).toBe(false);
  });
});

describe("hash da URL", () => {
  it("hash malformado não quebra a página", () => {
    window.location.hash = "#%E0";
    try {
      renderWithQueryClient(<DocsPage />);
      expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    } finally {
      window.location.hash = "";
    }
  });
});

describe("página /documentacao/webhooks", () => {
  it("renderiza o README real com um único h1 e as seções principais", () => {
    renderWithQueryClient(<DocsPage />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Documentação de webhooks");
    for (const [id, name] of [
      ["comece", "Comece em 5 minutos"],
      ["saida", "Webhooks de saída"],
      ["assinatura", "Verificar a assinatura"],
      ["entrada", "Regras de entrada"],
      ["api", "API pública"],
    ]) {
      expect(screen.getByRole("heading", { level: 2, name })).toHaveAttribute("id", id);
    }
    // O índice do README vira a navegação lateral, não aparece duplicado no corpo.
    expect(screen.queryByRole("heading", { name: "Índice" })).toBeNull();
  });

  it("índice aponta para as âncoras das seções", () => {
    renderWithQueryClient(<DocsPage />);
    const navs = screen.getAllByRole("navigation", { name: "Nesta página" });
    expect(navs.length).toBeGreaterThan(0);
    const hrefs = within(navs[0])
      .getAllByRole("link")
      .map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(expect.arrayContaining(["#comece", "#saida", "#entrada", "#api"]));
    for (const href of hrefs) expect(document.getElementById(href!.slice(1))).not.toBeNull();
  });

  it("botão Copiar do bloco Node copia o snippet de verificação", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    renderWithQueryClient(<DocsPage />);
    await user.click(screen.getByRole("button", { name: "Copiar código (js)" }));
    expect(writeText).toHaveBeenLastCalledWith(NODE_VERIFY_SNIPPET.trimEnd());
    // Leitor de tela ouve a confirmação (região aria-live).
    const live = [...document.querySelectorAll('[aria-live="polite"]')].map((n) => n.textContent);
    expect(live).toContain("Copiado");
  });

  it("volta para a aba Desenvolvedores e linka a OpenAPI do projeto", () => {
    renderWithQueryClient(<DocsPage />);
    expect(screen.getByRole("link", { name: /Voltar para configurações/ })).toHaveAttribute(
      "href",
      "/configuracoes#desenvolvedores",
    );
    const spec = screen.getByRole("link", { name: /Especificação OpenAPI/ });
    expect(spec).toHaveAttribute(
      "href",
      "https://test.supabase.co/functions/v1/public-api/v1/openapi.json",
    );
    expect(spec).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("tabelas e blocos de código rolam na horizontal em tela estreita", () => {
    const { container } = renderWithQueryClient(<DocsPage />);
    for (const table of container.querySelectorAll("table")) {
      expect(table.parentElement).toHaveClass("overflow-x-auto", "min-w-0");
    }
    for (const pre of container.querySelectorAll("pre")) {
      expect(pre).toHaveClass("overflow-x-auto", "min-w-0", "max-w-full");
    }
    expect(container.querySelector("article")).toHaveClass("min-w-0");
  });
});

describe("navegação do índice", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Topo (px da janela) de cada h2 por id; o resto fica bem abaixo da dobra. */
  function mockTops(tops: Record<string, number>) {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      return { top: tops[this.id] ?? 5000 } as DOMRect;
    });
  }

  /** Fila de frames: o teste decide quando o rAF roda. */
  function mockFrames() {
    const queue: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => queue.push(cb));
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    return () => act(() => queue.splice(0).forEach((cb) => cb(0)));
  }

  function currentLinks() {
    return screen
      .getAllByRole("navigation", { name: "Nesta página" })
      .map((nav) => within(nav).queryAllByRole("link", { current: "location" }));
  }

  it("títulos têm margem de rolagem maior que o header fixo (3.5rem)", () => {
    renderWithQueryClient(<DocsPage />);
    expect(screen.getByRole("heading", { level: 2, name: "Regras de entrada" })).toHaveClass(
      "scroll-mt-20",
    );
  });

  it("no topo da página (nenhum h2 passou da linha) o primeiro item do índice fica marcado", () => {
    mockTops({ comece: 300 });
    renderWithQueryClient(<DocsPage />);
    const toc = screen.getAllByRole("navigation", { name: "Nesta página" })[0];
    const firstHref = within(toc).getAllByRole("link")[0].getAttribute("href");
    for (const links of currentLinks()) {
      expect(links).toHaveLength(1);
      expect(links[0]).toHaveAttribute("href", firstHref);
    }
  });

  it("marca o último h2 que passou da linha do header, um único aria-current por índice", () => {
    const tops: Record<string, number> = { comece: -900, saida: -400, assinatura: 100 };
    mockTops(tops);
    const runFrames = mockFrames();
    const { container } = renderWithQueryClient(<DocsPage />);
    for (const links of currentLinks()) {
      expect(links).toHaveLength(1);
      expect(links[0]).toHaveAttribute("href", "#assinatura");
    }

    // O h2 levado pelo índice para em 56 + 80 (scroll-mt-20) = 136 e já conta como ativo;
    // 145 fica abaixo da linha (56 + 80 + 8 = 144).
    Object.assign(tops, { assinatura: -100, entrada: 136, api: 145 });
    const scroller = container.firstElementChild!;
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);
    runFrames();
    for (const links of currentLinks()) {
      expect(links).toHaveLength(1);
      expect(links[0]).toHaveAttribute("href", "#entrada");
    }
  });

  it("rolado até o fim da página, o último h2 do índice fica ativo mesmo sem passar da linha", () => {
    mockTops({ comece: -900, saida: -400, api: 600 });
    const runFrames = mockFrames();
    const { container } = renderWithQueryClient(<DocsPage />);
    const scroller = container.firstElementChild!;
    Object.defineProperties(scroller, {
      scrollHeight: { value: 2000, configurable: true },
      clientHeight: { value: 800, configurable: true },
      scrollTop: { value: 1198, configurable: true },
    });
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    runFrames();
    const toc = screen.getAllByRole("navigation", { name: "Nesta página" })[0];
    const lastId = within(toc).getAllByRole("link").at(-1)!.getAttribute("href")!.slice(1);
    for (const links of currentLinks()) {
      expect(links).toHaveLength(1);
      expect(links[0]).toHaveAttribute("href", `#${lastId}`);
    }
  });

  it("no unmount remove o listener com a mesma flag de capture e cancela o frame pendente", () => {
    mockTops({});
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 42);
    const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const { container, unmount } = renderWithQueryClient(<DocsPage />);
    act(() => {
      container.firstElementChild!.dispatchEvent(new Event("scroll"));
    });
    unmount();
    const added = add.mock.calls.find(([type]) => type === "scroll")!;
    const removed = remove.mock.calls.find(([type]) => type === "scroll")!;
    expect(removed[1]).toBe(added[1]);
    expect(removed[2]).toMatchObject({ capture: true });
    expect(cancel).toHaveBeenCalledWith(42);
  });

  it("fecha o índice do celular ao escolher um item", async () => {
    const user = userEvent.setup();
    const { container } = renderWithQueryClient(<DocsPage />);
    const details = container.querySelector("details")!;
    details.open = true;
    await user.click(within(details).getByRole("link", { name: "Regras de entrada" }));
    expect(details.open).toBe(false);
  });
});
