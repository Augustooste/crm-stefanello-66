import { AlertTriangle } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { INBOUND_PRESETS, type InboundPreset } from "@/lib/inbound-presets";
import { GATEWAY_PAUSE_NOTES } from "./inbound-rule-form";
import { NODE_SIGN_SNIPPET } from "./inbound-sign-snippet";

type Steps = { url: string; secret: string; event: string; notes: string[] };

// Textos por gateway. Fatos vêm do spike da Task 0 (doc oficial); nomes de menu dos painéis
// não foram conferidos, por isso as instruções falam da área de webhooks de forma genérica.
const HELP: Record<InboundPreset["id"], Steps> = {
  stripe_checkout: {
    url: "No painel do Stripe, na área de webhooks, adicione um endpoint com a URL desta regra.",
    secret:
      "Depois de criar o endpoint, o Stripe mostra o segredo de assinatura (começa com whsec_). Copie e cole aqui. Cada endpoint tem o seu, diferente entre modo teste e produção.",
    event:
      'Assine checkout.session.completed e checkout.session.async_payment_succeeded (pagamentos que só confirmam depois, como boleto). A condição "Qualquer um de" do modelo já aceita os dois, e a condição payment_status "Qualquer um de" paid, no_payment_required faz a regra agir só quando o pagamento estiver pago ou não for necessário (cupom de 100% ou período de teste).',
    notes: [
      "O e-mail do pagador vem em data.object.customer_details.email e pode vir vazio; nesse caso a regra tenta o caminho alternativo data.object.customer_email (e-mail informado ao criar o checkout). Sem nenhum dos dois, nenhum negócio é encontrado.",
      "O modelo reconhece repetições pelo id da sessão de checkout (data.object.id): o completed ainda não pago é ignorado e o async_payment_succeeded da mesma sessão é processado; dois eventos da mesma sessão agem uma vez só.",
      "Regra criada antes desta versão do modelo não muda sozinha: para aceitar no_payment_required, usar o caminho alternativo ou o id da sessão, edite a regra.",
    ],
  },
  asaas_payment: {
    url: "No painel do Asaas, na área de webhooks, cadastre um webhook com a URL desta regra.",
    secret:
      "No mesmo cadastro, preencha o token de autenticação com um valor criado por você (32 a 255 caracteres, sem espaços, diferente da sua chave de API do Asaas) e cole o mesmo valor aqui. O Asaas envia o token no cabeçalho asaas-access-token.",
    event:
      'Assine PAYMENT_RECEIVED (cobrança recebida) e PAYMENT_CONFIRMED (no cartão, é o primeiro aviso). A condição "Qualquer um de" do modelo já aceita os dois. No cartão de crédito chegam os dois: PAYMENT_CONFIRMED na aprovação e PAYMENT_RECEIVED cerca de 32 dias depois; no boleto também chegam os dois e o Pix só envia PAYMENT_RECEIVED. Mantenha os dois: o modelo reconhece repetições pelo id da cobrança (payment.id), então a regra age no primeiro e o segundo aparece como reenvio no histórico, inclusive para nota e atividade. Deixar só PAYMENT_RECEIVED atrasa o cartão em cerca de 32 dias.',
    notes: [
      "PAYMENT_RECEIVED também é enviado quando a cobrança é marcada como recebida em dinheiro (billingType RECEIVED_IN_CASH). Para ignorar esse caso, acrescente uma segunda condição em payment.billingType com 'Qualquer um de' listando só os meios que você aceita (por exemplo BOLETO, PIX, CREDIT_CARD).",
      "Regra criada antes desta versão do modelo usa o id do evento: nota e atividade acontecem duas vezes no cartão. Para mudar, edite a regra e troque o caminho do id do evento para payment.id. Cobranças de cartão já confirmadas antes da troca ainda geram uma repetição de nota/atividade quando o PAYMENT_RECEIVED chegar (a chave nova não reconhece o evento antigo).",
      "O evento de cobrança do Asaas não traz e-mail nem telefone. Crie um campo personalizado no negócio (por exemplo, número do pedido), preencha com o mesmo valor que você envia como externalReference ao criar a cobrança, e escolha esse campo na identificação.",
    ],
  },
  hotmart_purchase: {
    url: "No painel de desenvolvedor da Hotmart, na configuração de webhook, cadastre a URL desta regra.",
    secret:
      "Copie o hottok mostrado pela Hotmart e cole aqui. Ele é um só por conta (vale para todas as configurações) e só o suporte da Hotmart troca. A Hotmart envia no cabeçalho X-HOTMART-HOTTOK.",
    event: "Assine PURCHASE_APPROVED (compra aprovada), versão 2.0.0 do webhook.",
    notes: [
      "O e-mail do comprador (data.buyer.email) só vem quando o checkout pede esse dado.",
      'Para casar por telefone, em "Identificar o negócio por" escolha Telefone, use o caminho data.buyer.checkout_phone (DDD + número, só dígitos e sem DDI, como 31986667532) e preencha o campo "Prefixo do país (opcional)" com 55. Não use data.buyer.checkout_phone_code: ele é só o DDD de compradores brasileiros e o botão de teste da Hotmart manda um valor falso. O campo data.buyer.phone não existe.',
      "O id do evento é o campo id do corpo (um UUID por envio). Não troque por data.purchase.transaction: a mesma transação gera PURCHASE_APPROVED, PURCHASE_COMPLETE, PURCHASE_REFUNDED e outros eventos, e eles seriam tratados como repetição.",
    ],
  },
  pix_generic: {
    url: "Pix direto do banco ou PSP exige certificado mútuo (mTLS) e não chega direto aqui. Receba o aviso do Pix no seu n8n ou Make e faça o POST assinado para a URL desta regra.",
    secret:
      "Use o segredo whin_ mostrado ao criar a regra para assinar cada POST (exemplo abaixo).",
    event:
      "O modelo supõe que a automação repassa o corpo no formato do Banco Central (lista pix com endToEndId e txid). Se ela montar outro formato, ajuste os caminhos.",
    notes: [
      "Crie um campo personalizado no negócio com o txid da cobrança Pix e escolha esse campo na identificação.",
      "Se o seu recebimento Pix é pelo Asaas, use o modelo Asaas.",
    ],
  },
  custom: {
    url: "No seu sistema, n8n ou Make, configure um POST com Content-Type: application/json para a URL desta regra.",
    secret:
      "Assine cada POST com o segredo whin_ mostrado ao criar a regra: cabeçalho X-Aceleraflow-Signature no formato t=<unix>,v1=<hex>, HMAC-SHA256 de <t>.<corpo> (exemplo abaixo). Requisição com t a mais de 5 minutos do horário atual é recusada.",
    event:
      'Envie um id único por evento. O modelo espera, por exemplo: {"id": "pedido-123", "email": "cliente@exemplo.com"}.',
    notes: [],
  },
};

