import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("cn — escala tipográfica do DS vs tailwind-merge", () => {
  it("cor declarada antes do tamanho sobrevive", () => {
    // Caso real que quebrou: as iniciais do avatar na topbar ficaram com a cor
    // do texto padrão sobre `bg-primary` (3.31:1, abaixo de AA) porque o merge
    // leu `text-caption` como cor e descartou `text-primary-foreground`.
    const r = cn("bg-primary text-primary-foreground text-caption font-semibold");
    expect(r).toContain("text-primary-foreground");
    expect(r).toContain("text-caption");
  });

  it("cor declarada depois do tamanho também sobrevive", () => {
    const r = cn("text-caption text-muted-foreground");
    expect(r).toContain("text-caption");
    expect(r).toContain("text-muted-foreground");
  });

  it("dois tamanhos da escala: vence o último, como manda o merge", () => {
    expect(cn("text-body text-caption")).toBe("text-caption");
    expect(cn("text-caption text-page-title")).toBe("text-page-title");
  });

  it("duas cores: vence a última", () => {
    expect(cn("text-primary text-destructive")).toBe("text-destructive");
  });

  it("tamanho da escala convive com tamanho nativo, o último vence", () => {
    expect(cn("text-caption text-xs")).toBe("text-xs");
    expect(cn("text-xs text-caption")).toBe("text-caption");
  });

  it("não quebra o comportamento normal do merge", () => {
    expect(cn("px-2 px-4")).toBe("px-4");
    expect(cn("bg-primary bg-muted")).toBe("bg-muted");
    const escondido = false;
    expect(cn(escondido && "hidden", "block")).toBe("block");
  });
});
