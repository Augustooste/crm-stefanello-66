import { describe, expect, it } from "vitest";
import { validateCustomFieldValue, type CustomFieldDefinition } from "./custom-fields";

function makeDefinition(overrides: Partial<CustomFieldDefinition> = {}): CustomFieldDefinition {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    tenantId: "00000000-0000-0000-0000-000000000002",
    entity: "contact",
    key: "campo_teste",
    label: "Campo Teste",
    fieldType: "text",
    options: [],
    required: false,
    position: 0,
    ...overrides,
  };
}

describe("validateCustomFieldValue — text", () => {
  it("aceita string", () => {
    expect(validateCustomFieldValue(makeDefinition({ fieldType: "text" }), "abc")).toEqual({
      valid: true,
    });
  });

  it("rejeita não-string", () => {
    const result = validateCustomFieldValue(makeDefinition({ fieldType: "text" }), 123);
    expect(result.valid).toBe(false);
  });
});

describe("validateCustomFieldValue — number", () => {
  it("aceita número", () => {
    expect(validateCustomFieldValue(makeDefinition({ fieldType: "number" }), 42)).toEqual({
      valid: true,
    });
  });

  it("rejeita string numérica (sem coerção)", () => {
    const result = validateCustomFieldValue(makeDefinition({ fieldType: "number" }), "42");
    expect(result.valid).toBe(false);
  });

  it("rejeita NaN", () => {
    const result = validateCustomFieldValue(makeDefinition({ fieldType: "number" }), NaN);
    expect(result.valid).toBe(false);
  });
});

describe("validateCustomFieldValue — currency", () => {
  it("aceita número", () => {
    expect(validateCustomFieldValue(makeDefinition({ fieldType: "currency" }), 199.9)).toEqual({
      valid: true,
    });
  });

  it("rejeita não-número", () => {
    const result = validateCustomFieldValue(makeDefinition({ fieldType: "currency" }), "199,90");
    expect(result.valid).toBe(false);
  });
});

describe("validateCustomFieldValue — date", () => {
  it("aceita string de data ISO válida", () => {
    expect(validateCustomFieldValue(makeDefinition({ fieldType: "date" }), "2026-07-09")).toEqual({
      valid: true,
    });
  });

  it("rejeita string inválida", () => {
    const result = validateCustomFieldValue(makeDefinition({ fieldType: "date" }), "not-a-date");
    expect(result.valid).toBe(false);
  });
});

describe("validateCustomFieldValue — boolean", () => {
  it("aceita true/false", () => {
    expect(validateCustomFieldValue(makeDefinition({ fieldType: "boolean" }), true)).toEqual({
      valid: true,
    });
    expect(validateCustomFieldValue(makeDefinition({ fieldType: "boolean" }), false)).toEqual({
      valid: true,
    });
  });

  it("rejeita string 'true'", () => {
    const result = validateCustomFieldValue(makeDefinition({ fieldType: "boolean" }), "true");
    expect(result.valid).toBe(false);
  });
});

describe("validateCustomFieldValue — select", () => {
  const definition = makeDefinition({
    fieldType: "select",
    options: [
      { value: "a", label: "Opção A" },
      { value: "b", label: "Opção B" },
    ],
  });

  it("aceita valor dentro de options", () => {
    expect(validateCustomFieldValue(definition, "a")).toEqual({ valid: true });
  });

  it("rejeita valor fora de options", () => {
    const result = validateCustomFieldValue(definition, "z");
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("z");
  });

  it("rejeita array (não é select único)", () => {
    const result = validateCustomFieldValue(definition, ["a"]);
    expect(result.valid).toBe(false);
  });
});

describe("validateCustomFieldValue — multiselect", () => {
  const definition = makeDefinition({
    fieldType: "multiselect",
    options: [
      { value: "a", label: "Opção A" },
      { value: "b", label: "Opção B" },
    ],
  });

  it("aceita array com todos os valores em options", () => {
    expect(validateCustomFieldValue(definition, ["a", "b"])).toEqual({ valid: true });
  });

  it("rejeita array com valor fora de options", () => {
    const result = validateCustomFieldValue(definition, ["a", "z"]);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("z");
  });

  it("rejeita não-array", () => {
    const result = validateCustomFieldValue(definition, "a");
    expect(result.valid).toBe(false);
  });

  it("array vazio não-required é válido", () => {
    expect(validateCustomFieldValue(definition, [])).toEqual({ valid: true });
  });

  it("array vazio required é inválido", () => {
    const required = makeDefinition({ ...definition, required: true });
    const result = validateCustomFieldValue(required, []);
    expect(result.valid).toBe(false);
  });
});

describe("validateCustomFieldValue — required", () => {
  it("undefined em campo required falha", () => {
    const result = validateCustomFieldValue(makeDefinition({ required: true }), undefined);
    expect(result.valid).toBe(false);
  });

  it("null em campo required falha", () => {
    const result = validateCustomFieldValue(makeDefinition({ required: true }), null);
    expect(result.valid).toBe(false);
  });

  it("string vazia em campo required falha", () => {
    const result = validateCustomFieldValue(makeDefinition({ required: true }), "");
    expect(result.valid).toBe(false);
  });

  it("undefined em campo não-required passa", () => {
    expect(validateCustomFieldValue(makeDefinition({ required: false }), undefined)).toEqual({
      valid: true,
    });
  });
});
