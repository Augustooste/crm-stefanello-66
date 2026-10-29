# PROJECT_CONTEXT.md — aceleraflow

CRM multi-tenant com IA (clone genérico do medflow-v0, ver `clientes/pedro/medflow-v0` só leitura). Stack: Vite + TanStack Start/Router + Supabase (Lovable Cloud) + Deno edge functions.

## Gap-closing vs medflow (iniciado 2026-07-19)

Fonte: `docs/RELATORIO-gaps-vs-medflow-2026-07-19.md` — 794 features mapeadas, 349 TEM / 189 PARCIAL / 256 NAO_TEM, 13 áreas. Metodologia código-a-código (não QA manual), cada gap com referência de arquivo/linha.

**5 maiores blocos de gap** (relatório, não repetir aqui — ler o relatório para detalhe):
1. MCP server: 4 tools vs 66 do medflow
2. lib/ai: sem agente function-calling (39 tools), só edge functions pontuais
3. CI/CD: `.github/` inexistente, zero automação
4. Public API v1 (api_keys) e Meta Ads (dashboards/campanhas): inexistentes
5. Schema: ~67 tabelas do medflow sem equivalente (billing, meta-ads BI, deal_notes/files, governança)

**Cortes de escopo já decididos no código/PRD (não são gap cego, não implementar sem pedido explícito)**:
- Billing/Stripe — PRD declara "modelo de negócio, não feature de produto" (isolamento por projeto Lovable/cliente já resolve).
- Instalador self-host (`/install/*`) — arquitetural, Lovable Cloud gerenciado não se auto-instala.
- Multi-filial/unidades — fora do MVP CRM-IA multi-nicho.
- Meta Ads dashboards — slug em `HIDDEN_CATALOG_SLUGS`, "ocultos por ora (decisão de produto)". Não desocultar sem confirmação.
- Telegram/Sentry/PostHog — anti-padrão documentado explicitamente (`failure-log.ts:8`).
- Cortesia médica / no-show tolerance — nicho-específico, fora do escopo genérico.

### Waves de implementação

**Wave 1 — concluída (2026-07-19)**: prefetch fix (`router.tsx` defaultPreload), `/perfil`, `/ajuda`, PWA instalável (manifest+SW+banner, hand-rolled sem lib nova). Commits: `ec64034`, `f7467b6`, `738b4e1`.

**Wave 2 — concluída (2026-07-19)**: notificações in-app no header (popover agregando decisões HITL/handoff/falhas de IA — sem tabela nova), modal de consentimento LGPD, banner de manutenção, debug button dev-only, erro de callback de auth (link expirado/OAuth negado, tratado inline em `auth.tsx`), reabrir/excluir conversa no inbox (RLS confirmada permitir DELETE tenant-wide). Commits: `d5e7928`, `89ceb30`, `f96f319`.
**Review Codex do #112 aplicada** (commit `4671ba3`): consentimento LGPD amarrado a usuário+`POLICY_VERSION` (era boolean global); senha mín. 8 sem trivial; nome com trim/max; banner de manutenção com chave por conteúdo da mensagem; delete de conversa exige linha afetada (0 linhas → toast de erro, não falso sucesso).

**Excluir conversa → soft-delete RESOLVIDO** (commit `8d30e10`, decisão do Felipe 2026-07-19): não é mais hard-delete+cascade. Marca `conversations.deleted_at` (coluna aplicada em prod via MCP Lovable + migration versionada `20260719180000`). Qualquer membro do tenant pode excluir (SEM gate de admin — RLS `conversations tenant all` já cobre o UPDATE). Filtro `.is("deleted_at", null)` em todas as leituras de listagem (inbox, busca, export, atenção humana, ficha do contato, dashboard). Conversa excluída RESSUSCITA (deleted_at→null) quando o contato manda mensagem nova (messaging-webhook, gated para não escrever no caminho quente). Verificado: tsc/eslint/vitest (149 arq/1875 testes)/build verdes + deno test do webhook (89 steps).

