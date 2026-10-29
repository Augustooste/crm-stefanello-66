# Limpeza de metadados do projeto

Dois tipos de "metadados" estão em jogo, e só um deles está ao meu alcance.

## O que NÃO é possível apagar por aqui

Os metadados de integrações da plataforma Lovable (o registro interno que o remix tenta copiar e onde a falha acontece) não são arquivos do repositório. Não existe comando no chat que os leia, edite ou apague — nem o usuário consegue pela interface. Só o suporte da Lovable pode inspecionar e recriar esse registro. Isso não muda com nenhuma limpeza no código.

## O que dá para limpar sem risco

1. **Duplicatas de variáveis públicas no `.env`**
   Hoje o arquivo tem seis linhas: as três `VITE_SUPABASE_*` e três cópias sem prefixo (`SUPABASE_PROJECT_ID`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_URL`). As cópias sem prefixo são redundantes: o build e `src/lib/env.ts` já leem as `VITE_*` primeiro, e as Edge Functions recebem esses valores do runtime, não deste arquivo. Ficam só as três `VITE_*`, que é o contrato esperado do template de remix.

2. **Planos arquivados** — 36 arquivos em `.lovable/plan/`, histórico de conversa, sem efeito em build, testes ou banco. Podem ser removidos por inteiro (ou manter só os dois últimos, se preferir rastro).

3. **Artefatos de auditoria pontual**
   - `audit-results.json` (saída antiga de varredura).
   - `scripts/audit-2026-07-*.ts` e `scripts/audit-2026-07-30-*.sql`, apêndices de investigações já encerradas.
   - `tsconfig.tsbuildinfo` (cache de compilação, regerado sozinho) — além disso entra no `.gitignore`.
   Cada um só sai depois de confirmar, por busca no repositório, que nada em CI, testes ou scripts o referencia.

## O que fica, de propósito

- `.lovable/project.json` — declara template e revisão; é o que identifica o projeto para a plataforma.
- `.env` com as três `VITE_*` — versionado por decisão; removê-lo derruba o boot.
- Fallback público de URL/chave em `vite.config.ts` e `src/lib/env.ts` — load-bearing no rebuild via GitHub, e já protegido pelo identificador deste projeto.
- `bun.lock`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `deno.lock` — o gate `scripts/check-lockfile-pins.mjs` e o CI dependem dos três primeiros; `deno.lock` prende as versões das Edge Functions.
- `.githooks/` e o script `prepare` — inertes fora de um repositório git, já corrigidos antes.
- `contracts/`, `.workspace/`, workflows do GitHub — em uso.

## Verificação depois da limpeza

Typecheck, `scripts/check-config-toml.mjs`, `scripts/check-lockfile-pins.mjs`, os testes de identidade do backend (`src/lib/env.test.ts`, `src/integrations/supabase/client.test.ts`) e o log de build do preview.

## Conclusão honesta

Essa limpeza deixa o repositório mais enxuto e mais fiel ao contrato de remix, mas **não deve destravar o erro "copying the project's integrations"** — ele acontece antes de qualquer arquivo do projeto ser lido. O chamado ao suporte continua sendo o caminho para aquele bloqueio.
