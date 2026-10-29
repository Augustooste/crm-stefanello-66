import { describe, expect, it } from "vitest";
import {
  friendlyIntegrationError,
  remediationHint,
  userFacingErrorMessage,
  userFacingFailureMessage,
} from "./friendly-errors";

describe("friendlyIntegrationError", () => {
  it("traduz erro de token do Z-API para instrução acionável", () => {
    const r = friendlyIntegrationError("zapi", "invalid instance token");
    expect(r.isGeneric).toBe(false);
    expect(r.message).toMatch(/Instance Token do Z-API/);
  });

  it("traduz falha de rede em qualquer provedor", () => {
    const r = friendlyIntegrationError("resend", "failed to fetch");
    expect(r.isGeneric).toBe(false);
    expect(r.message).toMatch(/tente novamente/i);
  });

  it("cai no genérico quando não conhece o erro", () => {
    const r = friendlyIntegrationError("resend", "erro inesperado 999");
    expect(r.isGeneric).toBe(true);
    expect(r.message).toMatch(/Não conseguimos concluir/);
  });

  it("retorna genérico quando erro é nulo/vazio", () => {
    expect(friendlyIntegrationError("zapi", null).isGeneric).toBe(true);
    expect(friendlyIntegrationError("zapi", "").isGeneric).toBe(true);
  });

  it("não confunde HTTP 401 da Evolution com URL inválida", () => {
    const r = friendlyIntegrationError(
      "evolution",
      "Evolution respondeu HTTP 401 em /instance/status.",
    );
    expect(r.message).toMatch(/recusou as credenciais/i);
    expect(r.message).not.toMatch(/URL da API/);
  });

  it("mantém a mensagem de URL para erro de endereço da Evolution", () => {
    const r = friendlyIntegrationError("evolution", "api_url inválida");
    expect(r.message).toMatch(/URL da API Evolution inválida/);
  });

  it("aplica whitelist e trunca para bloquear ruído no fallback", () => {
    const raw = "x".repeat(500) + "<script>alert(1)</script>";
    const r = friendlyIntegrationError("desconhecido", raw);
    expect(r.message.length).toBeLessThan(300);
    expect(r.message).not.toMatch(/<script>/);
  });
});

describe("remediationHint", () => {
  it("orienta o operador em caso de falhas repetidas de envio", () => {
    expect(remediationHint("resend", "repeated_send_failures")).toMatch(/Testar conexão/);
  });
  it("inclui o nome do provedor na dica de integração com erro", () => {
    expect(remediationHint("zapi", "integration_error")).toMatch(/Zapi/);
  });
});

describe("userFacingFailureMessage", () => {
  it("troca 'X_API_KEY ausente' por ação que o operador consegue executar", () => {
    // Produção exibia isto literalmente na aba Conhecimento e na aba Falhas.
    // A chave do LLM vem da plataforma Lovable: não há tela de configuração,
    // então a única ação real é reprocessar.
    const esperado = "O serviço de IA falhou temporariamente. Tente processar de novo.";
    expect(userFacingFailureMessage("GEMINI_API_KEY ausente.")).toBe(esperado);
    expect(userFacingFailureMessage("LOVABLE_API_KEY ausente.")).toBe(esperado);
  });

  it("apaga nome de variável de ambiente no meio de qualquer mensagem", () => {
    expect(userFacingFailureMessage("Falha ao ler SUPABASE_SERVICE_ROLE no worker")).toBe(
      "Falha ao ler credencial do serviço no worker",
    );
  });

  it("preserva mensagem que já é legível para o operador", () => {
    const original = "LlamaParse não concluiu dentro do tempo limite.";
    expect(userFacingFailureMessage(original)).toBe(original);
  });

  it("aceita null e vazio sem quebrar a tela", () => {
    expect(userFacingFailureMessage(null)).toBe("");
    expect(userFacingFailureMessage("   ")).toBe("");
  });
});

describe("userFacingErrorMessage", () => {
  it("troca a policy de RLS do Postgres por instrução que o operador entende", () => {
    const bruto = new Error('new row violates row-level security policy for table "tenants"');
    expect(userFacingErrorMessage(bruto, "Erro ao salvar")).toBe(
      "Você não tem permissão para fazer isso. Peça a um administrador.",
    );
  });

  it("traduz violação de unicidade em vez de mostrar o nome do índice", () => {
    const bruto = new Error(
      'duplicate key value violates unique constraint "tags_tenant_id_name_key"',
    );
    expect(userFacingErrorMessage(bruto, "Erro ao salvar")).toBe(
      "Já existe um registro com esse valor.",
    );
  });

  it("traduz queda de rede", () => {
    expect(userFacingErrorMessage(new TypeError("Failed to fetch"), "Erro")).toBe(
      "Sem conexão com o servidor agora — tente de novo em instantes.",
    );
  });

  it("cai no texto da tela quando o jargão não tem tradução acionável", () => {
    const bruto = new Error('relation "public.invites" does not exist');
    expect(userFacingErrorMessage(bruto, "Erro ao criar convite")).toBe("Erro ao criar convite");
  });

  it("preserva mensagem que o próprio app lançou em PT-BR", () => {
    expect(userFacingErrorMessage(new Error("Tenant inválido"), "Erro ao salvar")).toBe(
      "Tenant inválido",
    );
  });

  it("usa o texto da tela quando o erro não tem mensagem", () => {
    expect(userFacingErrorMessage(new Error(""), "Erro ao salvar")).toBe("Erro ao salvar");
    expect(userFacingErrorMessage(null, "Erro ao salvar")).toBe("Erro ao salvar");
    expect(userFacingErrorMessage(undefined, "Erro ao salvar")).toBe("Erro ao salvar");
  });

  it("lê a mensagem do PostgrestError, que é objeto simples e não Error", () => {
    // `String(erro)` nesse objeto devolveria "[object Object]" na tela.
    const postgrest = { message: "permission denied for table tenants", code: "42501" };
    expect(userFacingErrorMessage(postgrest, "Erro ao salvar")).toBe(
      "Você não tem permissão para fazer isso. Peça a um administrador.",
    );
  });

  it("cai no texto da tela quando o erro não tem mensagem legível", () => {
    expect(userFacingErrorMessage({ code: "42501" }, "Erro ao salvar")).toBe("Erro ao salvar");
  });

  it("continua apagando nome de variável de ambiente", () => {
    expect(userFacingErrorMessage(new Error("Falha ao ler SUPABASE_URL_X"), "Erro")).toBe(
      "Falha ao ler credencial do serviço",
    );
  });
});
