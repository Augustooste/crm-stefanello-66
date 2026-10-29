# Webhooks do CRM

Guia de uso dos webhooks do CRM: como receber eventos do CRM no seu sistema (webhooks de saída), como fazer um gateway de pagamento ou automação atualizar negócios sozinho (regras de entrada) e como usar a API pública.

Tudo fica em **Configurações > Desenvolvedores**. A aba só aparece para quem tem a permissão de desenvolvedor (`developer.manage`).

> **Exemplos fictícios.** Todo segredo, chave, id e URL deste guia é inventado. Troque `SEU-PROJETO` pelo endereço do seu projeto e nunca cole um segredo real em chat, e-mail ou repositório.

## Índice

- [Comece em 5 minutos](#comece)
- [Visão geral](#visao-geral)
- [Webhooks de saída](#saida)
- [Verificar a assinatura](#assinatura)
- [Regras de entrada](#entrada)
- [Condições e ações](#condicoes)
- [Respostas HTTP e limites](#respostas)
- [Histórico e solução de problemas](#historico)
- [API pública](#api)
- [Segurança e boas práticas](#seguranca)
- [Perguntas frequentes](#faq)
- [Referência rápida](#referencia)

<a id="comece"></a>

## Comece em 5 minutos

### Receber eventos do CRM (saída)

1. Abra **Configurações > Desenvolvedores** e, em **Webhooks**, clique em **Criar webhook**.
2. Informe a **URL de destino** (precisa começar com `https://`) e marque os eventos, por exemplo `deal.won`.
3. Salve e copie o segredo mostrado na tela (começa com `whsec_`). Ele aparece uma vez só.
4. No seu sistema, valide o cabeçalho `X-Aceleraflow-Signature` com esse segredo (veja [Verificar a assinatura](#assinatura)) e responda com um código `2xx`.
5. Clique em **Enviar evento de teste** e confira o resultado em **Ver entregas**. O teste chega com o tipo `webhook.test` e `data` igual a `{"test": true}`.

### Atualizar negócios a partir de um sistema externo (entrada)

1. Em **Regras de entrada**, clique em **Nova regra** e escolha um modelo: Stripe, Asaas, Hotmart, Pix via n8n ou Make, ou Personalizado.
2. Siga o assistente: **Modelo**, **Verificação**, **Identificação**, **Ação** e **Revisar e testar**.
3. Escolha o funil, as etapas em que a regra pode agir e a ação (por exemplo, **Marcar como ganho**).
4. Copie a URL da regra com **Copiar URL** e cadastre no painel do gateway, junto com o segredo ou token.
5. Em **Revisar e testar**, cole um JSON de exemplo e clique em **Testar**. O teste não altera nenhum negócio.
6. Depois do primeiro evento real, confira o resultado em **Histórico**.

<a id="visao-geral"></a>

## Visão geral

| Recurso           | Direção                    | Para que serve                                                | Autenticação                                  |
| ----------------- | -------------------------- | ------------------------------------------------------------- | --------------------------------------------- |
| Webhooks de saída | CRM para o seu sistema     | Avisar quando um negócio é ganho, perdido, muda de etapa etc. | Assinatura HMAC no `X-Aceleraflow-Signature`  |
| Regras de entrada | Sistema externo para o CRM | Mover, ganhar, perder, anotar ou criar atividade num negócio  | HMAC do CRM, `Stripe-Signature` ou token fixo |
| API pública       | Seu sistema consulta o CRM | Listar e criar contatos, listar negócios                      | Cabeçalho `X-Api-Key` com chave `acf_live_`   |

<a id="saida"></a>

## Webhooks de saída

O CRM faz um `POST` com corpo JSON na sua URL a cada evento escolhido. O envio roda a cada minuto, então um evento costuma chegar em até cerca de um minuto.

### Eventos disponíveis

| Evento               | Quando acontece                         |
| -------------------- | --------------------------------------- |
| `deal.won`           | Um negócio passa para o status ganho.   |
| `deal.lost`          | Um negócio passa para o status perdido. |
| `deal.stage_changed` | Um negócio muda de etapa.               |
| `contact.created`    | Um contato é criado.                    |

O tipo `webhook.test` só chega pelo botão **Enviar evento de teste**.

### Formato da entrega

Cabeçalhos enviados:

| Cabeçalho                 | Valor                                                            |
| ------------------------- | ---------------------------------------------------------------- |
| `Content-Type`            | `application/json`                                               |
| `User-Agent`              | `Aceleraflow-Webhooks/1`                                         |
| `X-Aceleraflow-Event`     | Tipo do evento, por exemplo `deal.won`                           |
| `X-Aceleraflow-Delivery`  | Id da entrega (o mesmo em todas as tentativas da entrega)        |
| `X-Aceleraflow-Signature` | `t=<unix>,v1=<hex>` (veja [Verificar a assinatura](#assinatura)) |

Corpo (envelope igual para todos os eventos; exemplo de `deal.won`):

```json
{
  "id": "6f1c2a9e-0000-4000-8000-000000000001",
  "type": "deal.won",
  "api_version": "2026-10-20",
  "created_at": "2026-10-22T14:03:11.512Z",
  "tenant_id": "6f1c2a9e-0000-4000-8000-0000000000aa",
  "data": {
    "deal": {
      "id": "6f1c2a9e-0000-4000-8000-000000000010",
      "title": "Plano anual",
      "value": 4800,
      "currency": "BRL",
      "board_id": "6f1c2a9e-0000-4000-8000-000000000020",
      "board_name": "Vendas",
      "stage_id": "6f1c2a9e-0000-4000-8000-000000000030",
      "stage_name": "Ganho",
      "closed_at": "2026-10-22T14:03:11.512Z"
    },
    "contact": {
      "id": "6f1c2a9e-0000-4000-8000-000000000040",
      "name": "Maria Exemplo",
      "email": "maria@exemplo.com",
      "phone": "+5511900000000"
    }
  }
}
```

Conteúdo de `data` por evento:

| Evento                   | Campos de `data`                                                                                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deal.won` e `deal.lost` | `deal` (`id`, `title`, `value`, `currency`, `board_id`, `board_name`, `stage_id`, `stage_name`, `closed_at`) e `contact` (`id`, `name`, `email`, `phone`, ou `null` sem contato) |
| `deal.stage_changed`     | `history_id`, `deal_id`, `from_stage_id`, `to_stage_id`, `changed_by_user_id`, `changed_by_automation`, `board_id`                                                               |
| `contact.created`        | `contact_id`, `status`, `owner_id` (só identificadores: busque o contato em `GET /v1/contacts/{id}`)                                                                             |
| `webhook.test`           | `{"test": true}`                                                                                                                                                                 |

> **Use o `id` do envelope para não processar duas vezes.** O mesmo evento pode chegar de novo (nova tentativa ou reenvio manual) com o mesmo `id`. Guarde os ids já processados.

### Filtro por funil e etapa

No cadastro do webhook, **Filtrar negócios (opcional)** limita o envio a um funil e, dentro dele, a algumas etapas.

- Vale só para eventos de negócio (`deal.*`). `contact.created` não é filtrado.
- A etapa considerada é a de destino. Se a etapa for de ganho, você recebe `deal.won` e `deal.stage_changed` (se assinou os dois).
- Sem etapa marcada, vale qualquer etapa do funil.
- Se o funil ou a etapa do filtro for apagado, o webhook é desativado (o filtro nunca vira "todos"). Edite o filtro para reativar.

### Tentativas, falhas e reenvio

- Sucesso é qualquer resposta `2xx` dentro de 10 segundos.
- Redirecionamento (`3xx`) não é seguido e conta como falha, assim como `4xx`, `5xx`, tempo esgotado e erro de rede.
- Depois de uma falha, a próxima tentativa espera 1 min, 5 min, 30 min, 2 h, 6 h e depois 24 h (com variação de até 10% para mais ou para menos).
- São até 8 tentativas. Depois disso a entrega fica como **Falhou** e não é tentada de novo sozinha.
- Em **Ver entregas**, uma entrega que falhou mostra o botão **Reenviar**, que recomeça as tentativas.
- Resposta `410 Gone` desativa o webhook.
- Corpo acima de 256 KB não é enviado e a entrega fica como **Falhou** na hora.
- O CRM guarda o código de resposta e o início do corpo da sua resposta (até 2 KB) para você conferir em **Ver entregas**.

> **Webhook pausado não recebe eventos novos.** Ao clicar em **Pausar**, eventos que acontecerem nesse período não são enfileirados para esse webhook. Entregas que já estavam na fila continuam tentando e terminam como **Falhou** se o webhook não voltar a tempo.

### Segredo e rotação

- O segredo do webhook (`whsec_…`) aparece uma vez, ao criar e ao rotacionar.
- **Rotacionar segredo** cria um segredo novo na hora. O anterior continua válido por 24 horas; nesse período cada entrega leva duas assinaturas `v1` (uma por segredo). Atualize seu sistema dentro desse prazo.

### Limites e regras da URL

- Até 20 webhooks por conta.
- Só `https://`. Endereços internos (como `localhost`, `*.local`, `*.internal`), IPs privados e domínios que resolvem para IP privado são recusados no envio.

<a id="assinatura"></a>

## Verificar a assinatura

Cada entrega traz:

```text
X-Aceleraflow-Signature: t=1792700000,v1=5d2f…
```

Para validar:

1. Separe `t` (horário em segundos, Unix) e cada `v1` do cabeçalho.
2. Recuse se `t` estiver a mais de 300 segundos (5 minutos) do horário atual.
3. Calcule o HMAC-SHA256, em hexadecimal minúsculo, de `<t>.<corpo>` usando o segredo do webhook. Use o corpo cru, exatamente como chegou.
4. Aceite se algum `v1` for igual ao calculado (compare em tempo constante).

> **Não reserialize o JSON.** Converter o corpo para objeto e de volta para texto muda espaços e ordem e quebra a assinatura. Leia o corpo como texto antes de qualquer parser.

> **Hexadecimal minúsculo.** A assinatura em maiúsculas é recusada.

### Node

<!-- prettier-ignore -->
```js
const crypto = require("node:crypto");

// header: valor de X-Aceleraflow-Signature; rawBody: corpo EXATO recebido (string, sem re-serializar).
function verifyAceleraflowSignature(secret, header, rawBody, toleranceSeconds = 300, nowMs = Date.now()) {
  let t = null;
  const signatures = [];
  for (const part of String(header).split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t" && /^\d+$/.test(value)) t = Number(value);
    else if (key === "v1" && value) signatures.push(value);
  }
  if (t === null || signatures.length === 0) return false;
  if (!(Math.abs(nowMs / 1000 - t) <= toleranceSeconds)) return false;
  const expected = Buffer.from(
    crypto.createHmac("sha256", secret).update(t + "." + rawBody).digest("hex"),
  );
  let ok = false;
  for (const candidate of signatures) {
    const received = Buffer.from(candidate);
    if (received.length === expected.length && crypto.timingSafeEqual(received, expected)) ok = true;
  }
  return ok;
}

module.exports = { verifyAceleraflowSignature };
```

### Python

<!-- prettier-ignore -->
```python
import hashlib
import hmac
import time


def verify_aceleraflow_signature(secret, header, raw_body, tolerance_seconds=300, now=None):
    """header: valor de X-Aceleraflow-Signature; raw_body: corpo EXATO recebido (str ou bytes)."""
    body = raw_body.encode() if isinstance(raw_body, str) else raw_body
    t = None
    signatures = []
    for part in str(header).split(","):
        key, sep, value = part.partition("=")
        key, value = key.strip(), value.strip()
        if not sep:
            continue
        if key == "t" and value.isascii() and value.isdigit():
            t = int(value)
        elif key == "v1" and value:
            signatures.append(value)
    if t is None or not signatures:
        return False
    current = time.time() if now is None else now
    if abs(current - t) > tolerance_seconds:
        return False
    expected = hmac.new(secret.encode(), str(t).encode() + b"." + body, hashlib.sha256).hexdigest()
    ok = False
    for candidate in signatures:
        if hmac.compare_digest(candidate.encode(), expected.encode()):
            ok = True
    return ok
```

### Testar no terminal

Gere uma assinatura igual à do CRM com `openssl` (útil para conferir o seu código):

```bash
SECRET='whsec_exemplo_nao_use'
BODY='{"id":"evt-1","type":"webhook.test","data":{"test":true}}'
T=$(date +%s)
printf '%s.%s' "$T" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //'
```

<a id="entrada"></a>

## Regras de entrada

Uma regra de entrada é uma URL própria que recebe eventos de um gateway ou sistema externo e aplica uma ação num negócio de um funil.

```text
https://SEU-PROJETO.supabase.co/functions/v1/inbound-webhook/<id-da-regra>
```

Copie a URL exata com o botão **Copiar URL** da regra. Ela não usa chave de API: a autenticidade vem do modo de verificação.

### Modos de verificação

| Modo                                           | Quem usa                        | Como o CRM confere                                                                                  |
| ---------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------- |
| Assinatura do Aceleraflow (`aceleraflow_hmac`) | Sistema próprio, n8n, Make, Pix | `X-Aceleraflow-Signature`, mesmo esquema da saída, com o segredo `whin_` gerado na criação da regra |
| Assinatura do Stripe (`stripe_signature`)      | Stripe                          | `Stripe-Signature`, com o segredo `whsec_` do endpoint cadastrado no Stripe                         |
| Token em header (`header_token`)               | Asaas, Hotmart                  | Token fixo num cabeçalho de nome configurável                                                       |

- Nos modos externos o segredo ou token colado precisa ter de 8 a 512 caracteres.
- O cabeçalho do token não pode ser `host`, `content-length`, `content-type`, `authorization` nem `cookie`.
- Até 20 regras de entrada por conta.

### Modelos prontos

| Modelo                                         | Verificação                           | Identificação                                      | Condições do modelo                                                                                                                                                       |
| ---------------------------------------------- | ------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stripe: checkout concluído                     | `stripe_signature`                    | E-mail em `data.object.customer_details.email`     | `type` qualquer um de `checkout.session.completed`, `checkout.session.async_payment_succeeded`; `data.object.payment_status` qualquer um de `paid`, `no_payment_required` |
| Asaas (cobrança recebida)                      | `header_token` (`asaas-access-token`) | Campo personalizado em `payment.externalReference` | `event` qualquer um de `PAYMENT_RECEIVED`, `PAYMENT_CONFIRMED`                                                                                                            |
| Hotmart (compra aprovada)                      | `header_token` (`X-HOTMART-HOTTOK`)   | E-mail em `data.buyer.email`                       | `event` igual a `PURCHASE_APPROVED`                                                                                                                                       |
| Pix via n8n ou Make (formato do Banco Central) | `aceleraflow_hmac`                    | Campo personalizado em `pix.0.txid`                | Nenhuma (id do evento em `pix.0.endToEndId`)                                                                                                                              |
| Personalizado (sistema próprio, n8n ou Make)   | `aceleraflow_hmac`                    | E-mail em `email`                                  | Nenhuma (id do evento em `id`)                                                                                                                                            |

O id do evento (usado para reconhecer repetições) é `data.object.id` no Stripe (id da sessão de checkout), `payment.id` no Asaas (id da cobrança) e `id` na Hotmart.

> **Regra já criada não muda sozinha.** Os modelos valem só para regra nova. Regra criada antes continua com o caminho do id, as condições e a identificação que tinha. Para usar o modelo atual, abra **Editar** e troque os campos.

> **Modelo Pix não confirmado.** O formato final depende do que a sua automação repassa. Teste com um evento real antes de ativar.

### Stripe

1. No painel do Stripe, na área de webhooks, adicione um endpoint com a URL da regra.
2. Assine `checkout.session.completed` e `checkout.session.async_payment_succeeded` (pagamentos que só confirmam depois).
3. Copie o segredo de assinatura do endpoint (começa com `whsec_`) e cole na regra. Cada endpoint tem o seu, diferente entre modo teste e produção.

- A condição de `payment_status` aceita `paid` e `no_payment_required` (checkout sem cobrança, como cupom de 100% ou período de teste). O `completed` com `unpaid` (boleto ainda não pago) é ignorado; a regra age no `async_payment_succeeded`. Regra criada antes dessa mudança não muda sozinha: edite a condição se quiser aceitar `no_payment_required`.
- O e-mail do pagador (`customer_details.email`) pode vir `null`, por exemplo em Payment Link sem coleta de e-mail. O modelo usa `data.object.customer_email` (e-mail informado ao criar o checkout) como caminho alternativo. Sem nenhum dos dois, nenhum negócio é encontrado. Confira na documentação do Stripe quais campos seu checkout preenche.
- O modelo reconhece repetições pelo id da sessão (`data.object.id`). O `completed` ainda não pago fica **Ignorado** com as condições falsas e o `async_payment_succeeded` da mesma sessão é processado. Dois eventos da mesma sessão agem uma vez só.
- O CRM aceita a assinatura com até 300 segundos de diferença de horário (mesmo padrão das bibliotecas do Stripe).
- Se a URL falhar, o Stripe tenta de novo por até 3 dias; depois disso, só o reenvio manual no Dashboard, para eventos dos últimos 15 dias. Fonte: [docs.stripe.com/webhooks](https://docs.stripe.com/webhooks).

### Asaas

1. No painel do Asaas, na área de webhooks, cadastre um webhook com a URL da regra.
2. Preencha o token de autenticação com um valor criado por você (32 a 255 caracteres, sem espaços, diferente da sua chave de API do Asaas) e cole o mesmo valor na regra. O Asaas envia o token no cabeçalho `asaas-access-token`. Fonte: [docs.asaas.com/docs/criar-novo-webhook-pela-api](https://docs.asaas.com/docs/criar-novo-webhook-pela-api).
3. Assine `PAYMENT_RECEIVED` e `PAYMENT_CONFIRMED`.

- O evento de cobrança do Asaas não traz e-mail nem telefone. Crie um campo personalizado no negócio (por exemplo, número do pedido), preencha com o mesmo valor enviado como `externalReference` ao criar a cobrança e escolha esse campo na identificação.
- No cartão de crédito chegam dois eventos: `PAYMENT_CONFIRMED` na aprovação e `PAYMENT_RECEIVED` cerca de 32 dias depois, quando o dinheiro fica disponível. No boleto também chegam os dois (`PAYMENT_CONFIRMED` e depois `PAYMENT_RECEIVED`). Pix só envia `PAYMENT_RECEIVED`. Mantenha os dois eventos na regra. O modelo reconhece repetições pelo id da cobrança (`payment.id`): a regra age no primeiro evento e o segundo aparece como **Reenviado N vezes** no evento original, mesmo sendo de outro tipo. Isso vale também para nota e atividade, que acontecem uma vez só. Deixar só `PAYMENT_RECEIVED` atrasa o cartão em cerca de 32 dias.
- Regra do Asaas criada antes dessa mudança usa o `id` do evento: nota e atividade acontecem duas vezes no cartão. Para corrigir, edite a regra e troque o caminho do id do evento para `payment.id`. Cobranças de cartão já confirmadas antes da troca ainda geram uma repetição de nota/atividade quando o `PAYMENT_RECEIVED` chegar, porque a chave nova não reconhece o evento antigo. Fonte: [docs.asaas.com/docs/webhook-para-cobrancas](https://docs.asaas.com/docs/webhook-para-cobrancas).
- `PAYMENT_RECEIVED` também sai quando a cobrança é marcada como recebida em dinheiro (`RECEIVED_IN_CASH`). Para ignorar, acrescente uma condição em `payment.billingType` com **Qualquer um de** listando só os meios que você aceita.
- O Asaas só considera entregue a resposta `200` e pausa a fila depois de 15 falhas seguidas, guardando os eventos por 14 dias. A fila só volta quando alguém a retoma no painel do Asaas. Fonte: [docs.asaas.com/docs/fila-pausada](https://docs.asaas.com/docs/fila-pausada).

### Hotmart

1. No painel de desenvolvedor da Hotmart, na configuração de webhook, cadastre a URL da regra.
2. Assine `PURCHASE_APPROVED`, versão 2.0.0 do webhook.
3. Copie o hottok e cole na regra. A Hotmart envia no cabeçalho `X-HOTMART-HOTTOK`.

- O hottok é um só por conta (vale para todas as configurações) e só o suporte da Hotmart troca. Fonte: [developers.hotmart.com](https://developers.hotmart.com/docs/en/2.0.0/webhook/purchase-webhook/).
- O modelo usa o `id` do evento para reconhecer repetições. Se o mesmo pedido aparecer duas vezes no **Histórico**, confira na documentação da Hotmart se o reenvio mantém o `id`.
- O e-mail do comprador (`data.buyer.email`) só vem quando o comprador o informou no checkout.
- Para casar por telefone, em **Identificar o negócio por** escolha **Telefone**, use o caminho `data.buyer.checkout_phone` (DDD + número, só dígitos e sem DDI, como `31986667532`) e preencha **Prefixo do país (opcional)** com `55`. Não use `data.buyer.checkout_phone_code`: ele é só o DDD de compradores brasileiros e o botão de teste da Hotmart manda um valor falso. O campo `data.buyer.phone` não existe.
- A chave para reconhecer repetições é o `id` do corpo (um UUID por evento), não `data.purchase.transaction`. A mesma transação gera `PURCHASE_APPROVED`, `PURCHASE_COMPLETE`, `PURCHASE_REFUNDED` e outros eventos; com a transação como chave, só o primeiro seria processado e os demais apareceriam como repetição.
- A Hotmart pode desativar a configuração de webhook quando a URL falha. Confira no painel se ela continua ativa. Fonte: [central de ajuda da Hotmart](https://help.hotmart.com/en/article/360001491352/how-to-set-up-your-api-through-webhook-postback-).
- O conteúdo do evento de teste da Hotmart não é documentado: confira a documentação do gateway e o **Histórico** antes de contar com ele.

### n8n, Make ou sistema próprio

Use o modelo **Personalizado** (ou **Pix via n8n ou Make**). Assine cada `POST` com o segredo `whin_` mostrado ao criar a regra, no mesmo formato da saída. Exemplo com `curl`:

```bash
SECRET='whin_exemplo_nao_use'
URL='https://SEU-PROJETO.supabase.co/functions/v1/inbound-webhook/ID-DA-REGRA'
BODY='{"id":"pedido-123","email":"cliente@exemplo.com"}'
T=$(date +%s)
SIG=$(printf '%s.%s' "$T" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')
curl -X POST "$URL" \
  -H "Content-Type: application/json" \
  -H "X-Aceleraflow-Signature: t=$T,v1=$SIG" \
  --data "$BODY"
```

- Envie um `id` único por evento. Repetir o mesmo `id` não repete a ação, exceto nos casos de [reprocesso](#historico).
- O corpo precisa ser um objeto JSON de até 64 KB.
- Requisição com `t` a mais de 5 minutos do horário atual é recusada.
- Pix direto do banco ou PSP exige certificado mútuo (mTLS) e não chega direto ao CRM. Receba o aviso no n8n ou Make e faça o `POST` assinado. Se o seu Pix é pelo Asaas, use o modelo Asaas.

<a id="condicoes"></a>

## Condições e ações

### Caminhos

Caminho é a posição de um campo no JSON recebido, com pontos: `data.buyer.email`. Item de lista usa o número: `pix.0.txid`. Cada parte aceita letras, números, `_` e `-`; até 10 partes e 200 caracteres.

### Condições

A regra só age quando **todas** as condições são verdadeiras. Até 5 condições por regra.

| Tipo                  | Exemplo                                                        | Casa quando                           |
| --------------------- | -------------------------------------------------------------- | ------------------------------------- |
| Igual a (`equals`)    | `event` igual a `PURCHASE_APPROVED`                            | O valor é exatamente esse texto       |
| Qualquer um de (`in`) | `event` qualquer um de `PAYMENT_RECEIVED`, `PAYMENT_CONFIRMED` | O valor é um dos itens (1 a 10 itens) |

Campo ausente nunca casa. Cada condição pode aplicar uma transformação antes de comparar: **Remover espaços**, **Minúsculas**, **Só dígitos** ou **Centavos para reais**.

### Identificação do negócio

| Identificação                  | Como compara                                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| E-mail                         | E-mail do contato, sem diferenciar maiúsculas                                                                  |
| Telefone                       | Telefone do contato em `+` e dígitos; o prefixo configurado (como `+55`) só entra se o número não vier com `+` |
| Campo personalizado do negócio | Valor do campo personalizado escolhido                                                                         |

Para e-mail e telefone, a regra aceita um **caminho alternativo do identificador** (`match_fallback_path`, opcional). Se o caminho principal vier vazio ou ausente, a regra tenta o alternativo, com a mesma transformação e o mesmo prefixo. Campo personalizado não usa caminho alternativo.

A busca olha só os negócios do funil da regra. Para e-mail e telefone, só contatos ativos (não apagados nem mesclados).

| Resultado                           | O que a regra faz                     |
| ----------------------------------- | ------------------------------------- |
| Um negócio aberto                   | Aplica a ação                         |
| Mais de um negócio aberto           | Não age e registra **Ambíguo**        |
| Só negócios fechados                | Não age e registra **Ignorado**       |
| Nenhum negócio                      | Não age e registra **Não encontrado** |
| Negócio já está na etapa de destino | Não muda nada                         |

Quando nada é encontrado, a regra pode **Só registrar no histórico** ou **Registrar e guardar o identificador**.

### Ações

| Ação                | O que faz                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| Mover de etapa      | Move para uma etapa aberta entre as etapas permitidas da regra                                  |
| Marcar como ganho   | Move para uma etapa de ganho permitida                                                          |
| Marcar como perdido | Move para uma etapa de perda permitida, com motivo vindo de um caminho, de um texto ou dos dois |
| Registrar nota      | Grava uma nota já concluída no negócio (texto de 1 a 500 caracteres)                            |
| Criar atividade     | Cria uma atividade pendente (título de 1 a 500 caracteres, prazo de 0 a 720 horas, padrão 24)   |

Cada regra escolhe de 1 a 20 etapas permitidas. Nota, motivo e título aceitam modelos com `{{caminho}}`, por exemplo `Pedido {{id}} pago`.

> **Não use campos de segredo em `{{caminho}}`.** Campos como `hottok`, `token`, `secret`, `signature` e `authorization` iriam para o histórico do negócio.

<a id="respostas"></a>

## Respostas HTTP e limites

Respostas da URL da regra (todas trazem o cabeçalho `X-Request-Id`, útil para suporte):

| Código | Quando                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `200`  | Recebido, haja ou não negócio correspondente, inclusive evento repetido. Nos modos `stripe_signature` e `header_token` (todos os modelos de gateway e qualquer regra personalizada com token), evento sem id, JSON inválido ou texto com o caractere nulo (`\u0000`) também recebe `200` com o motivo em `ignored` e não é processado. Erro de dado ao aplicar a ação (**Falhou**) também recebe `200`: o gateway não tenta de novo. Reenvie pelo painel do gateway. |
| `400`  | Só no modo `aceleraflow_hmac`: corpo que não é objeto JSON válido, sem o id do evento ou com o caractere nulo (`\u0000`). Em todos os modos: corpo que não é UTF-8 válido. Não reenvie sem corrigir.                                                                                                                                                                                                                                                                 |
| `401`  | Regra inexistente, pausada ou assinatura/token inválido (mesma resposta nos três casos: `{"error": "unauthorized"}`).                                                                                                                                                                                                                                                                                                                                                |
| `405`  | Método diferente de `POST`.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `413`  | Corpo acima de 64 KB.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `429`  | Acima do limite por minuto. Reenvie depois do tempo do cabeçalho `Retry-After`.                                                                                                                                                                                                                                                                                                                                                                                      |
| `503`  | Erro transitório (reenvie) ou limite diário de ações atingido.                                                                                                                                                                                                                                                                                                                                                                                                       |

Exemplo de resposta de sucesso:

```json
{ "received": true, "request_id": "0b7d3c1e-0000-4000-8000-000000000001" }
```

### Limites

| Limite                           | Valor                                                                                                                   |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Requisições por minuto por regra | 120 (contadas só depois de a assinatura ser aceita)                                                                     |
| Ações por minuto por regra       | 30 por padrão (configurável de 1 a 120)                                                                                 |
| Ações por dia por regra          | 500 nas últimas 24 horas por padrão (configurável de 1 a 5000; **Reativar** zera a contagem); ao atingir, a regra pausa |
| Tamanho do corpo                 | 64 KB                                                                                                                   |
| Tolerância da assinatura         | 300 segundos                                                                                                            |
| Regras por conta                 | 20                                                                                                                      |

Para mudar os limites, use o botão **Limites** da regra. O limite por minuto vai até 120 porque a URL aceita no máximo 120 requisições por minuto por regra.

> **Baixar o limite diário pode pausar a regra.** Se o novo limite for igual ou menor que as ações das últimas 24 horas (ou desde o último **Reativar**), a regra pausa na próxima ação e só volta com **Reativar**.

> **Limite diário pausa a regra.** O evento que estoura o limite recebe `503` e os seguintes recebem `401` até alguém clicar em **Reativar**. Nenhum gateway garante reenvio depois: reative logo.

<a id="historico"></a>

## Histórico e solução de problemas

O botão **Histórico** de cada regra mostra os eventos dos últimos 90 dias, sem o corpo recebido (só os valores extraídos e o resultado).

| Status          | Significado                                                                          |
| --------------- | ------------------------------------------------------------------------------------ |
| Processando     | Evento em processamento                                                              |
| Processado      | A ação foi aplicada                                                                  |
| Ignorado        | As condições não casaram, o negócio estava fechado ou já estava na etapa de destino  |
| Não encontrado  | Nenhum negócio com o identificador                                                   |
| Ambíguo         | Mais de um negócio aberto com o identificador                                        |
| Limite atingido | Limite de ações da regra                                                             |
| Falhou          | Erro de dado ao aplicar a ação. Recebe 200; reenvie pelo gateway para tentar de novo |

Quando o mesmo evento chega de novo, o histórico mostra **Reenviado N vezes** no evento original e a ação não se repete.

**Reprocesso.** O reenvio processa o evento de novo quando ele ficou com:

- **Falhou** ou **Limite atingido** (é assim que se recupera um evento depois de **Reativar**);
- **Ignorado** porque as condições não casaram (por exemplo, o `completed` do Stripe ainda não pago e depois o `async_payment_succeeded` com o mesmo id);
- **Não encontrado** ou **Ambíguo** (corrija o negócio e reenvie).

**Ignorado** porque o negócio estava fechado ou já estava na etapa de destino não é reprocessado.

**Ignorados antes do histórico.** Evento que nem vira linha no histórico (sem o id do evento) soma no contador de ignorados da regra, mostrado na lista como "N ignorados (último: motivo, data)". Os motivos são: evento sem id (`missing_event_id`), JSON inválido (`invalid_json`), corpo que não é objeto JSON (`invalid_payload`) e caractere nulo no corpo (`nul_payload`). Os quatro são contados nos modos `stripe_signature` e `header_token`, dentro do limite de requisições por minuto da regra: acima dele, JSON inválido, corpo que não é objeto e caractere nulo recebem o mesmo `200` e não são contados. No modo `aceleraflow_hmac` o evento sem id também é contado; JSON inválido, corpo que não é objeto e caractere nulo recebem `400` e não entram no contador. Para o corpo com `\u0000`, a resposta `200` traz `ignored: invalid_payload`, mas o contador registra o motivo `nul_payload`.

**Trade-off do limite.** Esses corpos descartados passam pelo limite de 120 requisições por minuto por regra e consomem a mesma cota dos eventos válidos: um gateway que envie lixo em volume pode levar eventos válidos ao `429`.

### Pausar, reativar e rotacionar

- **Pausar** faz a URL responder `401` (o gateway vê falha). **Reativar** volta a aceitar.
- **Rotacionar segredo** troca o segredo na hora; o anterior continua válido por 24 horas.
- Excluir a regra apaga o histórico e a URL passa a responder `401`.

### O que o gateway faz quando a URL falha

| Gateway                      | Comportamento                                                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Stripe                       | Reenvia por até 3 dias e depois para; depois, só reenvio manual no Dashboard (eventos dos últimos 15 dias).             |
| Asaas                        | Pausa a fila após 15 falhas seguidas e guarda os eventos por 14 dias; a fila só volta quando alguém a retoma no painel. |
| Hotmart                      | Pode desativar a configuração de webhook; confira no painel se ela continua ativa.                                      |
| Sistema próprio, n8n ou Make | Depende de como o envio trata falhas; reenvie o que tiver sido recusado.                                                |

### Problemas comuns

| Sintoma                                                              | Causa provável e correção                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Entrega de saída sempre falha com assinatura inválida no seu sistema | O corpo foi reserializado ou o segredo está errado. Valide o corpo cru e confira o segredo (depois de rotacionar, use o novo).                                                                                                                                                                                                                   |
| Entrega de saída falha sem código                                    | Tempo esgotado (10 s), erro de rede, URL bloqueada ou redirecionamento. Responda `2xx` rápido e processe depois.                                                                                                                                                                                                                                 |
| Webhook de saída desativado sozinho                                  | Sua URL respondeu `410`, ou o funil ou a etapa do filtro foi apagado.                                                                                                                                                                                                                                                                            |
| Regra responde `401`                                                 | Regra pausada, URL errada, segredo ou token diferente do gateway, ou horário `t` fora de 5 minutos.                                                                                                                                                                                                                                              |
| Evento como **Não encontrado**                                       | O identificador não bateu: e-mail vazio, telefone em outro formato ou campo personalizado sem valor no negócio.                                                                                                                                                                                                                                  |
| Evento como **Ambíguo**                                              | Há mais de um negócio aberto do mesmo contato no funil. Feche ou mescle os duplicados.                                                                                                                                                                                                                                                           |
| Evento como **Ignorado**                                             | As condições não casaram (confira os valores no exemplo do gateway), o negócio já estava fechado ou já estava na etapa de destino.                                                                                                                                                                                                               |
| Nada aparece no histórico                                            | O evento foi recusado antes (veja o código no painel do gateway) ou chegou com `200` e `ignored` (sem id, JSON inválido, corpo que não é objeto ou caractere nulo; somam no contador, dentro do limite por minuto da regra; acima dele não contam e, no `aceleraflow_hmac`, JSON inválido, corpo que não é objeto e caractere nulo viram `400`). |

<a id="api"></a>

## API pública

Base da API:

```text
https://SEU-PROJETO.supabase.co/functions/v1/public-api
```

A especificação OpenAPI 3.1 fica em `/v1/openapi.json`, relativa a essa base. Ela é pública (sem chave) e não devolve dados da conta.

### Chaves

- Crie em **Chaves de API**, com nome, escopos e validade opcional. A chave (`acf_live_…`) aparece uma vez só.
- Envie no cabeçalho `X-Api-Key`.
- Uma chave revogada ou vencida deixa de funcionar na hora.

| Escopo           | Libera                                       |
| ---------------- | -------------------------------------------- |
| `contacts:read`  | `GET /v1/contacts` e `GET /v1/contacts/{id}` |
| `contacts:write` | `POST /v1/contacts`                          |
| `deals:read`     | `GET /v1/deals` e `GET /v1/deals/{id}`       |
| `deals:write`    | Reservado, sem rotas nesta versão            |

`GET /v1/me` devolve a conta, a chave e os escopos; não exige escopo.

### Exemplos

```bash
curl "https://SEU-PROJETO.supabase.co/functions/v1/public-api/v1/contacts?limit=50" \
  -H "X-Api-Key: acf_live_EXEMPLO_NAO_USE"
```

```bash
curl -X POST "https://SEU-PROJETO.supabase.co/functions/v1/public-api/v1/contacts" \
  -H "X-Api-Key: acf_live_EXEMPLO_NAO_USE" \
  -H "Content-Type: application/json" \
  --data '{"name":"Maria Exemplo","email":"maria@exemplo.com","phone":"+5511900000000"}'
```

- Listas são paginadas: `limit` de 1 a 100 (padrão 50; acima de 100 vale 100) e `cursor` com o `next_cursor` da página anterior.
- Telefone em formato internacional com `+`, de 8 a 15 dígitos.
- Fechar negócio pela API não está disponível nesta versão: o CRM avisa ganho e perda por webhook (`deal.won` e `deal.lost`).

### Limites e erros

| Limite ou erro        | Valor                                                               |
| --------------------- | ------------------------------------------------------------------- |
| Requisições por chave | 120 a cada 60 segundos; acima disso, `429` com `Retry-After`        |
| Tamanho do corpo      | 64 KB; acima disso, `413`                                           |
| Formato do erro       | `{"error": {"code": "...", "message": "...", "request_id": "..."}}` |

Códigos de erro: `auth_missing`, `auth_invalid`, `insufficient_scope`, `tenant_inactive`, `not_found`, `method_not_allowed`, `validation_error`, `payload_too_large`, `rate_limited`, `service_unavailable` e `internal_error`.

<a id="seguranca"></a>

## Segurança e boas práticas

- Valide sempre a assinatura (saída) e nunca desligue a checagem de horário.
- Responda `2xx` rápido e processe o evento depois (fila, tarefa em segundo plano).
- Trate eventos repetidos pelo `id` do envelope (saída) ou do evento (entrada).
- Guarde segredos e chaves em variáveis de ambiente ou cofre, nunca no código nem no repositório.
- Rotacione o segredo se ele vazar; você tem 24 horas para trocar sem perder eventos.
- Dê à chave de API só os escopos necessários e uma validade, e revogue chaves sem uso.
- Use um token forte nos modos com token (o Asaas exige de 32 a 255 caracteres).

<a id="faq"></a>

## Perguntas frequentes

### Posso receber eventos de mensagens ou atividades?

Não nesta versão. Os eventos de saída disponíveis são `deal.won`, `deal.lost`, `deal.stage_changed` e `contact.created`.

### O segredo do webhook de saída e o do Stripe começam com `whsec_`. São a mesma coisa?

Não. O segredo de saída é gerado pelo CRM para o seu sistema validar o CRM. O `whsec_` do Stripe é gerado pelo Stripe e colado numa regra de entrada para o CRM validar o Stripe.

### Perdi o segredo. Como vejo de novo?

Não é possível ver de novo. Use **Rotacionar segredo**: o segredo novo aparece uma vez e o anterior continua válido por 24 horas.

### O evento chegou duas vezes. O negócio foi movido duas vezes?

Não. Na entrada, o mesmo id de evento não repete a ação e aparece como **Reenviado N vezes**. A exceção é o evento com **Falhou** ou **Limite atingido**: o reenvio processa de novo, e nota ou atividade podem acontecer nesse reenvio. Na saída, use o `id` do envelope para ignorar repetidos no seu sistema.

### A regra pausou sozinha. Por quê?

Ela atingiu o limite de ações por dia. Confira o **Histórico**, ajuste o limite se fizer sentido e clique em **Reativar**.

### Posso testar uma regra sem mexer nos negócios?

Sim. Em **Revisar e testar**, cole um JSON de exemplo e clique em **Testar**. O exemplo é avaliado pela regra salva, nenhum negócio é alterado e o exemplo não é guardado.

<a id="referencia"></a>

## Referência rápida

| Item                                   | Valor                                                      |
| -------------------------------------- | ---------------------------------------------------------- |
| Cabeçalho de assinatura                | `X-Aceleraflow-Signature: t=<unix>,v1=<hex>`               |
| Conteúdo assinado                      | HMAC-SHA256 de `<t>.<corpo cru>`, hexadecimal minúsculo    |
| Tolerância de horário                  | 300 segundos                                               |
| Versão do envelope (`api_version`)     | `2026-10-20`                                               |
| Tentativas de entrega (saída)          | Até 8, com espera de 1 min, 5 min, 30 min, 2 h, 6 h e 24 h |
| Tempo de resposta (saída)              | 10 segundos                                                |
| Validade do segredo anterior           | 24 horas após a rotação                                    |
| Webhooks de saída por conta            | 20                                                         |
| Regras de entrada por conta            | 20                                                         |
| URL da regra de entrada                | `…/functions/v1/inbound-webhook/<id-da-regra>`             |
| Corpo máximo (entrada e API)           | 64 KB                                                      |
| Requisições por minuto (regra e chave) | 120                                                        |
| Ações por minuto / por dia (regra)     | 30 / 500 por padrão (dia = últimas 24 horas)               |
| Histórico da regra                     | 90 dias                                                    |
| Prefixo da chave de API                | `acf_live_`                                                |
| OpenAPI                                | `/v1/openapi.json` (relativo à base da API pública)        |
