# ManyChat

O ManyChat entra no AceleraFlow como provider de mensageria. As mensagens chegam pela ação **Make External Request** de uma automação do ManyChat. As respostas saem pela **API pública do ManyChat**. Tudo passa pelo mesmo pipeline dos outros canais: `messaging-webhook`, `contacts`, `conversations`, `messages`, `ai-respond` e `messaging-send`.

Fontes consultadas em 29/09/2026:

- Swagger oficial: `https://api.manychat.com/swagger`, especificação em `/swagger/compileJson?type=Page_API`.
- Formato do conteúdo por canal: `https://manychat.github.io/dynamic_block_docs/channels/`.
- External Request: `https://help.manychat.com/hc/en-us/articles/14281285374364-Dev-Tools-External-request`.
- API Key: `https://help.manychat.com/hc/en-us/articles/14959510331420`.

## Decisão arquitetural

Criamos **um slug por superfície**: `manychat-whatsapp`, `manychat-instagram` e `manychat-messenger`. Toda a lógica HTTP fica num client único, `supabase/functions/_shared/messaging/manychat-client.ts`.

Um slug único `manychat` com três canais quebraria o código atual. Hoje o código assume **um canal por `(tenant, provider_slug)`** em vários pontos:

- `integration-connect` lê o canal com `.maybeSingle()` por `provider_slug`.
- O resolvedor legado do `messaging-webhook` também usa `.maybeSingle()` com `status = connected`.
- `forget` e `disconnect` atualizam por `provider_slug`.
- `messaging-send` confere `tenant_integrations` por slug.
- `integration_secrets` usa a chave `(tenant, slug, key)`.

Com três canais no mesmo slug, esses `.maybeSingle()` falhariam e todo o inbound do tenant seria descartado. Com um slug por superfície, cada canal segue o padrão que já existe e o client continua um só.

A API atual do ManyChat usa **a mesma rota para as três superfícies**, `POST /fb/sending/sendContent`. O que muda é `data.content.type`:

- `"whatsapp"` ou `"instagram"` para essas superfícies.
- Messenger omite o campo.

Por isso o client recebe a superfície como parâmetro, e não existe um client por canal.

| Slug | `channels.type` | Superfície |
|---|---|---|
| `manychat-whatsapp` | `whatsapp` | WhatsApp |
| `manychat-instagram` | `instagram` (novo) | Instagram |
| `manychat-messenger` | `messenger` (novo) | Messenger |

A migration `20260929120000_manychat_integration.sql` faz duas coisas:

- Recria `channels_type_check` com `instagram` e `messenger`, sem remover nenhum valor.
- Semeia o catálogo com `ON CONFLICT`.

Os tipos gerados do Supabase não mudam, porque `channels.type` é `text` com CHECK. `src/integrations/supabase/types.ts` não foi tocado; é arquivo gerado pelo Lovable.

## Inbound (ManyChat → AceleraFlow)

```
POST /functions/v1/messaging-webhook/<slug>/<channel_id>?token=<channels.webhook_token>
Content-Type: application/json
x-webhook-secret: <segredo gerado pelo AceleraFlow>
```

O fluxo em `messaging-webhook/index.ts`:

1. **Autenticação em dois fatores.** O `channel_id` e o `token` resolvem tenant e canal. Tenant e canal nunca vêm do corpo. Depois, `x-webhook-secret` é comparado em tempo constante com `integration_secrets.webhook_secret` do slug. Qualquer falha devolve `401`, antes de gravar qualquer coisa.
2. **Limites.** Corpo acima de 64 KB devolve `413`. JSON inválido devolve `400`. Contrato inválido devolve `422` com `{code, error}`. É esse corpo que o operador lê na aba *Response* do *Test Request*. O ManyChat não reentrega External Request, então 4xx não vira loop.
3. **Normalização.** `normalizeManyChatInbound()`, em `_shared/messaging/manychat-inbound.ts`, converte o corpo para o formato canônico.
4. **Pipeline de sempre.** Reserva em `messaging_webhook_events`, dedupe por `external_id`, contato, conversa (inclusive ressuscitar soft-delete), mensagem, cancelamento de nurture, `webhook_health = ok` e fila da IA. A política de 503 e o teto de falhas consecutivas não mudaram.

