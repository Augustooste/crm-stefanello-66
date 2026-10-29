# provedor de agentes — Matriz de contrato (fonte de verdade da integração)

| Item | Valor |
| --- | --- |
| Contrato versionado | `docs/vendor/agent-platform/openapi.json` |
| Origem | `documentação pública do provedor (URL removida junto com o nome do vendor)` |
| Baixado em | 2026-07-31T16:21Z |
| sha256 | `25e745ae2bc08311ae38d98590109edad1c942dbb7e3764fef625ec5071a9bf7` |
| `info.version` | `1.0.0` (OpenAPI 3.0.1) |
| Paths | 57 (88 operações) |
| `servers[0].url` | `https://api.provedor-de-agentes.invalid` |
| Auth | `bearerAuth` — `Authorization: Bearer <token>`, global (`security: [{bearerAuth: []}]`) |

Precedência aplicada em todo o código: **openapi.json > página do endpoint na API Reference >
documentação funcional das 7 áreas > exemplos visuais**. Nada fora do contrato é inventado; onde a
API pública não expõe, o produto mostra a limitação (§ "Sem contrato público").

## 0. Regra da base URL (armadilha nº 1)

`servers[0].url = https://api.provedor-de-agentes.invalid` e **todo path do contrato já começa com `/v2`**.
Concatenar `AGENT_PLATFORM_API_BASE_URL=https://api.provedor-de-agentes.invalid/v2` com o path do contrato produz
`/v2/v2/...` (404 em tudo). O cliente normaliza a base: remove barra final e sufixo `/v2`
redundante antes de concatenar o path do contrato. Coberto por teste unitário.

## 1. Matriz das sete áreas → endpoints reais

Legenda de status: **API** = coberto pelo contrato · **PARCIAL** = coberto com limitação do próprio
contrato · **SEM API** = não existe endpoint público.

### 1.1 Criar agente

| Operação | Endpoint (verbatim) | Status |
| --- | --- | --- |
| Listar workspaces | `GET /v2/workspaces` | API |
| Listar agentes | `GET /v2/workspace/{workspaceId}/agents` (`page`, `pageSize`, `query`) | API |
| Criar agente | `POST /v2/workspace/{workspaceId}/agents` | API |
| Buscar agente | `GET /v2/agent/{agentId}` | API |
| Atualizar agente | `PUT /v2/agent/{agentId}` | API |
| Excluir agente | `DELETE /v2/agent/{agentId}` | API |
| Ativar | `PUT /v2/agent/{agentId}/active` | API |
| Inativar | `PUT /v2/agent/{agentId}/inactive` | API |
| Créditos do workspace | `GET /v2/workspace/{workspaceId}/credits` | API |
| Créditos gastos pelo agente | `GET /v2/agent/{agentId}/credits-spent` (`year`, `month`, `day`) | API |

Payload de criação/atualização (nomes remotos preservados, nenhum obrigatório no contrato):
`name`, `avatar`, `behavior`, `communicationType`, `type`, `jobName`, `jobSite`, `jobDescription`.

Resposta de agente (idêntica em list/create/get/update): `id`, `name`, `behavior`, `avatar`,
`communicationType`, `type`, `jobName`, `jobSite`, `jobDescription`.

**Não existe campo de status ativo/inativo em nenhuma resposta de agente.** Ativar/inativar
retornam apenas `{success:boolean}`. Ver divergência D6.

### 1.2 Modelos de LLM e configurações

| Operação | Endpoint | Status |
| --- | --- | --- |
| Ler configurações | `GET /v2/agent/{agentId}/settings` | API |
| Atualizar configurações | `PUT /v2/agent/{agentId}/settings` | API |

Campos (grafia remota preservada — inclusive `prefferModel` e `onLackKnowLedge`):

