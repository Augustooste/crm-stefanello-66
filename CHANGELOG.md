# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/). Este projeto passa a seguir [SemVer](https://semver.org/lang/pt-BR/) a partir de `v1.0.0`.

> Histórico anterior a esta tag (pré-histórico + Fases 0-6 do PRD + rodadas de QA) está em `docs/RELATORIO-fases-features.md`, não repetido aqui.

## [2026-10-16]

### Adicionado

- Imersão Clínica FT: agente de pipeline com opt-in por workspace e corte temporal; configuração de blocos, intervalo e agrupamento da IA por tenant.
- Canal simulator com resposta real da IA, extração automática da ficha com mensagens-fonte, card de qualificação e histórico de execução de follow-up.
- Seed MOCK idempotente e limpeza seletiva por manifesto, provas locais com Gemini, E2E de autenticação/jornada, dois conjuntos de capturas, GIF do Kanban e documentação em `docs/imersao-clinica-ft/`.

### Alterado

- Material da imersão Clínica FT reunido em `artifacts/imersao-clinica-ft/apresentacao/`: vídeo principal, clipe e GIF do Kanban, `telas/` (10 capturas de produção) e `onboarding/` (8 passos do wizard). O capturador grava as telas lá por padrão e mantém os relatórios `resultado*.json` em `screenshots/`.

### Corrigido

- Baixa confiança encaminhada para revisão humana; opt-in revalidado após claim e no comando de transição. Takeover interrompe blocos pendentes; o turno compartilha orçamento de execução.
- Follow-up respeita pausa/cancelamento e evita reinscrição indevida durante envio; dashboard filtra por quadro e conta avanços IA sem duplicar conversas, comandos ou pendências.
- Leitura da qualificação sem coluna inexistente e parser de extração compatível com a resposta real do modelo.
- Fan-out do outbox respeita o opt-in e `enabled_at` do próprio tenant para `pipeline.agent` e `contact.enrichment`, sem alterar outros assinantes nem o backlog pendente existente (`20261015170000_fanout_respeita_opt_in.sql`).
- `create_simulator_channel` não depende mais de `USAGE` no schema `private` para `authenticated`, permissão ausente em produção (`20261015180000_simulador_sem_schema_private.sql`). Regressão pgTAP reproduz a ACL de produção, com RED→GREEN; suíte de banco: 69 arquivos / 1289 testes PASS.
- Follow-up não reinscreve sequência concluída (`20261016190000_nurture_completed_bloqueia_reinscricao.sql`); corrigida race do realtime no Kanban e no status do canal, publicadas em 16/10. Capturas 02, 03, 05, 07 e 08 recapturadas em produção.
- `/contatos/duplicados` sem dependência de `USAGE` no schema `private` (`20261016200000_duplicados_sem_schema_private.sql`), mantendo a regra de tenant ativo; período global do topo vale na hora para inbox e dashboard, sem recarregar a página.
- `apply_niche_template` pode ser reaplicado em funil que já tem negócios (`20261016210000_template_nicho_com_negocios.sql`); a IA não cria negócio novo quando a leitura do negócio aberto falha.
- Dashboard: grade do card Performance de Mensagens alinhada, KPIs do topo seguem período, responsável e quadro, e o relatório mostra o LTV real em vez de "Em breve".
- Nome do workspace sem piscar "CRM IA" durante o carregamento; topbar e tema da marca leem o tenant pela mesma consulta, e as cores do cliente são aplicadas em qualquer ordem de montagem.

### Segurança

- Ativação/pausa de rotinas globais restrita a operadores cadastrados explicitamente; configuração do acesso interno não pausa o cron global.
- Simulador sem entrega externa de mensagens ou alertas de e-mail; provas locais isoladas e E2E sem trace/vídeo de autenticação.
- Nove migrations da imersão aplicadas em produção, incluindo `20261015170000_fanout_respeita_opt_in.sql` e `20261015180000_simulador_sem_schema_private.sql`; 25/25 Edge Functions publicadas sem erro e frontend publicado em `https://aceleraflow-remix.lovable.app` em 16/10/2026. O risco de controle global por admin comum está fechado; por decisão do usuário, a conta demo é a operadora da plataforma.

### Validação em produção