// Espelho de supabase/functions/inbound-webhook/handler.ts e da OpenAPI (receiveInboundWebhook).
const RESPONSES: ReadonlyArray<readonly [string, string]> = [
  [
    "200",
    "recebido, haja ou não negócio correspondente. Para Stripe, Asaas e Hotmart (e qualquer regra com token), um evento sem o id ou com JSON inválido também recebe 200 e é ignorado: não entra no histórico; o evento sem id soma no contador de ignorados da regra. Erro de dado ao aplicar a ação (Falhou) também recebe 200: o gateway não tenta de novo, reenvie pelo painel do gateway.",
  ],
  [
    "400",
    "no sistema próprio (HMAC), corpo que não é JSON válido ou sem o id do evento. Não reenvie sem corrigir.",
  ],
  [
    "401",
    "regra inexistente, pausada ou assinatura/token inválido. Com a regra pausada os eventos podem se perder: reative logo (veja abaixo o que o gateway faz).",
  ],
  ["413", "corpo acima de 64 KB."],
  [
    "429",
    "acima do limite por minuto: 120 requisições por regra, ou o limite de ações por minuto da regra (padrão 30). Reenvie depois do tempo do cabeçalho Retry-After.",
  ],
  [
    "503",
    "erro transitório (reenvie) ou limite diário de ações atingido: a regra pausa e as próximas requisições recebem 401 até alguém reativar.",
  ],
];

// Qual nota de GATEWAY_PAUSE_NOTES vale para cada modelo.
const PAUSE_GATEWAY: Record<InboundPreset["id"], string> = {
  stripe_checkout: "Stripe",
  asaas_payment: "Asaas",
  hotmart_purchase: "Hotmart",
  pix_generic: "Sistema próprio, n8n ou Make",
  custom: "Sistema próprio, n8n ou Make",
};

const SIGNS_WITH_OUR_SECRET = new Set<InboundPreset["id"]>(["custom", "pix_generic"]);

export function InboundRuleHelp({ presetId }: { presetId: InboundPreset["id"] }) {
  const preset = INBOUND_PRESETS.find((p) => p.id === presetId);
  if (!preset) return null;
  const help = HELP[preset.id];
  return (
    <section aria-label={`Como configurar: ${preset.label}`} className="flex flex-col gap-3">
      {!preset.confirmed && (
        <Alert>
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>Confira na documentação do gateway</AlertTitle>
          <AlertDescription>
            Os caminhos deste modelo não foram confirmados para o seu caso. Teste com um evento real
            antes de ativar.
          </AlertDescription>
        </Alert>
      )}
      <ol className="flex list-decimal flex-col gap-2 break-words pl-5 text-body text-muted-foreground">
        <li>{help.url}</li>
        <li>{help.secret}</li>
        <li>{help.event}</li>
      </ol>
      {help.notes.map((note) => (
        <p key={note} className="text-body text-muted-foreground">
          {note}
        </p>
      ))}
      <p className="text-body text-muted-foreground">
        Reenvio do mesmo evento não repete a ação, exceto quando ele falhou, bateu no limite, não
        encontrou o negócio, achou mais de um ou foi ignorado porque as condições não casaram: aí é
        processado de novo. Respostas que o sistema externo recebe:
      </p>
      <ul
        aria-label="Respostas da URL"
        className="flex list-disc flex-col gap-1 pl-5 text-body text-muted-foreground"
      >
        {RESPONSES.map(([code, text]) => (
          <li key={code} className="break-words">
            <code className="font-mono">{code}</code>: {text}
          </li>
        ))}
      </ul>
      <p className="text-body text-muted-foreground">
        Se a regra ficar pausada (manualmente ou pelo limite diário), não há garantia de reenvio:{" "}
        {PAUSE_GATEWAY[preset.id]}{" "}
        {GATEWAY_PAUSE_NOTES.find(([gateway]) => gateway === PAUSE_GATEWAY[preset.id])?.[1]}
      </p>
      {SIGNS_WITH_OUR_SECRET.has(preset.id) && (
        <pre
          tabIndex={0}
          aria-label="Exemplo de assinatura em Node"
          className="max-h-96 min-w-0 max-w-full overflow-x-auto overflow-y-auto rounded-md border border-border bg-muted p-3 font-mono text-caption text-foreground"
        >
          <code>{NODE_SIGN_SNIPPET}</code>
        </pre>
      )}
    </section>
  );
}
