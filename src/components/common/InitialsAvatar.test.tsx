import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { iniciaisDe, InitialsAvatar } from "./InitialsAvatar";

describe("iniciaisDe", () => {
  it("usa primeira e última palavra, não as duas primeiras", () => {
    // Antes havia duas regras: a topbar fazia primeira+última e as listas as
    // duas primeiras. A mesma pessoa aparecia como "JS" no topo e "JP" na lista.
    expect(iniciaisDe("João Pedro Silva")).toBe("JS");
  });

  it("nome simples repete só a inicial", () => {
    expect(iniciaisDe("Ana")).toBe("A");
  });

  it("nome vazio, nulo ou só espaços vira '?'", () => {
    expect(iniciaisDe("")).toBe("?");
    expect(iniciaisDe(null)).toBe("?");
    expect(iniciaisDe(undefined)).toBe("?");
    expect(iniciaisDe("   ")).toBe("?");
  });

  it("ignora espaços extras entre as palavras", () => {
    expect(iniciaisDe("  maria   souza  ")).toBe("MS");
  });
});

describe("InitialsAvatar", () => {
  it("toda variante traz o par cor/fundo — nunca só o fundo", () => {
    // O bug que originou o componente: um dos usos declarava apenas
    // `text-caption`, herdava `--foreground` sobre `bg-primary` e ficava em
    // 2.75:1. Fundo sem a cor correspondente é o defeito a barrar.
    const pares = [
      ["brand", "bg-primary", "text-primary-foreground"],
      ["muted", "bg-muted", "text-muted-foreground"],
      ["accent", "bg-accent", "text-accent-foreground"],
    ] as const;

    for (const [variante, fundo, cor] of pares) {
      const { unmount } = render(<InitialsAvatar name="Ana Souza" variant={variante} />);
      const el = screen.getByText("AS");
      expect(el.className).toContain(fundo);
      expect(el.className).toContain(cor);
      unmount();
    }
  });

  it("dimensão e tamanho de texto andam em par", () => {
    const { unmount } = render(<InitialsAvatar name="Ana Souza" size="2xl" />);
    expect(screen.getByText("AS").className).toContain("text-body");
    unmount();

    render(<InitialsAvatar name="Ana Souza" size="xs" />);
    expect(screen.getByText("AS").className).toContain("text-caption");
  });

  it("className extra não sobrescreve a cor da variante", () => {
    render(<InitialsAvatar name="Ana Souza" variant="brand" className="ring-2" />);
    expect(screen.getByText("AS").className).toContain("text-primary-foreground");
  });
});