| Campo | GET | PUT | Tipo |
| --- | --- | --- | --- |
| `prefferModel` | sim | sim | enum de 26 modelos (abaixo) |
| `timezone` | sim | sim | string |
| `enabledHumanTransfer` | sim | sim | boolean |
| `enabledReminder` | sim | sim | boolean |
| `splitMessages` | sim | sim | boolean |
| `enabledEmoji` | sim | sim | boolean |
| `limitSubjects` | sim | sim | boolean |
| `messageGroupingTime` | sim | sim | enum `NO_GROUP\|FIVE_SEC\|TEN_SEC\|THIRD_SEC\|ONE_MINUTE` |
| `signMessages` | **não** | sim | boolean — ver D3 |
| `maxDailyMessages` | sim (`integer nullable`) | sim (`integer`) | ver D4 |
| `maxDailyMessagesLimitAction` | sim | sim | enum `TEMP_BLOCK_30S\|TEMP_BLOCK_5M\|TEMP_BLOCK_10M\|TEMP_BLOCK_30M\|TEMP_BLOCK_1H\|BLOCK\|TRANSFER` |
| `knowledgeByFunction` | sim | sim | boolean |
| `onLackKnowLedge` | sim | sim | string |

`prefferModel` (ordem do contrato, sem lista manual paralela — gerada do schema):
`GPT_5`, `GPT_5_MINI`, `GPT_5_1`, `GPT_5_2`, `GPT_5_MINI_V2`, `GPT_4_TURBO`, `OPEN_AI_04`,
`OPEN_AI_03_MINI_BETA`, `GPT_4_1`, `GPT_4_1_MINI`, `GPT_4_O_MINI`, `GPT_4_O`, `OPEN_AI_O3_MINI`,
`OPEN_AI_O4_MINI`, `OPEN_AI_O3`, `OPEN_AI_O1`, `GPT_4`, `CLAUDE_4_5_SONNET`, `CLAUDE_3_5_SONNET`,
`CLAUDE_3_7_SONNET`, `CLAUDE_3_5_HAIKU`, `DEEPINFRA_LLAMA3_3`, `QWEN_2_5_MAX`, `DEEPSEEK_CHAT`,
`SABIA_3`, `SABIA_3_1`.

`THIRD_SEC` é grafia do contrato (provável "thirty seconds") e **não é corrigida**.

### 1.3 Perfil e comportamento

| Operação | Endpoint | Status |
| --- | --- | --- |
| Ler perfil | `GET /v2/agent/{agentId}` | API |
| Salvar perfil | `PUT /v2/agent/{agentId}` | API |
| Histórico de comportamento | `GET /v2/agent/{id}/list-behavior-history` — `page` **e** `pageSize` obrigatórios | API (ver D5) |

Enums: `communicationType` = `FORMAL\|NORMAL\|RELAXED`; `type` = `SUPPORT\|SALE\|PERSONAL`.
Histórico retorna `id`, `behaviorText`, `createdAt`, `userId`, `userName`, `userLogin`,
`userPicture` (todos REQ). **Não há endpoint de restauração** — a UI copia a versão antiga para o
editor e salva via `PUT /v2/agent/{agentId}`.

### 1.4 Treinamentos

| Operação | Endpoint | Status |
| --- | --- | --- |
| Listar | `GET /v2/agent/{agentId}/trainings` — `type` **obrigatório**, `page`, `pageSize`, `query` | PARCIAL (D2) |
| Criar | `POST /v2/agent/{agentId}/trainings` (`oneOf` de 4 variantes) | API |
| Atualizar | `PUT /v2/training/{trainingId}` — só `type: TEXT` | PARCIAL (D1) |
| Excluir | `DELETE /v2/training/{trainingId}` | API |

Variantes do `oneOf` (campos exatos):

- `TEXT`: `type`, `text`, `image`, `callbackUrl`
- `WEBSITE`: `type`, `website`, `trainingSubPages` (`DISABLED\|ACTIVE`), `trainingInterval`
  (`THIRTY_SECONDS\|NEVER\|ONE_HOUR\|FOUR_HOUR\|EIGHT_HOUR\|TWELVE_HOUR\|ONE_DAY\|ONE_WEEK\|ONE_MONTH`), `callbackUrl`
