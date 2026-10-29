import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { InboundRule } from "@/lib/api/inbound-rules";
import {
  buildActionConfig,
  buildRuleInput,
  conditionError,
  conditionSummary,
  destinationOptions,
  emptyForm,
  formFromRule,
  IGNORED_REASON_LABEL,
  ignoredSummary,
  withConditionKind,
  isSecretLikePath,
  isValidPath,
  validateStep,
  type StageKind,
  type StepContext,
  type WizardForm,
} from "./inbound-rule-form";

const STAGES: StageKind[] = [
  { id: "s-novo", name: "Novo", isWon: false, isLost: false },
  { id: "s-pago", name: "Pago", isWon: false, isLost: false },
  { id: "s-ganho", name: "Ganho", isWon: true, isLost: false },
  { id: "s-perdido", name: "Perdido", isWon: false, isLost: true },
];
const CTX: StepContext = { isEdit: false, stages: STAGES, customFields: [] };

function form(over: Partial<WizardForm> = {}): WizardForm {
  return { ...emptyForm("custom"), name: "Pagamentos", boardId: "b1", ...over };
}

describe("validações espelhadas do banco", () => {
  it("caminho: até 10 segmentos de letras, dígitos, _ e -", () => {
    expect(isValidPath("data.object.customer_details.email")).toBe(true);
    expect(isValidPath("pix.0.txid")).toBe(true);
    expect(isValidPath("pix[0].txid")).toBe(false);
    expect(isValidPath("a..b")).toBe(false);
    expect(isValidPath(Array(11).fill("a").join("."))).toBe(false);
  });

  it("reconhece nomes de segredo em qualquer segmento", () => {
    expect(isSecretLikePath("data.hottok")).toBe(true);
    expect(isSecretLikePath("headers.Authorization")).toBe(true);
    expect(isSecretLikePath("data.buyer.email")).toBe(false);
  });

  it("header reservado bloqueia o passo de verificação", () => {
    const f = form({
      verificationMode: "header_token",
      tokenHeaderName: "Content-Type",
      secret: "12345678",
    });
    expect(validateStep(1, f, CTX)).toMatch(/reservado/);
    expect(validateStep(1, { ...f, tokenHeaderName: "asaas-access-token" }, CTX)).toBeNull();
  });

  it("segredo externo de 8 a 512 só na criação", () => {
    const f = form({ verificationMode: "stripe_signature", secret: "curto" });
    expect(validateStep(1, f, CTX)).toMatch(/8 a 512/);
    expect(validateStep(1, f, { ...CTX, isEdit: true })).toBeNull();
  });

  it("destino respeita etapas permitidas e o tipo da ação", () => {
    const f = form({ allowedStageIds: ["s-pago", "s-ganho"] });
    expect(destinationOptions(f, STAGES).map((s) => s.id)).toEqual(["s-pago"]);
    expect(destinationOptions({ ...f, action: "mark_won" }, STAGES).map((s) => s.id)).toEqual([
      "s-ganho",
    ]);
    expect(validateStep(3, { ...f, toStageId: "s-novo" }, CTX)).toMatch(/destino/);
  });

  it("template de nota com campo de segredo é recusado", () => {
    const f = form({
      action: "add_note",
      allowedStageIds: ["s-pago"],
      noteText: "Pago {{data.hottok}}",
    });
    expect(validateStep(3, f, CTX)).toMatch(/segredo ou token/);
    expect(validateStep(3, { ...f, noteText: "Pago por {{data.buyer.email}}" }, CTX)).toBeNull();
  });
});

