# Evidências da Clínica FT

Execute somente após o integrador liberar `GO CAPTURA`. Nenhum comando abaixo cria tenant, reaplica o onboarding ou publica alterações.

## Credenciais e segurança

Carregue `~/.config/aceleraflow-imersao/credentials.env` no ambiente do processo, sem imprimir o arquivo. Não habilite `DEBUG=pw:*`, trace, HAR, vídeo de login nem exportação de `storageState`. Os dois specs desativam trace, vídeo e screenshots automáticos. O capturador só fotografa páginas autenticadas e rejeita campos de senha, erro, 404 e carregamento incompleto.

Cada login parte de um contexto isolado novo e aguarda o aceite do aviso de privacidade, que só aparece após carregar o perfil. O helper não devolve uma página ainda bloqueada por esse modal.

Com `IMERSAO_E2E=1`, a ausência de `CLINICA_FT_EMAIL` ou `CLINICA_FT_PASSWORD` falha. Sem essa flag, os specs sem credenciais são pulados e **não constituem evidência**. Os capturadores sempre falham sem credenciais.

## Perfis e telas

1. `prod`: desde o deploy de 16/10/2026, exige configuração de IA e prompts por estágio, Comportamento das respostas com 3 blocos/1500 ms/3000 ms, conversa **simulada** da Mariana (`a924c735-15c3-4cf5-b1d4-0a89a7b96b2d`) e ficha correspondente (`5ffc5ce7-db42-4b64-9851-bee047951a7b`) com extrações aplicadas e mensagem-fonte consultável. Também exige agente de pipeline ligado, política autônoma a 80%, três sequências e métricas reais de automação, inclusive zero. O nome da nova ficha foi definido pela recepção; não é extração atribuída à IA. Sem criação manual de negócio para preencher a qualificação.
2. `branch`: preserva o cenário de homologação: conversa simulada com agendamento confirmado, memória e resumos reais, qualificação do negócio por IA, extrações com mensagem-fonte, comportamento, switch do agente e métricas. O capturador não semeia nem corrige esse cenário.
3. A etapa `01-onboarding.png` registra **estado aplicado**, não execução do wizard. Verifica o funil do dataset e o nome da empresa em Configurações. Não prova isoladamente o valor de `tenants.onboarded_at`.
4. `07-autonomia-aprovacao.png` abre primeiro a fila de decisões e depois a política em Pipeline → Autonomia. Fila vazia é válida; política ausente ou confiança diferente de 80% falha. Não aprova nem rejeita decisões.
5. Capturas usam 1440×900 por padrão, sem página inteira. `--viewport 1920x1080` gera as fontes do vídeo sem alterar o padrão. `resultado.json` registra resolução, perfil, resultados e rotas. Sem `--out`, os PNGs vão para `artifacts/imersao-clinica-ft/apresentacao/telas/` e o relatório para `artifacts/imersao-clinica-ft/screenshots/`, para que a pasta da apresentação contenha só imagens; com `--out`, PNGs e relatório ficam no mesmo diretório. Falhas não geram PNG e tornam o comando não zero. As capturas anteriores ao deploy estão arquivadas em `artifacts/imersao-clinica-ft/screenshots-pre-deploy/`.

No dashboard e no inbox, o período escolhido no topo vale na hora (estado compartilhado entre telas desde 16/10), sem recarregar a página. A captura centraliza o card de revisão humana para mostrar os números de mensagens e automação nas duas resoluções.

O suplemento `10-kanban-auditoria-ia.png`, nos diretórios `apresentacao/telas/` e `motion/source/prod/`, registra o histórico genuíno do negócio `Contato Cliente simulado`: Novo Paciente → Em Atendimento, badge “Movido pela IA” e confiança de 100%. É consulta a um movimento anterior, não filmagem da transição. “Pausar IA”, “Desfazer movimento” e “Corrigir avaliação” não foram acionados.

