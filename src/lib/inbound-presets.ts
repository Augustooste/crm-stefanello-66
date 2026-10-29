// Modelos de regra de entrada por gateway (v2, Task 9). Valores tirados SÓ do spike
// docs/superpowers/spikes/2026-10-20-v2-gateways-webhooks.md (doc oficial de cada gateway);
// a fonte de cada campo está na tabela do relatório da Task 9. Valor sem fonte oficial =>
// confirmed: false, e a UI mostra "Confira na documentação do gateway".
// Caminhos seguem private.inbound_path_is_valid: segmentos com letras, dígitos, _ e -,
// separados por ponto, até 10; índice de lista é um segmento numérico (pix.0.txid).
import type { InboundMatchField, InboundVerificationMode } from "@/lib/api/inbound-rules";

export type InboundPreset = {
  id: "stripe_checkout" | "asaas_payment" | "hotmart_purchase" | "pix_generic" | "custom";
  label: string;
  verificationMode: InboundVerificationMode;
  tokenHeaderName: string | null;
  eventIdPath: string;
  matchField: InboundMatchField;
  matchPath: string;
  /** Caminho alternativo do identificador (v2.2, só email/phone): usado quando matchPath vem vazio. */
  matchFallbackPath?: string;
  /** Igual a (equals) ou qualquer um de (in, v2.1): exatamente uma das duas chaves. */
  conditions: ({ path: string; equals: string } | { path: string; in: string[] })[];
  confirmed: boolean;
};

export const INBOUND_PRESETS: readonly InboundPreset[] = [
  {
    id: "stripe_checkout",
    label: "Stripe: checkout concluído",
    verificationMode: "stripe_signature",
    tokenHeaderName: null,
    // Id da checkout session (v2.2): completed(unpaid) ignorado reprocessa no
    // async_payment_succeeded e 2 Events para a mesma session agem uma vez só.
    eventIdPath: "data.object.id",
    matchField: "email",
    matchPath: "data.object.customer_details.email",
    // customer_details.email pode vir null; customer_email é o e-mail passado na criação da session.
    matchFallbackPath: "data.object.customer_email",
    // async_payment_succeeded: meio que só confirma depois (boleto, por exemplo). payment_status
    // paid ou no_payment_required (cupom de 100%, trial) deixa de fora o completed ainda não pago
    // desses meios: a regra age uma vez só.
    conditions: [
      {
        path: "type",
        in: ["checkout.session.completed", "checkout.session.async_payment_succeeded"],
      },
      { path: "data.object.payment_status", in: ["paid", "no_payment_required"] },
    ],
    confirmed: true,
  },
  {
    id: "asaas_payment",
    label: "Asaas (cobrança recebida)",
    verificationMode: "header_token",
    tokenHeaderName: "asaas-access-token",
    // Id da cobrança (v2.2): CONFIRMED e RECEIVED do mesmo pagamento agem uma vez só.
    eventIdPath: "payment.id",
    // O evento de cobrança do Asaas não traz e-mail nem telefone: casa pelo externalReference.
    matchField: "deal_custom_field",
    matchPath: "payment.externalReference",
    // Cartão avisa primeiro PAYMENT_CONFIRMED (e RECEIVED depois); boleto e Pix só RECEIVED.
    conditions: [{ path: "event", in: ["PAYMENT_RECEIVED", "PAYMENT_CONFIRMED"] }],
    confirmed: true,
  },
  {
    id: "hotmart_purchase",
    label: "Hotmart (compra aprovada)",
    verificationMode: "header_token",
    tokenHeaderName: "X-HOTMART-HOTTOK",
    eventIdPath: "id",
    matchField: "email",
    matchPath: "data.buyer.email",
    conditions: [{ path: "event", equals: "PURCHASE_APPROVED" }],
    confirmed: true,
  },
  {
    // Pix direto do PSP exige mTLS (fora da v2): chega via n8n/Make no formato do Banco
    // Central. O formato final depende do que a automação repassa, por isso não confirmado.
    id: "pix_generic",
    label: "Pix via n8n ou Make (formato do Banco Central)",
    verificationMode: "aceleraflow_hmac",
    tokenHeaderName: null,
    eventIdPath: "pix.0.endToEndId",
    matchField: "deal_custom_field",
    matchPath: "pix.0.txid",
    conditions: [],
    confirmed: false,
  },
  {
    // Sistema próprio: casa com o exemplo de corpo da ajuda (InboundRuleHelp).
    id: "custom",
    label: "Personalizado (sistema próprio, n8n ou Make)",
    verificationMode: "aceleraflow_hmac",
    tokenHeaderName: null,
    eventIdPath: "id",
    matchField: "email",
    matchPath: "email",
    conditions: [],
    confirmed: true,
  },
];