describe("fix round 1", () => {
  it("sem dados (undefined) não é o mesmo que nenhum campo ([])", () => {
    const f = form({
      matchField: "deal_custom_field",
      matchPath: "payment.externalReference",
      eventIdPath: "id",
    });
    expect(validateStep(2, f, { ...CTX, customFields: undefined })).toMatch(/ainda não carregaram/);
    expect(validateStep(2, f, { ...CTX, customFields: [] })).toMatch(/Nenhum campo personalizado/);
    const f2 = form({ allowedStageIds: ["s-pago"], toStageId: "s-pago" });
    expect(validateStep(3, f2, { ...CTX, stages: undefined })).toMatch(/ainda não carregaram/);
    expect(validateStep(3, f2, CTX)).toBeNull();
  });

  it("condição exige ao menos 1 caractere em Igual a", () => {
    const f = form({
      matchPath: "email",
      eventIdPath: "id",
      conditions: [{ path: "type", equals: "" }],
    });
    expect(validateStep(2, f, CTX)).toMatch(/informe o valor/);
    expect(
      validateStep(2, { ...f, conditions: [{ path: "type", equals: "pago" }] }, CTX),
    ).toBeNull();
  });

  it("nome de segredo bloqueado também no id do evento, no identificador e nas condições", () => {
    const base = form({ matchPath: "email", eventIdPath: "id" });
    expect(validateStep(2, { ...base, eventIdPath: "signature" }, CTX)).toMatch(/no id do evento/);
    expect(validateStep(2, { ...base, matchPath: "data.token" }, CTX)).toMatch(/no identificador/);
    expect(
      validateStep(2, { ...base, conditions: [{ path: "headers.secret", equals: "x" }] }, CTX),
    ).toMatch(/na condição 1/);
  });

  it("mensagens de template com concordância certa", () => {
    const f = form({ allowedStageIds: ["s-pago"], action: "add_note", noteText: "{{a.token}}" });
    expect(validateStep(3, f, CTX)).toMatch(/\) na nota:/);
    const lost = form({
      allowedStageIds: ["s-perdido"],
      action: "mark_lost",
      toStageId: "s-perdido",
      reasonText: "{{x.secret}}",
    });
    expect(validateStep(3, lost, CTX)).toMatch(/\) no motivo:/);
  });
});