### Payload esperado

O contrato é nosso, porque o corpo do External Request é montado pelo operador. Dá para usar campos planos, a variável **Full Contact Data** em `contact`, ou os dois. Campo plano tem prioridade.

```ts
interface ManyChatInboundPayload {
  event_id?: string;             // opcional; se houver, é a chave de idempotência
  subscriber_id?: string | number;
  channel?: "whatsapp" | "instagram" | "messenger" | "facebook";
  event_type?: string;           // padrão "message.received"
  text?: string;                 // padrão: contact.last_input_text
  first_name?: string; last_name?: string; full_name?: string;
  phone?: string; email?: string;
  occurred_at?: string;          // padrão: contact.last_interaction
  contact?: Record<string, unknown>; // variável "Full Contact Data"
}
```

Modelo recomendado, também exibido e copiável na tela:

```json
{
  "channel": "instagram",
  "event_type": "message.received",
  "contact": <<Full Contact Data>>
}
```

Troque `<<Full Contact Data>>` pela variável **Full Contact Data**, usando o seletor de variáveis do ManyChat, sem aspas. Não documentamos sintaxe de variável porque o ManyChat não publica uma sintaxe textual estável: sempre use o seletor.

- **subscriber_id**: vem de `subscriber_id`, depois de `contact.key` (`"user:<id>"`), depois de `contact.id`. Os IDs têm até 17 dígitos e passam de `Number.MAX_SAFE_INTEGER`. `contact.key` é string e preserva o valor exato. Um `subscriber_id` numérico sem precisão devolve `422`, com a instrução de pôr a variável entre aspas.
- **channel**: se o corpo declarar outra superfície (a URL do Instagram colada numa automação do WhatsApp, por exemplo), a resposta é `422 channel_mismatch`.

### Idempotência

As variáveis do ManyChat não trazem id de mensagem, então a chave é montada assim:

- Com `event_id`: `manychat:<superfície>:<subscriber_id>:<event_id>`.
- Sem `event_id`: `manychat:<superfície>:` + SHA-256 de `[subscriber_id, superfície, event_type, occurred_at, texto]`.

`occurred_at` (ou `contact.last_interaction`) é **obrigatório** quando não há `event_id`. Sem nenhum dos dois, a resposta é `422 missing_idempotency_key`. É `occurred_at` que separa duas mensagens reais com o mesmo texto, e o reenvio do mesmo request repete o valor. Nada aleatório entra na chave.

Testes: `manychat.test.ts` (chave) e `manychat-webhook.test.ts` (retry não duplica; mesmo texto em outro momento vira nova mensagem).

### Identidades

- `contact_identities`: `identity_type = provider_user`, `provider_slug = <slug>`, `external_id = normalized_value = subscriber_id`.
- O `subscriber_id` **nunca** é gravado como telefone.
- Contato novo pelo subscriber_id, **só em `manychat-whatsapp`**: antes de criar outro, tenta casar pelo telefone (`whatsapp_phone` da Full Contact Data primeiro, verificado pelo WhatsApp) e depois pelo e-mail, usando `resolveContactIdentity`. Se casar, o subscriber_id vira identidade extra do mesmo contato. Não duplica.
- Em **Instagram e Messenger**, telefone e e-mail são texto digitado pelo usuário. Não são usados para vincular nem gravados: casar por eles deixaria qualquer um assumir a ficha (e o histórico que a IA usa) de outra pessoa.
- Opt-out por palavra-chave e supressão por telefone só rodam quando chega **telefone real**, em canal `whatsapp`.

## Outbound (AceleraFlow → ManyChat)

`resolveProviderDestination()`, em `_shared/messaging/contact-identity.ts`, é o único resolvedor de destino. É usado pelo envio manual (`messaging-send`), pela IA (`send-dispatch`) e pelo nurture:

- ManyChat: `provider_user` do **slug exato**. Não cai para `generic` nem para o telefone. Sem identidade, devolve o erro *"Este contato não tem ID do ManyChat para este canal…"*. Na IA, isso vira falha registrada com handoff: `awaiting_human` e aviso ao admin.
- telegram, discord, sms, email e push: mesma regra que já existia no `messaging-send`, que foi movida para cá.
- Demais providers: sem destino por identidade; continuam usando `contacts.phone` e `contacts.email`.

