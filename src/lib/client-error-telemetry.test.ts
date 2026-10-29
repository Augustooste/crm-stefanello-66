import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
const getSession = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    auth: { getSession: () => getSession() },
  },
}));

import {
  CLIENT_ERROR_MAX_PER_MINUTE,
  CLIENT_ERROR_MAX_TEXT,
  errorReference,
  extractClientError,
  getClientErrorObservation,
  installClientErrorHandlers,
  logClientError,
  redactClientErrorText,
  resetClientErrorTelemetry,
  setClientAuthTransition,
  shouldSendClientError,
  shrinkContextToBudget,
} from "./client-error-telemetry";

beforeEach(() => {
  resetClientErrorTelemetry();
  rpc.mockReset();
  rpc.mockResolvedValue({ error: null });
  getSession.mockReset();
  getSession.mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null });
  window.history.replaceState({}, "", "/pipeline");
});

afterEach(() => {
  resetClientErrorTelemetry();
});

describe("redactClientErrorText", () => {
  it("redige segredo em URL de provider e header de auth", () => {
    const out = redactClientErrorText(
      "GET https://api.z-api.io/instances/i1/token/abc123SEGREDO/send failed; Authorization: Bearer eyJhbGciOi.payload.assinatura; api_key=chave-secreta; ?access_token=xyz789",
    );
    expect(out).not.toContain("abc123SEGREDO");
    expect(out).not.toContain("chave-secreta");
    expect(out).not.toContain("xyz789");
    expect(out).toContain("[REDIGIDO]");
  });

  it("redige e-mail, telefone e CPF de lead que caem na mensagem de erro", () => {
    const out = redactClientErrorText(
      "duplicate key: (email)=(maria.silva@cliente.com.br) telefone +55 11 98888-7777 cpf 123.456.789-00",
    );
    expect(out).not.toContain("maria.silva@cliente.com.br");
    expect(out).not.toContain("98888-7777");
    expect(out).not.toContain("123.456.789-00");
    expect(out).toContain("[EMAIL_REDIGIDO]");
  });

  it("é idempotente e preserva a parte diagnóstica da mensagem", () => {
    const msg = "column contacts.audio_status does not exist";
    expect(redactClientErrorText(msg)).toBe(msg);
    expect(redactClientErrorText(redactClientErrorText(msg))).toBe(redactClientErrorText(msg));
  });
});

describe("extractClientError", () => {
  it("preserva o code do PostgREST — é o que torna erro de schema diagnosticável", () => {
    const extracted = extractClientError({
      code: "42703",
      message: "column contacts.audio_status does not exist",
      details: null,
      hint: "Perhaps you meant to reference the column audio_url",
    });
    expect(extracted.code).toBe("42703");
    expect(extracted.message).toContain("audio_status");
    expect(extracted.hint).toContain("audio_url");
  });

  it("trunca a stack no teto configurado", () => {
    const error = new Error("boom");
    error.stack = "x".repeat(CLIENT_ERROR_MAX_TEXT + 500);
    expect(extractClientError(error).stack).toHaveLength(CLIENT_ERROR_MAX_TEXT);
  });

  it("aceita valor não-Error sem lançar", () => {
    expect(extractClientError("string solta").message).toBe("string solta");
    expect(extractClientError(null).message).toBe("(sem mensagem)");
  });
});

describe("shouldSendClientError", () => {
  it("dedupa a mesma mensagem na mesma rota dentro da janela", () => {
    expect(shouldSendClientError("/pipeline", "boom", 0)).toBe(true);
    expect(shouldSendClientError("/pipeline", "boom", 30_000)).toBe(false);
    expect(shouldSendClientError("/pipeline", "boom", 61_000)).toBe(true);
  });

  it("não dedupa a mesma mensagem em rota diferente", () => {
    expect(shouldSendClientError("/pipeline", "boom", 0)).toBe(true);
    expect(shouldSendClientError("/inbox", "boom", 0)).toBe(true);
  });

  it("corta acima do limite por minuto e volta a aceitar na janela seguinte", () => {
    for (let i = 0; i < CLIENT_ERROR_MAX_PER_MINUTE; i++) {
      expect(shouldSendClientError("/pipeline", `erro ${i}`, i)).toBe(true);
    }
    expect(shouldSendClientError("/pipeline", "erro a mais", 100)).toBe(false);
    expect(shouldSendClientError("/pipeline", "erro a mais", 61_000)).toBe(true);
  });
});

