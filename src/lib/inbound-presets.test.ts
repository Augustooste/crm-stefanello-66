import { createHmac, timingSafeEqual } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  GOLDEN_BODY,
  GOLDEN_SECRET,
  GOLDEN_SIGNATURE,
  GOLDEN_TIMESTAMP,
} from "../../supabase/functions/_shared/webhooks/golden-vector";
import { conditionError } from "@/components/settings/developer/inbound-rule-form";
import { NODE_SIGN_SNIPPET } from "@/components/settings/developer/inbound-sign-snippet";
import { NODE_VERIFY_SNIPPET } from "@/components/settings/developer/verify-snippets";
import { INBOUND_PRESETS, type InboundPreset } from "./inbound-presets";

// Espelho de private.inbound_path_is_valid (20261021100000_inbound_rules.sql).
const SEGMENT_RE = /^[A-Za-z0-9_-]+$/;
function pathIsValid(path: string): boolean {
  if (path.length > 200) return false;
  const parts = path.split(".");
  return parts.length >= 1 && parts.length <= 10 && parts.every((s) => SEGMENT_RE.test(s));
}
// Espelho de private.assert_inbound_verification + RESERVED_TOKEN_HEADERS do receptor.
const HEADER_RE = /^[A-Za-z0-9-]{1,64}$/;
const RESERVED = ["host", "content-length", "content-type", "authorization", "cookie"];
const MODES = ["aceleraflow_hmac", "stripe_signature", "header_token"];

// Mapa fixo: só muda junto com a fonte citada no relatório da Task 9.
const EXPECTED_CONFIRMED: Record<InboundPreset["id"], boolean> = {
  stripe_checkout: true,
  asaas_payment: true,
  hotmart_purchase: true,
  pix_generic: false,
  custom: true,
};

describe("INBOUND_PRESETS", () => {
  it("ids únicos e incluem o Personalizado", () => {
    const ids = INBOUND_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("custom");
    expect([...ids].sort()).toEqual(Object.keys(EXPECTED_CONFIRMED).sort());
  });

  it.each(INBOUND_PRESETS.map((p) => [p.id, p] as const))(
    "%s passa nas regras de assert_inbound_rule_config",
    (_id, p) => {
      expect(pathIsValid(p.eventIdPath)).toBe(true);
      expect(pathIsValid(p.matchPath)).toBe(true);
      expect(["email", "phone", "deal_custom_field"]).toContain(p.matchField);
      expect(p.conditions.length).toBeLessThanOrEqual(5);
      for (const [i, c] of p.conditions.entries()) {
        expect(pathIsValid(c.path)).toBe(true);
        // Mesmo validador do assistente (espelho do banco: exatamente um de equals ou in).
        expect(conditionError(c, i)).toBeNull();
      }
      expect(MODES).toContain(p.verificationMode);
      expect(p.verificationMode === "header_token").toBe(p.tokenHeaderName !== null);
      if (p.tokenHeaderName !== null) {
        expect(p.tokenHeaderName).toMatch(HEADER_RE);
        expect(RESERVED).not.toContain(p.tokenHeaderName.toLowerCase());
      }
      expect(p.label.trim().length).toBeGreaterThan(0);
    },
  );

  it("confirmed segue o mapa de fontes (sem fonte oficial = false)", () => {
    for (const p of INBOUND_PRESETS)
      expect([p.id, p.confirmed]).toEqual([p.id, EXPECTED_CONFIRMED[p.id]]);
  });

  it("valores confirmados no spike para os gateways", () => {
    const byId = Object.fromEntries(INBOUND_PRESETS.map((p) => [p.id, p]));
    expect(byId.asaas_payment.tokenHeaderName).toBe("asaas-access-token");
    expect(byId.hotmart_purchase.tokenHeaderName).toBe("X-HOTMART-HOTTOK");
    expect(byId.stripe_checkout.verificationMode).toBe("stripe_signature");
    expect(byId.stripe_checkout.conditions).toEqual([
      {
        path: "type",
        in: ["checkout.session.completed", "checkout.session.async_payment_succeeded"],
      },
      { path: "data.object.payment_status", in: ["paid", "no_payment_required"] },
    ]);
    // Cartão confirma primeiro (CONFIRMED); boleto e Pix só chegam como RECEIVED.
    expect(byId.asaas_payment.conditions).toEqual([
      { path: "event", in: ["PAYMENT_RECEIVED", "PAYMENT_CONFIRMED"] },
    ]);
    expect(byId.hotmart_purchase.conditions).toEqual([
      { path: "event", equals: "PURCHASE_APPROVED" },
    ]);
  });

  it("v2.2: chave de dedupe por id do objeto (Stripe, Asaas) e fallback de e-mail do Stripe", () => {
    const byId = Object.fromEntries(INBOUND_PRESETS.map((p) => [p.id, p]));
    expect(byId.stripe_checkout.eventIdPath).toBe("data.object.id");
    expect(byId.stripe_checkout.matchPath).toBe("data.object.customer_details.email");
    expect(byId.stripe_checkout.matchFallbackPath).toBe("data.object.customer_email");
    expect(byId.asaas_payment.eventIdPath).toBe("payment.id");
    // Hotmart sem payload real confirmado: continua no id do evento.
    expect(byId.hotmart_purchase.eventIdPath).toBe("id");
    for (const p of INBOUND_PRESETS) {
      if (p.matchFallbackPath === undefined) continue;
      expect(["email", "phone"]).toContain(p.matchField);
      expect(pathIsValid(p.matchFallbackPath)).toBe(true);
    }
  });

  it("condição de cada modelo tem exatamente uma chave (equals ou in)", () => {
    for (const p of INBOUND_PRESETS)
      for (const c of p.conditions) expect("equals" in c).not.toBe("in" in c);
  });

  it("regra de caminho recusa o que o banco recusa", () => {
    expect(pathIsValid("pix[0].txid")).toBe(false);
    expect(pathIsValid("a.b.c.d.e.f.g.h.i.j.k")).toBe(false);
    expect(pathIsValid("a..b")).toBe(false);
    expect(pathIsValid("pix.0.txid")).toBe(true);
  });
});