O envio acontece em `sendManyChatText()`:

```
POST https://api.manychat.com/fb/sending/sendContent
Authorization: Bearer <api_key>
Content-Type: application/json

{"subscriber_id":12345678901234567,"data":{"version":"v2","content":{"type":"instagram","messages":[{"type":"text","text":"..."}]}}}
```

- `subscriber_id` entra como **literal numérico cru**. O Swagger exige integer, e `Number()` arredondaria IDs de 17 dígitos.
- Texto acima do limite da superfície é dividido em até 10 mensagens. Os limites são 4096 (WhatsApp), 2000 (Messenger) e 1000 (Instagram).
- **Nunca** enviamos `message_tag`: seria burlar a janela de 24h.
- A resposta de sucesso é `{"status":"success"}`, sem id de mensagem, então `external_id = null`. HTTP 200 com `status` diferente de `success` conta como falha.

### Superfícies e capacidades

| | Texto | Mídia | Template |
|---|---|---|---|
| WhatsApp, Instagram, Messenger | sim | **não** nesta versão | não |

A documentação de canais diz que áudio, vídeo e arquivo **não** são aceitos no WhatsApp e no Instagram. Mídia inbound não é baixada: o External Request só carrega texto. `AUDIO_CAPABLE_PROVIDERS` não inclui ManyChat. Com resposta em voz ligada, a IA registra o fallback e manda texto.

**Campanhas** (`template-schedule-runner`) ficam **fora** de `CAMPAIGN_PROVIDER_SLUGS`. Envio em massa cai fora da janela de 24h e o ManyChat recusa com o código `3011`. **Nurture** pode usar ManyChat. Fora da janela, o passo falha com a mensagem amigável de 24h e segue a política de retry do runner.

## Autenticação e segredos

- `api_key` e `webhook_secret` ficam **só** em `integration_secrets`. Nenhum dos dois vai para `config`, frontend, log ou telemetria.
- O `webhook_secret` é gerado no servidor (`integration-connect`, com 64 hex de `crypto.randomUUID`). Ele volta **uma única vez** na resposta do `connect`. Reconectar preserva o segredo existente. A ação `rotate_webhook_secret` gera um novo, que também é mostrado uma vez.
- O `webhook_token` do canal é gerado no connect, mesmo padrão de Evolution e Zappaz.
- Telemetria do webhook: `webhook_secret` e `x-webhook-secret` são redigidos para qualquer provider. Só no ManyChat, também `phone`, `whatsapp_phone`, `email`, `custom_fields`, `profile_pic`, `live_chat_url`, `text`, `last_input_text` e os campos de nome. (`phone` segue visível para Z-API, onde é a chave de recuperação do inbound perdido.)

## Rate limits e erros

Limites do Swagger: `sendContent` 25 req/s, `getInfo` 100 req/s.

| HTTP / código | Mensagem para o operador | Retry |
|---|---|---|
| 401 / 403 | API Key inválida ou revogada | não |
| 404 | Contato não encontrado no ManyChat | não |
| 400 `3011` / `3031` | Fora da janela de 24h | não |
| 400 `304X` | Canal não entrega para este contato | não |
| 400 / 422 (outros) | ManyChat recusou a mensagem | não |
| 429 | Limite de requisições (lê `Retry-After`) | `retryable: true` |
| 5xx | ManyChat indisponível | `retryable: true` |
| timeout / rede | propaga como exceção | política atual de cada caller |

Não existe loop de retry dentro do client. `messaging-send` retenta só falha de rede, como sempre fez. Os workers usam o próprio backoff. O corpo cru do erro vai só para `console.error`, com a chave redigida e truncado em 500 caracteres.

## Setup no AceleraFlow

1. **Configurações → Integrações e Plugins → ManyChat — WhatsApp** (ou Instagram, ou Messenger) → **Conectar**.
2. Cole a **API Key** e clique em **Testar e conectar**. O AceleraFlow valida a chave com `GET /fb/page/getInfo`.
3. A tela passa a mostrar a **URL do webhook**, o **segredo** do header `x-webhook-secret` (copie na hora: ele não aparece de novo) e o **JSON** do External Request.
4. A lista de verificação acompanha a configuração. "Primeiro evento recebido" só fica verde depois de um request válido chegar (`webhook_health = ok`).

