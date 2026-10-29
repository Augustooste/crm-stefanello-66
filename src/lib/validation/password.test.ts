import { describe, expect, it } from "vitest";

import { passwordSchema } from "./password";

describe("passwordSchema", () => {
  it("rejeita senha com menos de 8 caracteres", () => {
    expect(passwordSchema.safeParse("123456").success).toBe(false);
  });

  it("rejeita senha só com dígitos", () => {
    expect(passwordSchema.safeParse("12345678").success).toBe(false);
  });

  it("rejeita senha com um único caractere repetido", () => {
    expect(passwordSchema.safeParse("aaaaaaaa").success).toBe(false);
  });

  it("aceita senha com 8+ caracteres que não é trivial", () => {
    expect(passwordSchema.safeParse("senha-de-teste").success).toBe(true);
  });
});