- `VIDEO`: `type`, `video` (URL), `callbackUrl`
- `DOCUMENT`: `type`, `documentUrl`, `documentName`, `documentMimetype`, `callbackUrl`

**Documento é enviado por URL em JSON** — não há `multipart/form-data` em nenhuma operação do
contrato, nem limite de tamanho ou lista de formatos declarados. Nenhuma conversão local de PDF.
Listagem devolve, por tipo: `TEXT` → `id,type,text,image`; `WEBSITE` → `id,type,website,trainingSubPages,trainingInterval`;
`VIDEO` → `id,type,video`; `DOCUMENT` → `id,type,documentUrl,documentName,documentMimetype`.

`callbackUrl` é aceito nas 4 variantes de criação (não em `PUT /v2/training/{trainingId}`). O
contrato não documenta payload nem assinatura do callback → o segredo é do AceleraFlow
(`AGENT_PLATFORM_TRAINING_CALLBACK_SECRET` em query/header próprio), com tratamento idempotente.

### 1.5 Intenções

| Operação | Endpoint | Status |
| --- | --- | --- |
| Listar | `GET /v2/agent/{agentId}/intentions` (`page`, `pageSize`, `query`) | API |
| Criar | `POST /v2/agent/{agentId}/intentions` | API |
| Atualizar | `PUT /v2/intention/{intentionId}` | API |
| Excluir | `DELETE /v2/intention/{intentionId}` | API |

Corpo de criação — obrigatórios pelo contrato: `description`, `type`, `httpMethod`, `url`,
`autoGenerateParams`, `autoGenerateBody`. Opcionais: `details`, `instructions`, `fields[]`,
`headers[]`, `params[]`, `variables[]`, `requestBody` (string JSON).
`fields[]` = `name`, `jsonName`, `description`, `type` (`STRING\|URL\|DATE_TIME\|DATE\|NUMBER\|BOOLEAN`), `required` — todos REQ.
`headers[]`/`params[]` = `name` + `value` (REQ).
`variables[]` = `valueExpression` (REQ), `defaultFieldKey`, `customField{id,name,description,type,jsonName}`.
`type` = `WEBHOOK\|INSTRUCTIONS` no POST; **na listagem o enum só tem `WEBHOOK`** (D7).
Não há campo de estado ativo/inativo para intenção no contrato → a UI não inventa toggle.
O AceleraFlow **não executa** a URL da intenção: quem executa é o provedor de agentes.

### 1.6 Integrações

| Item | Endpoint | Status |
| --- | --- | --- |
| ElevenLabs | — | **SEM API** |
| Google Agenda | — | **SEM API** |
| Plug Chat | — | **SEM API** |
| E-Vendi | — | **SEM API** |
| MCP — criar conexão | `POST /v2/agent/{agentId}/mcp/add` | API (D8) |
| MCP — concluir OAuth | `POST /v2/mcp/connect` (`code`, `state` REQ) | API |
| MCP — listar ferramentas | `GET /v2/mcp/{mcpId}/tools` | API |
| MCP — sincronizar | `GET /v2/mcp/{mcpId}/sync-tools` | API (**GET que muda estado**) |
| MCP — ativar ferramenta | `GET /v2/mcp/{mcpId}/tool/{toolId}/active` | API (**GET que muda estado**) |
| MCP — inativar ferramenta | `GET /v2/mcp/{mcpId}/tool/{toolId}/inactive` | API (**GET que muda estado**) |
| MCP — excluir conexão | `DELETE /v2/mcp/{mcpId}` | API |

Evidência de que as 4 integrações nativas não existem na API pública: busca no `openapi.json`
por `eleven`/`agenda` retorna apenas `elEvent` (de `onCancelEvent`), `agendamento` e `agendar`
(descrições de webhook). Nenhum path, schema ou enum de integração nativa.
Consequência (regra obrigatória do escopo): nenhum endpoint inventado, nenhum formulário que não
salva, nenhum scraping do painel. A UI mostra o aviso de indisponibilidade.

