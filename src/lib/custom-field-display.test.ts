import { describe, expect, it } from "vitest";
import { formatCustomFieldValue, type CustomFieldColumn } from "./custom-field-display";

function makeColumn(overrides: Partial<CustomFieldColumn> = {}): CustomFieldColumn {
  return {
    key: "campo_teste",
    label: "Campo Teste",
    fieldType: "text",
    options: [],
    ...overrides,
  };
}

describe("formatCustomFieldValue — vazio", () => {
  it("undefined vira placeholder", () => {
    expect(formatCustomFieldValue(makeColumn(), undefined)).toBe("—");
  });

  it("null vira placeholder", () => {
    expect(formatCustomFieldValue(makeColumn(), null)).toBe("—");
  });

  it("string vazia vira placeholder", () => {
    expect(formatCustomFieldValue(makeColumn(), "")).toBe("—");
  });
});

describe("formatCustomFieldValue — text/number", () => {
  it("texto passa direto", () => {
    expect(formatCustomFieldValue(makeColumn({ fieldType: "text" }), "abc")).toBe("abc");
  });

  it("número vira string", () => {
    expect(formatCustomFieldValue(makeColumn({ fieldType: "number" }), 42)).toBe("42");
  });
});

describe("formatCustomFieldValue — currency", () => {
  it("formata número como BRL", () => {
    const result = formatCustomFieldValue(makeColumn({ fieldType: "currency" }), 1500);
    expect(result).toContain("1.500");
    expect(result).toMatch(/R\$/);
  });

  it("valor não-numérico cai no String() bruto", () => {
    expect(formatCustomFieldValue(makeColumn({ fieldType: "currency" }), "N/A")).toBe("N/A");
  });
});

describe("formatCustomFieldValue — date", () => {
  it("formata string ISO como dd/MM/yyyy", () => {
    // "T00:00:00" sem "Z" -- interpretado em horário local, mesmo padrão de
    // format.test.ts, para não depender do fuso horário de quem roda o teste.
    expect(formatCustomFieldValue(makeColumn({ fieldType: "date" }), "2026-07-09T00:00:00")).toBe(
      "09/07/2026",
    );
  });
});

describe("formatCustomFieldValue — boolean", () => {
  it("true vira Sim", () => {
    expect(formatCustomFieldValue(makeColumn({ fieldType: "boolean" }), true)).toBe("Sim");
  });

  it("false vira Não", () => {
    expect(formatCustomFieldValue(makeColumn({ fieldType: "boolean" }), false)).toBe("Não");
  });
});

describe("formatCustomFieldValue — select", () => {
  const column = makeColumn({
    fieldType: "select",
    options: [
      { value: "a", label: "Opção A" },
      { value: "b", label: "Opção B" },
    ],
  });

  it("resolve o label da opção", () => {
    expect(formatCustomFieldValue(column, "a")).toBe("Opção A");
  });

  it("valor fora de options cai no valor bruto", () => {
    expect(formatCustomFieldValue(column, "z")).toBe("z");
  });
});

describe("formatCustomFieldValue — multiselect", () => {
  const column = makeColumn({
    fieldType: "multiselect",
    options: [
      { value: "a", label: "Opção A" },
      { value: "b", label: "Opção B" },
    ],
  });

  it("junta os labels com vírgula", () => {
    expect(formatCustomFieldValue(column, ["a", "b"])).toBe("Opção A, Opção B");
  });

  it("valor fora de options cai no valor bruto dentro da lista", () => {
    expect(formatCustomFieldValue(column, ["a", "z"])).toBe("Opção A, z");
  });

  it("array vazio vira placeholder (tratado como vazio)", () => {
    expect(formatCustomFieldValue(column, [])).toBe("—");
  });
});