## Setup no ManyChat (runbook para operador)

1. No ManyChat, abra **Settings → API** e clique em **Generate API Key**. Copie a chave.
2. Cole a chave no AceleraFlow (passo acima) e copie **URL**, **segredo** e **JSON**.
3. No ManyChat, abra a **Automation** do canal certo (WhatsApp, Instagram ou Messenger) que roda a **cada mensagem recebida** do contato (confira o nome atual do gatilho no help center). Se a ação ficar numa automação que não roda a cada mensagem, `last_input_text` pode ser antigo e virar mensagem repetida no CRM.
4. Adicione uma **Action → Make External Request**.
5. Tipo **POST**. Cole a **URL**; o ManyChat só aceita HTTPS.
6. Em **Headers**, adicione `x-webhook-secret` com o segredo.
7. Em **Body**, cole o JSON e troque `<<Full Contact Data>>` pela variável **Full Contact Data**, usando o seletor de variáveis.
8. Na aba **Response**, escolha um contato e clique em **Test Request**. O esperado é **HTTP 200**.
   **Atenção:** o Test Request cria uma mensagem real no Inbox e, com a IA ligada, dispara uma resposta real para o contato escolhido. Teste com o seu próprio contato ou com a IA desligada.
9. Publique a automação.

## Como testar

Testes automatizados, rodados com mocks HTTP e sem rede:

```bash
deno test --allow-env --allow-read --allow-import \
  supabase/functions/tests/manychat.test.ts \
  supabase/functions/tests/manychat-webhook.test.ts \
  supabase/functions/tests/manychat-outbound.test.ts
pnpm exec vitest run src/components/integrations/ManyChatSetupPanel.test.tsx
```

Teste manual contra o banco, depois de conectar:

```bash
curl -i -X POST "<URL do webhook>" \
  -H "content-type: application/json" -H "x-webhook-secret: <segredo>" \
  -d '{"subscriber_id":"<id real>","channel":"whatsapp","text":"teste","occurred_at":"2026-09-29T12:00:00Z"}'
```

Espere `200`. A conversa aparece no Inbox e, com a IA ligada, a resposta sai pelo ManyChat.

## Troubleshooting

| Sintoma | Causa provável |
|---|---|
| Test Request devolve 401 | URL (token) errada ou header `x-webhook-secret` ausente ou errado. Gere novo segredo. |
| 422 `missing_subscriber_id` | Corpo sem `subscriber_id` e sem Full Contact Data. |
| 422 `missing_idempotency_key` | Sem `event_id` e sem `occurred_at`/`last_interaction`. Use a Full Contact Data. |
| 422 `channel_mismatch` | URL de uma superfície colada na automação de outra. |
| 422 subscriber_id "perdeu precisão" | A variável do ID foi posta sem aspas; ponha entre aspas. |
| Resposta falha com "mais de 24h" | Janela de 24h da Meta; espere o contato escrever. |
| Resposta falha com "sem ID do ManyChat" | O contato nunca escreveu por essa superfície. |
| Checklist "Primeiro evento" pendente | Nenhum request válido chegou ainda. |

## Limitações conhecidas

- **PENDENTE: requer credencial real ManyChat.** Nada foi executado contra a API real. Ficam por confirmar: (a) `getInfo` responder `success` em conta só de Instagram ou só de WhatsApp; (b) a forma exata dos códigos `304X`; (c) o comportamento de `content.type = "whatsapp"` numa conta real; (d) `contact.key` presente para contatos de IG e WA (sem ele, um `id` de 17 dígitos cai em "subscriber_id ausente" — correção: pôr `subscriber_id` entre aspas no corpo); (e) a afirmação de que o ManyChat não reentrega External Request, que está no código e nesta doc sem confirmação.
- Sem mídia (inbound ou outbound) e sem templates nesta versão.
- Sem recibo de entrega ou leitura: o ManyChat não expõe webhook de status.
- Campanhas em massa não usam ManyChat (janela de 24h).
- O External Request precisa ser adicionado em cada automação que deve alimentar o CRM. O ManyChat não tem webhook global de mensagem recebida.