`POST /v2/agent/{agentId}/mcp/add` corpo: `name`, `description`, `mcpUrl`, `urlType`
(`SSE\|STREAMABLEHTTP`), `authType` (`NO_OAUTH\|OAUTH\|HEADERS`) — todos REQ — e `headers` (objeto).
Resposta: `connected`, `success`, `id`, `url` (URL de autorização OAuth).

### 1.7 Canais

| Operação | Endpoint | Status |
| --- | --- | --- |
| Listar canais do workspace | `GET /v2/workspace/{workspaceId}/channels` (`page`=1, `pageSize`=25, `query`, `agentId`) | API |
| Criar canal solto | `POST /v2/workspace/{workspaceId}/create-channel` (`name` REQ, `type`) | API |
| Criar canal já vinculado | `POST /v2/assistant/{assistantId}/create-channel/{type}` (`name` REQ, `assistantId` nullable) | API |
| Renomear / vincular / trocar / desvincular agente | `PUT /v2/channel/{channelId}` (`name` REQ, `agentId` nullable) | API |
| Excluir | `DELETE /v2/channel/{channelId}` | API |
| Ler configuração | `GET /v2/channel/{channelId}/config` (`oneOf` por tipo) | API |
| Gravar configuração | `PUT /v2/channel/{id}/config` | PARCIAL (D9) |
| QR Code | `GET /v2/channel/{channelId}/qr-code` → `oneOf`: `{value}` ou `{connected}` | API |
| Widget — settings | `PUT /v2/channel/{channelId}/widget-settings` | API |
| Widget — links | `GET /v2/channel/{channelId}/widget-links` → `{float, iframe}` | API |
| Iniciar conversa pelo canal | `POST /v2/channel/{channelId}/start-conversation` | API |

Enum de tipo (workspace, 9 valores — usado na UI):
`Z_API`, `WHATSAPP`, `INSTAGRAM`, `CLOUD_API`, `TELEGRAM`, `WIDGET`, `MESSENGER`, `MERCADO_LIVRE`, `TWILIO_SMS`.

Listagem devolve `{data[], count}` com `id`, `name`, `type`, `agentId`, `agentName`,
`agentPicture`, `facebookPageId`, `connected`, `username`. **`connected` é o único indicador de
conexão do contrato** — nenhum status é inventado.

`GET /v2/channel/{channelId}/config` tem 4 variantes (`Z_API`, `WHATSAPP`, `INSTAGRAM` e uma
genérica). Campos comuns: `id`, `tenant`, `audioAction`, `startTrigger`, `endTrigger`.
`Z_API` adiciona `enabledTyping`, `enableGroupsResponse`, `replyGroupsType`,
`enablePrivateChatResponse`, `callRejectAuto`, `callRejectMessage`, `takeOutsideService*`,
`waitingMessageEnabled`, `waitingMessageText`. `WHATSAPP` adiciona `enabledTyping`. `INSTAGRAM`
adiciona `notReactInstagramStories`, `takeOutsideService*`, `commentsReply*`,
`commentsCallDirectInstruction`.

Widget settings: `isPublic`, `initialMessage`, `origins[]`, `suggestMessages[]`,
`headerBackground`, `headerColor`, `messageUserBackground`, `buttonBackground`. O script/iframe
público vem de `widget-links` — **sem Bearer token no embed**.

Endpoints legados baseados em agente (`POST /v2/agent/{agentId}/create-channel`,
`GET /v2/agent/{agentId}/search`) existem no contrato com enum de 7 tipos (sem `Z_API`/`TWILIO_SMS`)
e **não são usados**, conforme regra de preferir o fluxo por workspace.

### 1.8 Playground ("Testar agente")

| Operação | Endpoint |
| --- | --- |
| Conversar | `POST /v2/agent/{agentId}/conversation` (`oneOf` de 5: texto, imagem, áudio, vídeo, documento) |
| Injetar mensagem no histórico | `POST /v2/agent/{agentId}/add-message` (`oneOf` de 5, campo `role`: `user`\|`assistant`) |