describe("condição Qualquer um de (in, v2.1)", () => {
  const base = form({ matchPath: "email", eventIdPath: "id" });
  const step = (conditions: WizardForm["conditions"]) =>
    validateStep(2, { ...base, conditions }, CTX);

  it("lista de 1 a 10 textos passa", () => {
    expect(step([{ path: "event", in: ["PAYMENT_RECEIVED", "PAYMENT_CONFIRMED"] }])).toBeNull();
    expect(step([{ path: "event", in: Array.from({ length: 10 }, (_, i) => `E${i}`) }])).toBeNull();
    expect(conditionError({ path: "event", in: ["x".repeat(200)] }, 0)).toBeNull();
  });

  it("recusa os mesmos casos de borda que o banco", () => {
    expect(step([{ path: "event", in: [] }])).toMatch(/Condição 1: informe de 1 a 10 valores/);
    expect(step([{ path: "event", in: Array.from({ length: 11 }, (_, i) => `E${i}`) }])).toMatch(
      /no máximo 10 valores/,
    );
    expect(step([{ path: "event", in: ["A", "  "] }])).toMatch(/valor 2 da lista está vazio/);
    expect(step([{ path: "event", in: ["x".repeat(201)] }])).toMatch(
      /valor 1 da lista com até 200 caracteres/,
    );
    expect(step([{ path: "event", equals: "A", in: ["A"] }])).toMatch(
      /use "Igual a" ou "Qualquer um de", não os dois/,
    );
    expect(step([{ path: "event" }])).toMatch(/use "Igual a" ou "Qualquer um de"/);
  });

  it("valida o valor aparado (é o que vai ao banco)", () => {
    expect(conditionError({ path: "event", in: [" " + "x".repeat(200) + " "] }, 0)).toBeNull();
  });

  it("caminho e campo de segredo valem também para a lista", () => {
    expect(step([{ path: "a..b", in: ["x"] }])).toMatch(/Condição 1: caminho inválido/);
    expect(step([{ path: "data.hottok", in: ["x"] }])).toMatch(/segredo ou token.*na condição 1/);
  });

  it("envia exatamente uma chave, com os itens aparados, e mantém a transformação", () => {
    const input = buildRuleInput({
      ...base,
      conditions: [
        { path: " type ", in: [" a ", "b"] },
        { path: "status", equals: " paid " },
        { path: "x", in: ["Y"], transform: "lower" },
      ],
    });
    expect(input.conditions).toEqual([
      { path: "type", in: ["a", "b"] },
      { path: "status", equals: " paid " },
      { path: "x", in: ["Y"], transform: "lower" },
    ]);
    for (const c of input.conditions) expect("equals" in c).not.toBe("in" in c);
  });

  it("trocar o tipo cria objeto novo sem a outra chave e aproveita o valor", () => {
    const eq = { path: "event", equals: "PAID", transform: "trim" as const };
    const asIn = withConditionKind(eq, "in");
    expect(asIn).toEqual({ path: "event", in: ["PAID"], transform: "trim" });
    expect("equals" in asIn).toBe(false);
    const back = withConditionKind({ path: "event", in: ["A", "B"] }, "equals");
    expect(back).toEqual({ path: "event", equals: "A" });
    expect("in" in back).toBe(false);
    expect(withConditionKind({ path: "e", equals: "" }, "in")).toEqual({ path: "e", in: [""] });
  });

  it("formFromRule e applyPreset copiam a lista (editar não muta a regra)", () => {
    const rule = {
      conditions: [{ path: "event", in: ["A"] }],
      actionConfig: {},
      allowedStageIds: [],
    } as unknown as InboundRule;
    formFromRule(rule).conditions[0].in?.push("B");
    expect(rule.conditions[0].in).toEqual(["A"]);
    const preset = emptyForm("asaas_payment");
    preset.conditions[0].in?.push("OUTRO");
    expect(emptyForm("asaas_payment").conditions[0].in).not.toContain("OUTRO");
  });

  it("resumo legível: Igual a com = e lista com um de", () => {
    expect(conditionSummary({ path: "type", equals: "paid" })).toBe("type = paid");
    expect(conditionSummary({ path: "event", in: ["A", "B"] })).toBe("event é um de: A, B");
  });
});

describe("payload enviado ao banco", () => {
  it("action_config só tem as chaves aceitas pela ação, sem campo vazio", () => {
    expect(
      buildActionConfig(
        form({ action: "mark_lost", toStageId: "s-perdido", reasonText: "Estorno" }),
      ),
    ).toEqual({ to_stage_id: "s-perdido", reason_text: "Estorno" });
    expect(
      buildActionConfig(
        form({ action: "create_activity", activityTitle: "Ligar", dueInHours: "48" }),
      ),
    ).toEqual({ title: "Ligar", due_in_hours: 48 });
    expect(
      buildActionConfig(form({ action: "add_note", noteText: "Oi", matchPrefix: "+55" })),
    ).toEqual({ text: "Oi" });
  });

  it("HMAC não envia segredo nem header; deal_custom_field envia a chave", () => {
    const input = buildRuleInput(
      form({ matchField: "deal_custom_field", customFieldKey: "pedido", secret: "x" }),
    );
    expect(input.secret).toBeNull();
    expect(input.tokenHeaderName).toBeNull();
    expect(input.customFieldKey).toBe("pedido");
  });
});

