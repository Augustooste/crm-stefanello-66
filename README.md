# CRM IA

CRM com inbox omnichannel e assistente de IA, construído para pequenas e médias empresas. Centraliza conversas de WhatsApp e e-mail, organiza contatos e negócios em pipeline visual e responde clientes automaticamente com IA.

## Funcionalidades

- **Dashboard** — visão geral de métricas e atividades recentes
- **Pipeline** — funil de vendas em kanban com arrastar-e-soltar
- **Inbox** — conversas de WhatsApp (Z-API ou Twilio) e e-mail (Resend) em um só lugar
- **Contatos** — cadastro completo com histórico e detalhes por contato
- **Atividades** — tarefas e follow-ups
- **Assistente IA** — respostas automáticas a mensagens recebidas (Gemini), com playground para testar o comportamento antes de ativar
- **Integrações** — conexão de provedores de mensageria pela própria interface, incluindo ManyChat (WhatsApp, Instagram e Messenger — ver `docs/integrations/MANYCHAT.md`)
- **Onboarding** — wizard de configuração inicial no primeiro acesso

## Stack

- **Frontend**: React 19 + TanStack Start/Router (roteamento por arquivos), TanStack Query, Tailwind CSS 4, shadcn/ui (Radix), dnd-kit, Recharts
- **Backend**: Supabase (Postgres + RLS, Auth, Edge Functions em Deno)
- **Build**: Vite 8 + TypeScript

## Estrutura

```
src/
├── routes/            # rotas (file-based) — _app.* são as telas autenticadas
├── components/        # UI (shadcn), layout, onboarding, contatos, integrações
├── integrations/      # cliente Supabase
└── lib/               # auth, utilitários
supabase/
├── functions/
│   ├── messaging-webhook/   # recebe mensagens dos provedores (Z-API, Twilio, Resend)
│   ├── messaging-send/      # envia mensagens
│   ├── ai-respond/          # resposta automática por IA (chamada interna do webhook)
│   ├── ai-playground/       # teste do assistente sem enviar mensagem real
│   └── integration-connect/ # conexão/validação de credenciais de provedores
└── migrations/        # schema do banco
```

## Primeiro acesso depois de um remix

O projeto clonado já vem com o código e o schema; o que falta é preparar o ambiente do
novo backend. No primeiro acesso:

1. Crie sua conta e entre — o primeiro usuário vira administrador. O banco do clone nasce
   vazio: as contas do projeto de origem **não** são copiadas, então entrar com a senha
   antiga devolve "e-mail ou senha incorretos" e o link de redefinição não tem conta para
   onde ir. A tela de entrada detecta o ambiente vazio e já abre em "Criar conta".

2. Percorra o wizard de onboarding. O passo **"Preparar o ambiente"** grava sozinho o
   acesso interno do backend e mostra um diagnóstico item a item; não é preciso digitar
   nenhuma chave.
3. No passo **"Rotinas automáticas"**, ative as rotinas agendadas (nutrição, SLA, fila da
   IA). Elas nascem desligadas de propósito.
4. Conecte um canal de mensagens em **Configurações → Integrações e Plugins** e revise os
   prompts da IA.

Enquanto o passo 2 não roda, as rotinas aparecem como pendentes — isso é estado esperado
de projeto novo, não erro. O mesmo diagnóstico fica disponível depois em
**Configurações → Ambiente**.

## Rodando localmente

Pré-requisitos: Node.js ≥ 22 (ou Bun) e um projeto Supabase.

```bash
# instalar dependências
npm install   # ou bun install

# desenvolvimento
npm run dev

# build de produção
npm run build
npm run preview
```

Variáveis de ambiente (`.env`):

```
VITE_SUPABASE_URL=            # URL do projeto Supabase
VITE_SUPABASE_PROJECT_ID=     # ID do projeto
VITE_SUPABASE_PUBLISHABLE_KEY=# chave pública (anon/publishable)
```

Segredos das integrações (tokens de Z-API/Twilio/Resend, service role) ficam nos **secrets das Edge Functions** no Supabase — nunca no frontend.

## Scripts

| Comando           | Descrição                   |
| ----------------- | --------------------------- |
| `npm run dev`     | servidor de desenvolvimento |
| `npm run build`   | build de produção           |
| `npm run preview` | pré-visualização do build   |
| `npm run lint`    | ESLint                      |
| `npm run format`  | Prettier                    |

## Segurança

- Autenticação via Supabase Auth; rotas de app protegidas por redirect em `src/routes/_app.tsx`
- Isolamento de dados por tenant com RLS no Postgres
- Webhooks fail-closed: token obrigatório por URL, sem token válido a mensagem é descartada
- `ai-respond` aceita apenas chamadas internas autenticadas com service role