Pendência aberta desta wave:
- Badge de decisões HITL no bell de notificações não tem gate de admin (diferente de `useHumanAttentionCount`/falhas de IA, que são gated) — atendente vê contagem de `/decisions` também. Avaliar se deveria ser admin-only.

**CI/CD — construído (2026-07-19, execução segura/reversível, sem gate)**: `.github/workflows/ci.yml` (typecheck/lint/test/build/edge-functions). Commit `c88bf7e`. **Resolvido (2026-07-20)**: `pnpm-lock.yaml` está sincronizado com `package.json` na main (zod 4.4.3 em ambos) e o CI já usa `pnpm install --frozen-lockfile` — CI de main está VERDE. (Os branches `agent/*` do swarm da plataforma ainda tinham o lock stale zod ^3.24.2, causa do CI vermelho lá; tratado na integração da plataforma, não na main.)

**Wave 3 — specs prontas, aguardando aprovação explícita antes de construir** (`docs/wave3/`, commit `84f800a`):
- MCP server (`docs/wave3/mcp-expansion-spec.md`): 4→~30 tools em 3 batches priorizados por risco/custo. Achado novo: rate-limit hoje NÃO cobre o MCP (RPC existente é service-role only, MCP roda sob JWT do usuário) — pré-requisito de schema antes de qualquer tool de escrita.
- Agente IA function-calling (`docs/wave3/ai-agent-spec.md`): arquitetura para tool-calling real na conversa, compondo com o gate HITL por confidence já existente.
- Public API v1 + api_keys (`docs/wave3/public-api-spec.md`): schema proposto (`api_keys`), auth Bearer→hash→RLS, primeiro batch de endpoints read-only.
- Deal notes/files/quick scripts (`docs/wave3/deal-schema-spec.md`): schema proposto espelhando `contact_notes`, bucket de storage novo.

Nenhum destes foi implementado. Não iniciar build sem sign-off explícito (schema/arquitetura — regra global do usuário).

## Preparar reunião (Demo 2 palestra B2B, 2026-09-23)

Projeto Lovable `fcbd7528` (remix). GitHub `felipetruman/aceleraflow-remix` reconectado em 23/09/2026.

- **O quê:** card do Funil → ⓘ "Resumo do negócio" ou ⋮ → "Preparar reunião" → Sheet `src/components/pipeline/meeting-prep-sheet.tsx` → Edge Function `supabase/functions/prepare-meeting` (só `dealId`).
- **Regra:** fatos (empresa, contato, `contacts.job_title`, valor, `board_stages.name`, reunião em America/Sao_Paulo, objetivo, próximo passo) são montados sem IA em `supabase/functions/_shared/meeting-prep.ts`. A IA só devolve resumo/hipóteses/perguntas/pontos de atenção, e `sanitizeGenerated` descarta item com UUID, cargo divergente ou ERP/SAP/TOTVS/legado ausente das fontes.
- **Autorização:** `loadProfileOrFail` + leituras com o JWT do usuário e `tenant_id` explícito. `board_stages` **não tem** `tenant_id`: filtrar por `board_id` do negócio (erro real em prod, commit `569cff0`).
- **UI:** a query do Sheet usa `throwOnError: false`; o `QueryClient` global (`router.tsx`) usa `true` e derrubaria a rota.
- **Deploy:** push na `main` sincroniza o código, mas **não publica Edge Function** — precisa de `send_message` no Lovable (0,4–0,5 crédito cada).
- **Testes:** `supabase/functions/tests/prepare-meeting.test.ts` (14) e `src/components/pipeline/meeting-prep-sheet.test.tsx` (4).
- Validação E2E e roteiro: `clientes/acelera-ia/acelerador-rag/docs/palestra-b2b/demo-2-aceleraflow-validacao-2026-09-23.md` §14.

