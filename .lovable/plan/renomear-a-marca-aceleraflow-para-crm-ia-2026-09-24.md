# Renomear a marca "AceleraFlow" para "CRM IA"

## Objetivo
Trocar o nome visível do produto de **AceleraFlow** para **CRM IA** em toda a interface, sem quebrar identificadores técnicos.

## O que será alterado (nome visível)

1. **Títulos de aba e metadados de todas as telas** — `src/routes/*.tsx` (index, auth, pipeline, app, inbox, contatos, empresas, produtos, templates, formulários, perfil, nurture, agentes, agenda, configurações etc.): `"... — AceleraFlow"` vira `"... — CRM IA"`.
2. **Página inicial** — selo/logotipo textual e título "AceleraFlow — Receita em movimento" → "CRM IA — Receita em movimento".
3. **Tela de login** — rótulo "AceleraFlow" → "CRM IA".
4. **Tela de consentimento OAuth** — "Conectar X ao AceleraFlow" → "Conectar X ao CRM IA".
5. **Manifest do app** (`public/manifest.webmanifest`) — `name` e `short_name` → "CRM IA".
6. **`public/llms.txt` e `README.md`** — título → "CRM IA".
7. **Testes** que validam esses títulos — atualizados para o novo nome.

## O que NÃO será alterado (propositalmente)

- **URLs** (`aceleraflow.lovable.app` em sitemap, robots, canonical, og:url): o endereço publicado não muda com o nome; trocar quebraria links já compartilhados.
- **Chaves técnicas e segredos** (`aceleraflow_project_url`, `aceleraflow_service_role_key` no Vault), nomes de migrations, nomes de arquivos de teste de banco e contratos internos: mudar quebraria rotinas agendadas e integrações.
- E-mails e domínios das contas de demonstração.

## Validação

- `tsgo --noEmit` + testes afetados (auth, pipeline, inbox, sitemap etc.).
- Busca final por "AceleraFlow" em `src/` e `public/` confirmando que só restam URLs e identificadores técnicos.
