# Testes E2E

Suite de testes end-to-end com [Playwright](https://playwright.dev/) cobrindo os
fluxos críticos do AceleraFlow:

- **auth.spec.ts** — login, logout, credenciais inválidas e redirecionamento
  para rotas protegidas.
- **onboarding.spec.ts** — wizard de onboarding (steps 1→N) para um tenant
  recém-criado.
- **workspace-switch.spec.ts** — alternância entre workspaces via topbar e
  verificação de que os dados exibidos mudam de escopo (RLS por tenant no
  cliente).

## Setup

```bash
pnpm add -D @playwright/test          # já instalado
pnpm exec playwright install chromium  # baixa o navegador uma vez
cp e2e/.env.e2e.example .env.e2e       # e preencha as credenciais
```

## Executar

```bash
# assume a app rodando em http://localhost:8080
pnpm test:e2e

# ou faça o Playwright subir o servidor automaticamente
E2E_START_SERVER=1 pnpm test:e2e
```

## Contas de teste esperadas

| Variável                | Papel                                                             |
| ----------------------- | ----------------------------------------------------------------- |
| `E2E_USER_EMAIL/PASSWORD` | Admin no **workspace A**, com dados semeados                    |
| `E2E_USER2_EMAIL/PASSWORD` | Usuário membro de **dois workspaces** (A e B)                  |
| `E2E_NEW_USER_EMAIL/PASSWORD` | Conta descartável usada pelo teste de onboarding             |

O suite ignora graciosamente os specs que dependem de variáveis não
configuradas (`test.skip`), então você pode rodar apenas o subconjunto que fizer
sentido para o ambiente.

## Estado em 2026-08-10 (fim do dia) — contas provisionadas

`E2E_USER_*` e `E2E_USER2_*` existem e estão configuradas como secret do repositório.
São contas dedicadas, em tenants próprios — nenhuma toca dado de cliente:

| Conta | Tenant | Papel |
| --- | --- | --- |
| `e2e.admin@aceleraflow.test` | `e2e.admin` | `admin` |
| `e2e.membro@aceleraflow.test` | `e2e.admin` | `agent` |
| `e2e.membro@aceleraflow.test` | `e2e.membro` | `admin` |

A assimetria da segunda conta (atendente num workspace, admin no outro) é o que o
teste de permissão por aba exercita. Medido local: `5 passed, 1 skipped` em
`auth.spec.ts` + `workspace-switch.spec.ts`.

`E2E_NEW_USER_*` continua **fora**, e por um motivo estrutural, não por falta de conta:
`onboarding.spec.ts` faz `signIn` numa conta que ainda não concluiu o onboarding e
**completa o wizard** — ou seja, consome o estado. Como o Lovable dá **um único banco**
por projeto (não há staging), o spec roda uma vez e depois se auto-pula para sempre.
Só faz sentido ligar junto com um passo de reset (`update tenants set onboarded_at = null`),
que exigiria `service_role` no CI. Não vale o segredo a mais pelo que entrega.

## Como estava antes — o diagnóstico errado que isto substitui

Medido, não suposto. O bloqueio de cobertura destes specs **não é falta de secret
no GitHub**: é que as contas de teste não existem no Auth de produção.

- `select email from auth.users` em produção devolve **4 linhas**, nenhuma de QA.
- Login com o que está em `.env.e2e` (`qa.aceleraflow@teste.com`):
  `POST /auth/v1/token?grant_type=password` → **HTTP 400 `invalid_credentials`**.
- `gh secret list` no repositório: **vazio**, nenhum secret configurado.

Ou seja: subir `.env.e2e` como secret hoje deixaria o CI **vermelho**, não coberto.
`E2E_BASE_URL` aponta para `localhost:8080`, mas o app sobe contra o Supabase de
**produção** (URL e publishable key são fixas em
`src/integrations/supabase/client.ts`), então a conta precisa existir lá.

### Ordem para desbloquear

| Passo | Desbloqueia |
| --- | --- |
| 1. Provisionar `E2E_USER_*` (admin no workspace A, com dados semeados) | `auth.spec.ts` (3º teste), `app-routes-smoke.spec.ts`, `pipeline-automation.spec.ts` |
| 2. Provisionar `E2E_USER2_*` (membro de dois workspaces) | `workspace-switch.spec.ts` — é o que fecha o `06 · H3` do code review |
| 3. Definir `E2E_NEW_USER_*` (conta descartável, **não pode existir antes**: o spec faz o signup) | `onboarding.spec.ts` |
| 4. `gh secret set` para os 6 valores e estender o job `e2e` do `ci.yml` | tira o `test.skip` silencioso |

Criar essas contas é escrita no Auth de **produção** (o onboarding cria tenant
junto), então é decisão de quem opera o ambiente — não é passo de CI.

## RLS entre workspaces

A validação de **row-level security** cross-workspace vive em
`supabase/tests/database/e2e_workspace_rls_isolation.sql` (pgTAP). Executar com:

```bash
pnpm test:db
```

Ele cria dois tenants + membros e afirma que consultas assumindo o `auth.uid`
de um usuário nunca retornam linhas do outro tenant, mesmo quando o mesmo
usuário pertence aos dois.
