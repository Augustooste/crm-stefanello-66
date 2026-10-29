import { describe, expect, it } from "vitest";

import { friendlyAdminError, validateInput } from "./team-members.functions";

const base = {
  name: "Fernanda",
  email: " Executiva.Expansao@Aceleraia.ia.br ",
  role: "admin" as const,
  password: "Acelera@2026",
};

describe("validateInput", () => {
  it("normaliza e-mail e mantém papel", () => {
    expect(validateInput(base)).toEqual({
      name: "Fernanda",
      email: "executiva.expansao@aceleraia.ia.br",
      role: "admin",
      password: "Acelera@2026",
    });
  });

  it("recusa nome vazio, e-mail inválido, papel desconhecido e senha curta", () => {
    expect(() => validateInput({ ...base, name: " " })).toThrow(/nome/i);
    expect(() => validateInput({ ...base, email: "sem-arroba" })).toThrow(/inválido/i);
    expect(() => validateInput({ ...base, role: "owner" as unknown as "admin" })).toThrow(/papel/i);
    expect(() => validateInput({ ...base, password: "1234" })).toThrow(/8 caracteres/);
  });
});

describe("friendlyAdminError", () => {
  it("traduz e-mail já cadastrado", () => {
    expect(
      friendlyAdminError("A user with this email address has already been registered"),
    ).toMatch(/já tem conta/);
  });

  it("não vaza detalhe cru desconhecido", () => {
    const msg = friendlyAdminError("connect ECONNREFUSED 10.0.0.1:5432");
    expect(msg).not.toMatch(/ECONNREFUSED/);
  });
});