`conversation` (variante texto): `contextId` REQ, `prompt` REQ, `callbackUrl`, `onFinishCallback`,
`chatName`, `chatPicture`, `phone`. Resposta: `message`, `images[]`, `audios[]`, `documents[]`
(`add-message` responde sem `documents`).

### 1.9 Webhooks do agente

`GET /v2/agent/{agentId}/webhooks` · `PUT /v2/agent/{agentId}/webhooks` — campos `onNewMessage`,
`onLackKnowLedge`, `onTransfer`, `onFirstInteraction`, `onStartInteraction`, `onFinishInteraction`,
`onCreateEvent`, `onCancelEvent` (strings, nenhum obrigatório).

### 1.10 Avançado (campos customizados, transferência, inatividade)

| Operação | Endpoint | Status |
| --- | --- | --- |
| Listar campos | `GET /v2/custom-field/workspace/{workspaceId}` (`page`, `pageSize`, `query`) | API |
| Criar campo | `POST /v2/custom-field/workspace/{workspaceId}` | API |
| Atualizar campo | `PUT /v2/custom-field/{customfieldId}` | API |
| Arquivar/desarquivar | `PUT /v2/custom-field/toggle-archive/{customfieldId}?archived=` | API |
| Listar regras de transferência | `GET /v2/agent/{id}/transfer-rules` | API |
| Criar regra | `POST /v2/agent/{agentId}/transfer-rules` | API |
| Atualizar regra | `PUT /v2/agent/{agentId}/transfer-rules/{transfer-rule-id}` | API |
| Excluir regra | `DELETE /v2/agent/{agentId}/transfer-rules/{transfer-rule-id}` | API |
| Ler ações de inatividade | `GET /v2/agent/{agentId}/idle-actions` | API |
| Criar/Atualizar | `POST` / `PUT /v2/agent/{agentId}/idle-actions` | API |
| Excluir | `DELETE /v2/agent/{agentId}/idle-actions` | PARCIAL (D10) |

Campo customizado: `type` = `STRING\|DATE\|DATE_TIME\|NUMBER\|BOOLEAN\|MONEY`, `jsonName`,
`description`, `archived`. Regra de transferência: `instructions`, `returnOnFinish`,
`type` (`HUMAN\|AGENT`), `userId`, `agentId`. Inatividade: `actions[]` com `instructions`,
`seconds`, `allowAllHours`, `workingHours[]{dayWeek,active,hours[]}` + `finishOn.seconds`.

### 1.11 No contrato, fora do escopo desta entrega

Chats (`/v2/workspace/{workspaceId}/chats`, `/v2/chat/*`), contatos
(`/v2/workspace/{workspaceId}/search`, `/v2/contact/*`), atendimentos
(`/v2/workspace/{workspaceId}/interactions`, `/v2/interaction/*`, `/v2/workspace/{workspaceId}/export`).
O AceleraFlow já tem Inbox/Contatos próprios; duplicar aqui criaria uma segunda fonte de verdade.

## 2. Divergências registradas