type Signer = (secret: string, body: string, nowSeconds?: number) => string;
type Verifier = (s: string, h: string, b: string, tol?: number, now?: number) => boolean;

function load<T>(code: string, name: string): T {
  const mod: { exports: Record<string, unknown> } = { exports: {} };
  const requireStub = (dep: string) => {
    if (dep !== "node:crypto") throw new Error(`require inesperado: ${dep}`);
    return { createHmac, timingSafeEqual };
  };
  new Function("require", "module", code)(requireStub, mod);
  return mod.exports[name] as T;
}

describe("NODE_SIGN_SNIPPET (sistema próprio)", () => {
  it("gera a assinatura do vetor dourado da v1", () => {
    const sign = load<Signer>(NODE_SIGN_SNIPPET, "signAceleraflowRequest");
    expect(sign(GOLDEN_SECRET, GOLDEN_BODY, GOLDEN_TIMESTAMP)).toBe(
      `t=${GOLDEN_TIMESTAMP},${GOLDEN_SIGNATURE}`,
    );
  });

  it("ida e volta com o verificador da v1", () => {
    const sign = load<Signer>(NODE_SIGN_SNIPPET, "signAceleraflowRequest");
    const verify = load<Verifier>(NODE_VERIFY_SNIPPET, "verifyAceleraflowSignature");
    const body = '{"id":"pedido-123","email":"cliente@exemplo.com"}';
    const header = sign("whin_SEU_SEGREDO", body, 1_800_000_000);
    expect(verify("whin_SEU_SEGREDO", header, body, 300, 1_800_000_000_000)).toBe(true);
    expect(verify("whin_SEU_SEGREDO", header, `${body} `, 300, 1_800_000_000_000)).toBe(false);
  });

  it("sem segredo real no texto", () => {
    expect(NODE_SIGN_SNIPPET).not.toMatch(/whin_[A-Za-z0-9]{20,}/);
  });
});