## ManyChat (2026-09-29, branch `feat/manychat-integration`)
- Slugs por superfície (`manychat-whatsapp|instagram|messenger`), client único `_shared/messaging/manychat-client.ts`. Decisão, contrato inbound, idempotência e runbook: `docs/integrations/MANYCHAT.md` (versionado; resto de `docs/` segue gitignored).
- Destino de envio por identidade (subscriber_id) centralizado em `resolveProviderDestination` (`_shared/messaging/contact-identity.ts`) — manual, IA e nurture. Campanhas não usam ManyChat (janela de 24h).
- **Pendente**: migration `20260929120000_manychat_integration.sql` só aplica após merge/deploy (sync do Lovable não aplica migration — ver memória do repo); teste contra API real exige API Key ManyChat.

## Convenções
- Rotas: TanStack file-based (`src/routes/_app.<nome>.tsx`), guard via `beforeLoad`, layout pai injeta grid `grid-cols-12` (rotas filhas usam `col-span-12` ou frações).
- RLS: `profiles update self` já permite usuário editar a própria linha (sem policy nova para /perfil).
- Testes co-locados (`*.test.tsx`), vitest.
- Sidebar: item fora de uso **sai do array**, não fica desabilitado — o mecanismo `emBreve` (botão inerte + badge "Em breve") foi removido na PR #241 junto com "Mensagens" (`/templates`) e "Formulários" (`/formularios`), seus dois únicos usuários. As rotas seguem no ar por URL; só `/agentes` tem redirect, via `AGENTES_IA_HABILITADO`. Grupo sem item não renderiza header (`AppSidebar.tsx:144`).
- Gates locais: `pnpm exec eslint .` e `pnpm exec vitest run` — **nunca com `| tail`**, o pipe devolve o exit code do `tail` e mascara falha de resolução do binário.

## Runbook — correções de produção

> Segredos NÃO vão para o git. Valores de `integration_secrets`/`.env.local` ficam só no runtime (Supabase) e no dashboard do provedor.

### 2026-07-24 — Inbound WhatsApp Meta Cloud não recebia mensagens
- **Sintoma**: mensagens enviadas ao número oficial não apareciam no inbox; zero linhas em `messaging_webhook_events`.
- **Causa raiz**: o `app_secret` gravado em `integration_secrets` (tenant `78d9dee6-befb-4964-958b-b5eabfacae22`, slug `meta-cloud`, key `app_secret`) **não era o App Secret real** do app Meta `1563454832040977`. A edge fn `messaging-webhook` (branch `meta-cloud`) valida `x-hub-signature-256` contra esse valor; a Meta assina com o secret verdadeiro → mismatch → **401 antes de persistir** (falha silenciosa, a Meta fica retentando).
- **Fix**: valor corrigido para o App Secret real (Meta App Dashboard → Configurações → Básico). Aplicado em `integration_secrets` (runtime, via MCP Lovable `query_database`) e no `.env.local` (não versionado). **O secret não entra no repositório.**
- **Validar app_secret sem mandar mensagem**: `appsecret_proof = HMAC-SHA256(key=app_secret, message=access_token)` em `GET /me?access_token=<T>&appsecret_proof=<proof>` deve dar `200`; `GET /{app_id}/subscriptions?access_token=<app_id>|<app_secret>` só responde com o secret certo (mostra `callback_url` + `fields`).
- **Validar end-to-end**: mandar mensagem real via WhatsApp para o número e conferir `messaging_webhook_events` + `messages`. Confirmado em 24/07 (inbound → `ai-respond` → resposta enviada de volta, round-trip ~10s).
- **Armadilhas de teste**: (1) POST sintético assinado com o próprio secret gravado dá `200` = FALSO POSITIVO (valida o secret contra ele mesmo). (2) O GET de verificação/handshake é independente do `app_secret` (só compara `token` da URL vs `hub.verify_token`) — passar nele **não** prova que o inbound funciona.
- **Upstream confirmado OK (Graph API)**: `callback_url` do app = `.../messaging-webhook/meta-cloud?token=<token>` (`active`, campo `messages` inscrito); número `1330421993481338` (`+55 21 97628-1814`) `CLOUD_API`/`CONNECTED`; WABA `965810509832695` com o app inscrito.