describe("logClientError", () => {
  it("grava rota, mensagem, código, stack e contexto na RPC", async () => {
    const error = Object.assign(new Error("column contacts.audio_status does not exist"), {
      code: "42703",
    });

    await expect(logClientError(error, { origin: "query" })).resolves.toBe(true);

    expect(rpc).toHaveBeenCalledTimes(1);
    const [name, args] = rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe("log_client_error");
    expect(args.p_route).toBe("/pipeline");
    expect(args.p_message).toContain("audio_status");
    expect(args.p_error_code).toBe("42703");
    expect(args.p_context).toMatchObject({ origin: "query" });
    expect((args.p_context as Record<string, string>).user_agent).toBeTruthy();
    // user_id é preenchido pela RPC a partir de auth.uid(), nunca pelo cliente.
    expect(args.p_context).not.toHaveProperty("user_id");
  });

  it("redige dado sensível antes de enviar", async () => {
    await logClientError(new Error("falhou para joao@cliente.com com token=abc123"), {
      origin: "window_error",
    });
    const [, args] = rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(args.p_message).not.toContain("joao@cliente.com");
    expect(args.p_message).not.toContain("abc123");
  });

  it("engole falha da RPC sem lançar e sem repetir", async () => {
    rpc.mockResolvedValue({ error: { code: "PGRST202", message: "function not found" } });
    await expect(logClientError(new Error("boom"), { origin: "query" })).resolves.toBe(false);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("engole exceção da RPC (rede caída) sem lançar", async () => {
    rpc.mockRejectedValue(new Error("network down"));
    await expect(logClientError(new Error("boom"), { origin: "query" })).resolves.toBe(false);
  });

  it("não envia duas vezes o mesmo erro na mesma rota", async () => {
    await logClientError(new Error("boom"), { origin: "query" });
    await logClientError(new Error("boom"), { origin: "query" });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

describe("installClientErrorHandlers", () => {
  // ErrorEvent com `error` preenchido é tratado como exceção não capturada pelo
  // próprio vitest; `message` exercita o mesmo caminho (`event.error ?? event.message`)
  // sem poluir a saída da suíte.
  function dispatchWindowError(message: string) {
    window.dispatchEvent(new ErrorEvent("error", { message }));
  }

  it("captura error e unhandledrejection e para de capturar após o cleanup", async () => {
    const cleanup = installClientErrorHandlers();

    dispatchWindowError("erro global");
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    expect((rpc.mock.calls[0][1] as Record<string, unknown>).p_context).toMatchObject({
      origin: "window_error",
    });

    const rejection = new Event("unhandledrejection") as Event & { reason?: unknown };
    rejection.reason = new Error("promessa solta");
    window.dispatchEvent(rejection);
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
    expect((rpc.mock.calls[1][1] as Record<string, unknown>).p_context).toMatchObject({
      origin: "unhandled_rejection",
    });

    cleanup();
    dispatchWindowError("depois do cleanup");
    await new Promise((r) => setTimeout(r, 0));
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});

// Diagnóstico do incidente de login frio: sem estes campos o log não dizia QUAL
// query falhou nem se a chamada tinha sessão — só "origin: query".
describe("contexto de diagnóstico", () => {
  it("grava a operação, o estado da sessão e marca erro de permissão", async () => {
    await logClientError(
      Object.assign(new Error("permission denied for function x"), {
        code: "42501",
      }),
      { origin: "query", operation: "my-capabilities" },
    );

    const [, args] = rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(args.p_context).toMatchObject({
      operation: "my-capabilities",
      has_session: "true",
      permission_error: "true",
    });
  });

  it("não chama a RPC quando a sessão já foi encerrada", async () => {
    getSession.mockResolvedValue({ data: { session: null }, error: null });
    await expect(logClientError(new Error("boom sem sessão"), { origin: "query" })).resolves.toBe(
      false,
    );

    expect(rpc).not.toHaveBeenCalled();
  });

  it("falha ao ler a sessão não impede o registro do erro original", async () => {
    getSession.mockRejectedValue(new Error("storage indisponível"));
    await expect(logClientError(new Error("boom"), { origin: "query" })).resolves.toBe(true);
  });

  it("envia como correlation_id a mesma referência mostrada na tela", async () => {
    const error = new Error("erro com referência");
    const referencia = errorReference(error);
    await logClientError(error, { origin: "error_boundary", boundary: "app" });

    const [, args] = rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(args.p_correlation_id).toBe(referencia);
    // Estável: o mesmo objeto de erro devolve sempre a mesma referência.
    expect(errorReference(error)).toBe(referencia);
  });

  it("preserva referência e primeira observação mesmo quando o erro está congelado", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T20:27:47.000Z"));
    const error = Object.freeze(
      Object.assign(new Error("permission denied for table hitl_decisions"), { code: "42501" }),
    );
    setClientAuthTransition("signing_out");

    getSession.mockResolvedValueOnce({ data: { session: null }, error: null });
    await expect(
      logClientError(error, { origin: "query", operation: "decision-queue" }),
    ).resolves.toBe(false);
    const reference = errorReference(error);

    vi.setSystemTime(new Date("2026-09-15T20:28:07.000Z"));
    getSession.mockResolvedValueOnce({ data: { session: { user: { id: "u1" } } }, error: null });
    await expect(
      logClientError(error, { origin: "error_boundary", boundary: "app" }),
    ).resolves.toBe(true);

    expect(errorReference(error)).toBe(reference);
    expect(getClientErrorObservation(error)).toMatchObject({
      observedAt: "2026-09-15T20:27:47.000Z",
      operation: "decision-queue",
      authTransition: "signing_out",
      reference,
    });
    const [, args] = rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(args.p_context).toMatchObject({
      observed_at: "2026-09-15T20:27:47.000Z",
      reported_at: "2026-09-15T20:28:07.000Z",
      report_delay_ms: "20000",
      auth_transition: "signing_out",
      operation: "decision-queue",
    });
    vi.useRealTimers();
  });
});

// Regressão do incidente em /configuracoes: o context gravado só tinha
// {name, origin, user_id, user_agent, has_session} — sem QUAL operação falhou,
// sem a mensagem ao lado do resto do diagnóstico e sem status HTTP.
describe("contexto rico (operação, mensagem e status)", () => {
  it("grava operação e status HTTP no contexto", async () => {
    const error = Object.assign(new Error("upstream indisponível"), { status: 500 });
    await logClientError(error, { origin: "mutation", operation: "salvar-integracao" });

    const [, args] = rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(args.p_context).toMatchObject({ operation: "salvar-integracao", status: "500" });
  });

  it("duplica a mensagem no contexto já redigida, sem vazar o segredo", async () => {
    await logClientError(
      new Error("falha em https://api.z-api.io/instances/i1/token/abc123SEGREDO/send"),
      { origin: "mutation", operation: "enviar-mensagem" },
    );

    const [, args] = rpc.mock.calls[0] as [string, Record<string, unknown>];
    const context = args.p_context as Record<string, string>;
    expect(context.message).toContain("[REDIGIDO]");
    expect(JSON.stringify(context)).not.toContain("abc123SEGREDO");
  });
});

describe("shrinkContextToBudget", () => {
  it("descarta hint e details primeiro ao estourar o orçamento", () => {
    const context: Record<string, string> = {
      origin: "mutation",
      operation: "op-grande",
      hint: "h".repeat(3000),
      details: "d".repeat(3000),
      message: "erro grande",
    };

    const shrunk = shrinkContextToBudget(context);

    expect(shrunk).not.toHaveProperty("hint");
    expect(shrunk).not.toHaveProperty("details");
    expect(shrunk.operation).toBe("op-grande");
    expect(JSON.stringify(shrunk).length).toBeLessThanOrEqual(3000);
  });

  it("não mexe em contexto dentro do orçamento", () => {
    const context = { origin: "query", operation: "listar" };
    expect(shrinkContextToBudget(context)).toEqual(context);
  });
});