| # | Assunto | Documentação / escopo pedido | Contrato OpenAPI (vence) |
| --- | --- | --- | --- |
| D1 | Atualizar/excluir treinamento | `PUT\|DELETE /agent/{agentId}/trainings/{trainingId}` | `PUT\|DELETE /v2/training/{trainingId}` — sem `agentId`; `PUT` aceita só `TEXT` |
| D2 | Listar treinamentos | filtro de tipo opcional | `type` é **obrigatório**: não existe listagem "todos os tipos" em uma chamada — as abas por tipo são imposição do contrato |
| D3 | `signMessages` | formulário inicia com dados remotos | presente só no `PUT`, ausente no `GET`: não é possível pré-carregar. Enviado apenas quando o usuário altera |
| D4 | `maxDailyMessages` | "respeitar somente os valores permitidos pelo contrato" | não há enum nem min/max no contrato: `GET` = `integer nullable`, `PUT` = `integer` cuja descrição diz que `null` = sem limite. `null` limpa o limite; `maxDailyMessagesLimitAction` só vai junto quando há limite |
| D5 | Histórico de comportamento | `GET /agent/{agentId}/behavior-history` | `GET /v2/agent/{id}/list-behavior-history`, com `page` e `pageSize` **obrigatórios** |
| D6 | Ativo/inativo do agente | "mostre claramente se está ativo ou inativo" | nenhuma resposta de agente expõe status; `active`/`inactive` devolvem só `{success}`. A UI mostra o último estado aplicado pelo AceleraFlow, rotulado como tal — não inventa campo remoto |
| D7 | `type` de intenção | `WEBHOOK` \| `INSTRUCTIONS` | POST aceita os dois; a **listagem** só declara `WEBHOOK`. Valores fora do enum são exibidos, não quebram a tela |
| D8 | `mcp/add` | conexão MCP por agente | path é `/v2/agent/{agentId}/mcp/add` mas o parâmetro documentado é `mcpId` — inconsistência interna do contrato; usado como `agentId` (o path manda) |
| D9 | `PUT /channel/{id}/config` | mesmos campos do `GET` | corpo declarado só com `id`, `tenant`, `audioAction`, `startTrigger`, `endTrigger`, embora a resposta traga as 4 variantes completas. Só os campos declarados no corpo são enviados |
| D10 | Excluir ação de inatividade | CRUD por item | `DELETE /v2/agent/{agentId}/idle-actions` não recebe id de ação: a exclusão é do conjunto |
| D11 | Base URL | `AGENT_PLATFORM_API_BASE_URL=https://api.provedor-de-agentes.invalid/v2` | `servers[0].url` = `https://api.provedor-de-agentes.invalid` e paths já contêm `/v2` (§0) |
| D12 | Retry idempotente | "nunca repetir POST/PUT/DELETE" | 4 operações **mutantes usam GET** (`sync-tools`, `tool/*/active`, `tool/*/inactive`). A allowlist de retry é por operação, nunca por verbo |
| D13 | Path params inconsistentes | — | `{id}` em `transfer-rules`, `list-behavior-history`, `channel/{id}/config` e `interaction/{id}`; `{agentId}`/`{channelId}` nos vizinhos. O cliente segue o template literal de cada path |
| D14 | Erros do contrato | 400/401/403/404/429/500 | o contrato só declara `400`, `403` e `500` (e `204` em algumas escritas). 401/404/429 são tratados pelo cliente por status HTTP real, não por schema |

## 3. Contrato interno (congelado — todo agente de build usa este)

Chamada única de servidor: `POST {SUPABASE_URL}/functions/v1/agent-platform-proxy`, com o JWT do usuário
do AceleraFlow. Nenhuma chamada do navegador para o host do provedor.

```jsonc
// request
{ "action": "agents.list", "params": { "page": 1 }, "body": { } }
// resposta ok
{ "data": <payload remoto, sem renomear campos> }
// resposta erro
{ "error": { "code": "NOT_FOUND", "message": "<PT-BR>", "correlationId": "<uuid>" } }
```

`workspaceId` **nunca** vem do frontend: é resolvido no servidor a partir de
`agent_platform_connections` do tenant do JWT. `agentId`/`channelId` são validados contra
`agent_platform_agent_links` / `agent_platform_channel_links` do tenant.

Actions (nome interno → operação):