describe("v2.2: caminho alternativo do identificador (match_fallback_path)", () => {
  const base = form({ matchPath: "data.object.customer_details.email", eventIdPath: "id" });

  it("preset Stripe preenche o alternativo; Personalizado deixa vazio", () => {
    expect(emptyForm("stripe_checkout").matchFallbackPath).toBe("data.object.customer_email");
    expect(emptyForm("stripe_checkout").eventIdPath).toBe("data.object.id");
    expect(emptyForm("asaas_payment").eventIdPath).toBe("payment.id");
    expect(emptyForm("custom").matchFallbackPath).toBe("");
  });

  it("valida o caminho como os outros e bloqueia nome de segredo", () => {
    expect(
      validateStep(2, { ...base, matchFallbackPath: "data.object.customer_email" }, CTX),
    ).toBeNull();
    expect(validateStep(2, { ...base, matchFallbackPath: "a..b" }, CTX)).toMatch(
      /Caminho alternativo do identificador inválido/,
    );
    expect(validateStep(2, { ...base, matchFallbackPath: "data.token" }, CTX)).toMatch(
      /no caminho alternativo/,
    );
    // Campo personalizado não usa alternativo: valor velho no estado não bloqueia nem vai ao banco.
    const custom = { ...base, matchField: "deal_custom_field" as const, customFieldKey: "pedido" };
    const ctx = { ...CTX, customFields: [{ key: "pedido", label: "Pedido" }] };
    expect(validateStep(2, { ...custom, matchFallbackPath: "a..b" }, ctx)).toBeNull();
    expect(buildActionConfig({ ...custom, matchFallbackPath: "x.y" })).not.toHaveProperty(
      "match_fallback_path",
    );
  });

  it("vai ao action_config aparado só para e-mail e telefone, e volta na edição", () => {
    expect(buildActionConfig({ ...base, matchFallbackPath: "  data.alt  " })).toMatchObject({
      match_fallback_path: "data.alt",
    });
    expect(buildActionConfig({ ...base, matchFallbackPath: "   " })).not.toHaveProperty(
      "match_fallback_path",
    );
    expect(
      buildActionConfig({ ...base, matchField: "phone", matchFallbackPath: "buyer.phone" }),
    ).toMatchObject({ match_fallback_path: "buyer.phone" });
    const rule = {
      ...buildRuleInput(form({ matchFallbackPath: "data.alt" })),
      allowedStageIds: [],
      matchCustomFieldKey: null,
      actionConfig: { to_stage_id: "s1", match_fallback_path: "data.alt" },
    } as unknown as InboundRule;
    expect(formFromRule(rule).matchFallbackPath).toBe("data.alt");
  });
});

describe("v2.2: contador de ignorados", () => {
  const fmt = (iso: string | null) => `em ${iso}`;

  it("mapa de motivos = lista fechada de record_inbound_ignored na migration vigente", () => {
    const dir = resolve(process.cwd(), "supabase/migrations");
    const sql = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => readFileSync(resolve(dir, f), "utf8"))
      .join("\n");
    const lists = [...sql.matchAll(/p_reason not in \(([^)]*)\)/g)];
    const last = lists.at(-1)?.[1] ?? "";
    const reasons = [...last.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect(reasons.length).toBeGreaterThan(0);
    expect(Object.keys(IGNORED_REASON_LABEL).sort()).toEqual(reasons);
  });

  it("resumo com plural, motivo traduzido e data; null sem ignorados", () => {
    expect(
      ignoredSummary({ ignoredCount: 0, lastIgnoredAt: null, lastIgnoredReason: null }, fmt),
    ).toBeNull();
    expect(
      ignoredSummary(
        { ignoredCount: 1, lastIgnoredAt: "2026-10-23", lastIgnoredReason: "missing_event_id" },
        fmt,
      ),
    ).toBe("1 ignorado (último: evento sem id, em 2026-10-23)");
    expect(
      ignoredSummary(
        { ignoredCount: 3, lastIgnoredAt: "2026-10-23", lastIgnoredReason: "nul_payload" },
        fmt,
      ),
    ).toBe("3 ignorados (último: caractere nulo no corpo, em 2026-10-23)");
  });

  it("motivo desconhecido aparece cru, sem quebrar", () => {
    const rule = {
      ignoredCount: 2,
      lastIgnoredAt: null,
      lastIgnoredReason: "novo_motivo",
    } as unknown as Parameters<typeof ignoredSummary>[0];
    expect(ignoredSummary(rule, fmt)).toBe("2 ignorados (último: novo_motivo)");
  });
});