- Clínica FT habilitada sob RLS para pipeline, enriquecimento (`auto_qualify`) e simulator às 14:25:53 UTC; comportamento 3 blocos / 1500 ms / 3000 ms. Mensagem simulada às 14:30:31 UTC recebeu resposta real em 2 blocos, às 14:30:42 e 14:30:46, sem envio externo; 7 extrações automáticas (5 aplicadas), em duas rodadas, e entregas de `pipeline.agent` processadas.
- Crons de pipeline e enriquecimento ativos, com opt-in somente da Clínica FT entre os 17 tenants. Zero entregas novas para os outros tenants; backlog antigo de 2614 entregas `pipeline.agent` pendentes desde 17/08 preservado.
- E2E pós-deploy 11/11; F3 valida o card de comportamento. F7 teve intermitência de carregamento numa rodada longa e passou 2/2 isolada. Gates tsc, eslint, prettier, Vitest 2501/2501 e build verdes, conforme integrador.
- Histórico, limites e pendências operacionais em `docs/imersao-clinica-ft/03-VALIDACAO.md` e `06-ENTREGA-FINAL.md`; a publicação não comprova envio WhatsApp externo. Movimento autônomo comprovado em produção: comando `deal_stage_transition_commands` com `actor_type=ai` e `decision=auto_move`, aceito às 14:30:51 UTC (Novo Paciente → Em Atendimento, confiança 1,0). 31 decisões da IA: 5 comandos de avanço de estágio (1 aceito, 4 bloqueados) e 26 pendentes na fila `/decisions`.

## [v1.1.0] - 2026-07-27

### Added

- Agente de IA ouve e responde em áudio (ElevenLabs STT + TTS). Áudio recebido do lead é transcrito antes de entrar no prompt; a resposta pode voltar em voz conforme `voice_reply_mode` (`off` / `always` / `on_audio`) e `voice_id` em Configurações → Assistente IA. Padrão `off`: nenhum tenant existente passa a gastar crédito de ElevenLabs por causa deste deploy.
- `webhook_health = 'silent'` distingue "canal nunca recebeu evento nenhum" de `'broken'` ("recebia e parou"). Antes os dois casos apareciam como `'broken'` com `webhook_consecutive_failures = 0`, o que apontava para o diagnóstico errado.
- PRD da Base de Conhecimento por cliente (RAG) em `docs/` — documento de planejamento, sem código de produto.

### Fixed

- Chamadas ao gateway de IA não tinham deadline: um `fetch` pendurado consumia o isolate inteiro e deixava o claim de idempotência órfão, perdendo a mensagem do lead em definitivo (não só atrasando). `GATEWAY_TIMEOUT_MS` de 30s, dimensionado contra o `AI_LOCK_TTL_MS` de 90s (duas chamadas de LLM por turno + folga para o resto).
- Prompt de persona vazio não caía no fallback. A coluna é `not null default ''` e `'' ?? fallback` devolve `''` — o agente rodava sem persona nenhuma em vez de usar o texto padrão.
- Desconectar a ElevenLabs não parava a transcrição de entrada, nem o áudio de saída, nem a cobrança.
- Erro de banco ao ler credencial de voz deixava o claim de idempotência órfão para sempre.
- Erros de integração vazavam em inglês no card de Integrações (`"fetch failed"`), enquanto a outra tela mostrava a mesma falha em PT-BR.
- 14 chamadas `fetch` de mensageria e envio de provider sem deadline — mesma classe de falha do gateway.

### Security

- Fecha os 9 alertas do Dependabot via `pnpm.overrides`.

## [v1.0.0] - 2026-07-15

### Changed

- Sidebar reduzido de 19 para 14 itens. Assistente IA, Falhas de IA, Digest Semanal e Integrações viraram abas de Configurações; Templates e Agendamentos foram fundidos em uma única rota (`/templates`, item "Mensagens" no sidebar).
- Aba "Notificações" (ex-Digest Semanal) em Configurações é visível a qualquer usuário do tenant (não só admin), preservando o nível de acesso original.

### Fixed

- Link cross-tab ("N falhas recentes") não trocava de aba corretamente — `Link`/`redirect` do TanStack Router usa `pushState`, que não dispara `hashchange` nativo. Corrigido com `useRouterState`.

### Deprecated

- Rotas `/assistente`, `/falhas-ia`, `/integracoes`, `/digest-semanal`, `/agendamentos` continuam funcionando via redirect (nunca 404) para as novas abas correspondentes.