Os specs e o capturador somente navegam/leem, incluindo efeitos normais autorizados como marcar conversa como lida. Na regeneração pós-deploy, a preparação autorizada enviou três mensagens fictícias pelo canal Simulação, ajustou somente o nome do contato como ação humana da recepção e enviou uma resposta humana pela UI após a transferência genuína da IA. O envio da recepção limpa o sinal de espera, mas mantém a IA pausada. Os blocos da IA e as extrações vieram das execuções reais. Nenhum negócio foi criado manualmente nem automação forçada.

## Comandos

No shell que já carregou as credenciais:

```bash
IMERSAO_E2E=1 IMERSAO_PROFILE=prod IMERSAO_BASE_URL=https://aceleraflow-remix.lovable.app pnpm exec playwright test e2e/imersao-clinica-ft --workers=1 --retries=0 --reporter=line
IMERSAO_BASE_URL=https://aceleraflow-remix.lovable.app node scripts/imersao-clinica-ft/capture-screenshots.mjs --profile prod
IMERSAO_BASE_URL=https://aceleraflow-remix.lovable.app node scripts/imersao-clinica-ft/capture-screenshots.mjs --profile prod --viewport 1920x1080 --out artifacts/imersao-clinica-ft/motion/source/prod/
```

Para a branch local, use a URL informada pelo integrador:

```bash
IMERSAO_BASE_URL="$URL_LOCAL" node scripts/imersao-clinica-ft/capture-screenshots.mjs --profile branch --out artifacts/imersao-clinica-ft/screenshots-branch-local/
```

A jornada Playwright recebe o mesmo perfil por `IMERSAO_PROFILE=branch`; `--profile` pertence ao script de captura, não à CLI do Playwright.

Para recapturar somente o dashboard após o GIF, acrescente `--only dashboard`. Isso preserva os outros oito PNGs anteriores à movimentação da Mariana e grava `resultado-dashboard.json`, sem sobrescrever o relatório da captura completa.

## GIF genuíno, somente local

Exige `IMERSAO_BASE_URL` em loopback e IDs existentes em `IMERSAO_TENANT_ID`, `IMERSAO_BOARD_ID`, `IMERSAO_DEAL_ID`. `IMERSAO_TARGET_STAGE_ID` é opcional. `IMERSAO_PROOF_OUTPUT` permite usar o caminho de `--output` informado pelo integrador; o padrão é `artifacts/imersao-clinica-ft/kanban-auto-proof.json`. O integrador prepara opt-in, política autônoma e um alvo elegível. O capturador não cria outro tenant ou card.

```bash
node scripts/imersao-clinica-ft/capture-kanban-gif.mjs
```

O script lê a coluna antes do evento e dispara assincronamente `local-pipeline-agent-proof.mjs --tenant-id … --board-id … --deal-id … --output …`. O frontend tem `usePipelineRealtime`; por isso a captura **não recarrega a página**. Se o realtime não atualizar o card, a prova falha, sem fallback sintético.

A gravação termina só depois de mostrar a mudança e o diálogo do mesmo deal com origem/destino e ator IA. O arquivo de prova precisa confirmar IDs de evento, comando e histórico. O GIF usa apenas frames reais, acelera a espera por amostragem e preserva a abertura da auditoria; não representa duração real do worker. Os metadados distinguem o tempo gravado do tempo do GIF. Saída: `artifacts/imersao-clinica-ft/kanban-auto.gif`, palette gerada pelo ffmpeg, 5–12 segundos. Ausência de transição ou auditoria resulta em erro e nenhum GIF válido.

## Checagens da fase A

```bash
pnpm exec playwright test e2e/imersao-clinica-ft --list
node --check scripts/imersao-clinica-ft/capture-screenshots.mjs
node --check scripts/imersao-clinica-ft/capture-kanban-gif.mjs
node --check e2e/imersao-clinica-ft/jornada-helpers.mjs
pnpm exec tsc --noEmit --allowJs --checkJs false --skipLibCheck --module nodenext --moduleResolution nodenext --target es2022 --types node e2e/imersao-clinica-ft/auth.spec.ts e2e/imersao-clinica-ft/jornada.spec.ts
```

Esse typecheck restringe-se aos specs e seus imports. Não substitui o gate de `src/**` do integrador, nem executa os cenários E2E.