| Action | Operação |
| --- | --- |
| `workspaces.list` | `GET /v2/workspaces` |
| `workspace.credits` | `GET /v2/workspace/{workspaceId}/credits` |
| `agents.list` / `agents.create` | `GET` / `POST /v2/workspace/{workspaceId}/agents` |
| `agent.get` / `agent.update` / `agent.delete` | `GET` / `PUT` / `DELETE /v2/agent/{agentId}` |
| `agent.activate` / `agent.deactivate` | `PUT /v2/agent/{agentId}/active` / `/inactive` |
| `agent.settings.get` / `agent.settings.update` | `GET` / `PUT /v2/agent/{agentId}/settings` |
| `agent.webhooks.get` / `agent.webhooks.update` | `GET` / `PUT /v2/agent/{agentId}/webhooks` |
| `agent.behaviorHistory.list` | `GET /v2/agent/{id}/list-behavior-history` |
| `agent.creditsSpent` | `GET /v2/agent/{agentId}/credits-spent` |
| `trainings.list` / `trainings.create` | `GET` / `POST /v2/agent/{agentId}/trainings` |
| `training.update` / `training.delete` | `PUT` / `DELETE /v2/training/{trainingId}` |
| `intentions.list` / `intentions.create` | `GET` / `POST /v2/agent/{agentId}/intentions` |
| `intention.update` / `intention.delete` | `PUT` / `DELETE /v2/intention/{intentionId}` |
| `channels.list` | `GET /v2/workspace/{workspaceId}/channels` |
| `channels.create` | `POST /v2/workspace/{workspaceId}/create-channel` |
| `channels.createForAgent` | `POST /v2/assistant/{assistantId}/create-channel/{type}` |
| `channel.update` / `channel.delete` | `PUT` / `DELETE /v2/channel/{channelId}` |
| `channel.config.get` / `channel.config.update` | `GET /v2/channel/{channelId}/config` / `PUT /v2/channel/{id}/config` |
| `channel.qrCode` | `GET /v2/channel/{channelId}/qr-code` |
| `channel.widgetSettings.update` / `channel.widgetLinks` | `PUT /v2/channel/{channelId}/widget-settings` / `GET .../widget-links` |
| `customFields.list` / `customFields.create` | `GET` / `POST /v2/custom-field/workspace/{workspaceId}` |
| `customField.update` / `customField.toggleArchive` | `PUT /v2/custom-field/{customfieldId}` / `PUT /v2/custom-field/toggle-archive/{customfieldId}` |
| `transferRules.list` / `.create` | `GET /v2/agent/{id}/transfer-rules` / `POST /v2/agent/{agentId}/transfer-rules` |
| `transferRule.update` / `.delete` | `PUT` / `DELETE /v2/agent/{agentId}/transfer-rules/{transfer-rule-id}` |
| `idleActions.get` / `.create` / `.update` / `.delete` | `GET` / `POST` / `PUT` / `DELETE /v2/agent/{agentId}/idle-actions` |
| `mcp.add` / `mcp.connect` / `mcp.delete` | `POST /v2/agent/{agentId}/mcp/add` / `POST /v2/mcp/connect` / `DELETE /v2/mcp/{mcpId}` |
| `mcp.tools.list` / `mcp.tools.sync` | `GET /v2/mcp/{mcpId}/tools` / `GET /v2/mcp/{mcpId}/sync-tools` |
| `mcp.tool.activate` / `mcp.tool.deactivate` | `GET /v2/mcp/{mcpId}/tool/{toolId}/active` / `/inactive` |
| `playground.conversation` / `playground.addMessage` | `POST /v2/agent/{agentId}/conversation` / `/add-message` |

Retry (2 tentativas, backoff) **somente** nestas actions de leitura pura: `workspaces.list`,
`workspace.credits`, `agents.list`, `agent.get`, `agent.settings.get`, `agent.webhooks.get`,
`agent.behaviorHistory.list`, `agent.creditsSpent`, `trainings.list`, `intentions.list`,
`channels.list`, `channel.config.get`, `channel.qrCode`, `channel.widgetLinks`,
`customFields.list`, `transferRules.list`, `idleActions.get`, `mcp.tools.list`.
Nunca em `mcp.tools.sync`, `mcp.tool.activate`, `mcp.tool.deactivate` (GET mutante) nem em
qualquer escrita.

Códigos de erro normalizados: `AUTHENTICATION_FAILED`, `FORBIDDEN`, `NOT_FOUND`,
`VALIDATION_ERROR`, `RATE_LIMITED`, `INSUFFICIENT_CREDITS`, `REMOTE_SERVER_ERROR`, `TIMEOUT`,
`NETWORK_ERROR`, `UNSUPPORTED_BY_PUBLIC_API`, `UNKNOWN`.
