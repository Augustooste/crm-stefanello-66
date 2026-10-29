# Nota de entrega — Clínica FT

Abra `../apresentacao/aceleraflow-clinica-ft.mp4` para a apresentação e `../apresentacao/kanban-auto.mp4` para isolar a prova do avanço.

## Arquivos e resultados medidos

Os três entregáveis de mídia ficam em **`../apresentacao/`**; o restante desta tabela fica nesta pasta.

| Entregável | Medição final |
|---|---|
| `aceleraflow-clinica-ft.mp4` | **1920×1080, 60,000 s, H.264, 30 fps, 1800 quadros, 14.236.775 bytes**, sem áudio. |
| `kanban-auto.mp4` | **1920×1080, 9,000 s, H.264, 30 fps, 270 quadros, 2.011.440 bytes**, sem áudio. |
| `kanban-auto.gif` | **960×540, 9,010 s, 72 quadros, 4.898.244 bytes (4,90 MB)**, abaixo de 8 MB. Os atrasos são quantizados em centésimos; a amostragem nominal é 8 fps. |
| `scenes/` | Nove composições numeradas, `index.html`, plano JSON, compositor e o auxiliar `kanban-recording.html`. Runtime, GSAP e fontes locais, sem dependência nova no frontend. |
| Evidências | `reports/final/`, `reports/kanban/`, **quatro contact sheets com 30 frames selecionados** e **sete folhas com 60 frames a cada segundo**, extraídos do MP4 final. `reports/draft/` é histórico da produção anterior, não desta versão. |

### Gates do MotionMaxxing

| Medida | Filme final | Kanban curto |
|---|---:|---:|
| G0: duração/formato | **PASS · 60 s · 1920×1080** | **PASS · 9 s · 1920×1080** |
| G2: vazio | PASS · nenhuma sequência >3 quadros planos | PASS · nenhuma sequência >3 quadros planos |
| Trecho congelado ≥0,6 s | Nenhum | Nenhum |
| G3: end hold | **0,00 s / 0 quadros** | **0,23 s / 7 quadros** |
| Último plano | 2,50 s · 4,17% do filme | 1,80 s · 20% do clipe |
| Cortes autorados / planos | 28 / 29 | 2 / 3 |
| Duração média dos planos | 2,07 s | 3,00 s |
| Menor / maior plano | 1,50 / 5,70 s | 1,50 / 5,70 s |
| Trecho de baixa variação mais longo | 19,40–22,43 s · 3,03 s | 7,30–8,07 s · 0,77 s |
| Variação média de luminância | 0,6/255 | 0,7/255 |
| G5: lint | **15/15 regras PASS, 0 achados, 30 tempos** | **15/15 regras PASS, 0 achados, 5 tempos** |

Resultados brutos: `reports/final/{look.txt,lint.json,media.json}` e equivalentes em `reports/kanban/`. O detector visual encontrou um corte adicional em **38,53 s** no filme / **5,53 s** no curto: é a abertura real do painel no vídeo-fonte, antes do corte de câmera autorado. Não foi inserido para ocultar quadros vazios.

**Ressalva de movimento:** a luminância permanece abaixo da faixa humana de referência do `look.py` (mediana 6,8; intervalo 4,4–9,8). Há câmera contínua sobre UI escura e cortes, não controles artificialmente animados. A baixa variação foi examinada por olho, sem falsificar movimento de cards para elevar a métrica. O aviso de fonte ausente do `look.py` afeta apenas seus timecodes; as contact sheets próprias têm tempos impressos em Noto Sans.

**G1 e G4: aprovados por inspeção das imagens exportadas**, após corrigir o plano de transferência humana. Foram abertas as quatro contact sheets, as sete folhas de revisão por segundo, a sheet automática e detalhes FullHD. A câmera amplia os fragmentos principais; a leitura da tela inteira não é prometida. Legendas de 42 px, ou 40 px no Kanban, ficam fora da UI. Não houve teste em projetor físico.

**Geometria das legendas:** `check-captions.mjs` percorreu **1800 quadros** do principal — 1530 com legenda no DOM e 270 do vídeo já legendado — e **270 quadros** da composição curta. Resultado: **0 sobreposições**, distância mínima de **45 px** nas capturas e **37 px** no Kanban. Busca temporal determinística: **24 amostras por composição, 0 divergências**. Evidência: `reports/caption-layout.json`. A geometria não substitui a inspeção do texto rasterizado.

**Procedência versus G5:** nenhuma exceção foi necessária; nenhuma regra foi desligada e não houve elemento isento. Produção, homologação, Simulação e dados fictícios continuam explícitos. O lint examina o DOM; a UI rasterizada foi conferida por olho.

**Preservação:** **9/9 SHA-256 originais intactos** em `../screenshots-pre-deploy/`, pasta para a qual o coordenador moveu as capturas de 15/10. As **10 novas capturas** em `../apresentacao/telas/` — nove principais e o suplemento de auditoria — e as **21 fontes selecionadas** também permaneceram intactas durante a renderização final. Baseline: `reports/prod-baseline.json`; comparações: `reports/final/originais.json` e `reports/final/fontes-producao.json`. Nenhuma captura pré-deploy das funcionalidades novas foi usada como se fosse publicada.

## Procedência e o que a montagem realmente mostra

As interfaces são imagens e quadros de gravação real. O HTML anima apenas câmera e procedência, sem reconstruir controles, conversas, cards ou números. A janela de captura mede 1920×810 e as legendas ficam fisicamente abaixo dela. A abertura e o fechamento informam que os dados são fictícios/demonstrativos.

- **Produção:** `https://aceleraflow-remix.lovable.app`, tenant `acc0f11d-2d6e-4cc3-82a6-5b04ccfdd8ac`. As funcionalidades publicadas usam recapturas de **16/10/2026**, liberadas por CapturaE2E, e complementos deste agente. O wizard real foi preservado de **15/10**, em `../apresentacao/onboarding/`, sem reaplicar o template. A captura atual `01-onboarding.png` mostra Configurações/Empresa e o botão Refazer, não o passo Nicho; por isso não substitui a execução registrada do wizard.
- **Homologação:** somente a gravação histórica de movimento do Kanban, feita com a branch e Supabase local em `http://127.0.0.1:5173`, tenant `3a807208-3f4b-4a02-b633-34fd7ef0c686`. A legenda diz “Gravação anterior · avanço real da IA”; não diz mais “recurso pendente de publicação”, pois o recurso foi publicado.
- **Som e mídia:** nenhum áudio, locução, música ou efeito, por ausência da chave ElevenLabs. O app exibe ElevenLabs não conectada e **Sempre em texto** selecionado. Não foi acrescentada mídia à conversa nem alegado envio de áudio ou imagem.
- **Coleta audiovisual deste agente:** Playwright autenticado em 1920×1080, somente navegação, abas, menus e rolagem. Sem salvar, enviar, aprovar, rejeitar, reaplicar template ou mover negócio. Login não foi filmado; sem trace, HAR ou storageState em disco. Credenciais somente do arquivo de ambiente autorizado.

### Conversa e autoria dos dados publicados

O enriquecimento autorizado pelo coordenador, anterior às capturas, está em `../prod-simulation-enrichment.json`: conversa `a924c735-15c3-4cf5-b1d4-0a89a7b96b2d`, contato `5ffc5ce7-db42-4b64-9851-bee047951a7b`, canal Simulação. **Mariana Lopes foi um nome definido pela recepção**, não extraído pela IA. O título do negócio continua **Contato Cliente simulado**.

Dois blocos de IA responderam à pergunta sobre serviços e avaliação; os IDs são `b75f6378-0aa2-478a-b41a-bde26a6e5ca9` e `db405ac7-204b-4531-87e6-28a596ab5150`. Os turnos seguintes informaram Campinas, terça/quinta após 18h, e-mail e preferência por WhatsApp. Houve transferência e **uma única resposta humana da recepção**, ID `a014dc8a-34c9-4778-bfc7-c49da96944de`. Essa resposta não é atribuída à IA nem comprova agendamento confirmado.

O estado final é **IA pausada**, `ai_active=false` e `awaiting_human=false`: a resposta humana encerra a espera, sem reativar a IA. O registro contém sete extrações, cinco aplicadas, e três resumos de memória. A qualificação exibida é **85% com base em nove mensagens**. A frase de sugestão do modelo que menciona reserva não é prova de reserva realizada e não foi usada como alegação do vídeo.

### Fontes por cena

Caminhos relativos a esta pasta; os arquivos sem prefixo de diretório na tabela ficam em **`source/prod/`**. `scenes/plan.json` é o mapeamento executável.

| Cena | Origem e arquivos usados | Limite da alegação |
|---|---|---|
| 1. Onboarding | Produção, 15/10: `wizard-nicho.png`, cópia de `../apresentacao/onboarding/03-passo.png`, 1920×965. | Passo Nicho, template odontológico Aplicado, 7 estágios/5 prompts. Não há uma etapa separada de edição do funil. |
| 2. Configuração | Produção, 16/10: `complemento-assistente-topo.png`, `complemento-02-configuracao-ia.png`, `complemento-playground.png`, `complemento-transferencia-humana.png`. | Assistente, prompt, playground vazio e palavras de transferência reais; nenhuma resposta inventada na área de teste. |
| 3. Comportamento | Produção: `complemento-03-comportamento-ia.png`, `complemento-comportamento-modalidades.png`. | 3 blocos, 1500 ms de intervalo, 3000 ms de agrupamento, Sempre em texto e alternativas reais. Não demonstra áudio. |
| 4. WhatsApp | Produção: `complemento-04-whatsapp-chat.png`, `complemento-conversa-blocos-ia.png`. | Dois blocos genuínos da IA no **Canal Simulação — sem entrega no WhatsApp**. IA pausada após transferência; nome e resposta humana têm autoria da recepção. |
| 5. Ficha | Produção: `complemento-ficha-extracao.png`, `complemento-ficha-memoria.png`, `complemento-ficha-qualificacao.png`. | E-mail extraído com link Ver mensagem-fonte 1, memória e qualificação de 85%/9 mensagens. Mostra o link, sem alegar que seu clique foi filmado. |
| 6. Kanban | Produção: `06-kanban-automatico.png`, `10-kanban-auditoria-ia.png`. Homologação: `source/kanban-original.gif` → `source/kanban-captura.mp4` → `../apresentacao/kanban-auto.mp4`. | Produção mostra histórico persistido de Novo Paciente → Em Atendimento; homologação mostra movimento filmado Qualificado → Avaliação Agendada. **Não são o mesmo negócio nem uma transação contínua.** |
| 7. Autonomia | Produção: `complemento-autonomia-quatro-modos.png`, `complemento-07-autonomia-aprovacao.png`, `complemento-fila-decisoes.png`. | Quatro modos, confiança mínima de 80% e alerta de prazo de Elisa na fila. O alerta de SLA não é apresentado como sugestão de avanço. Nenhuma decisão foi aprovada. |
| 8. Follow-up | Produção: `complemento-followup-sequencia.png`, `complemento-followup-historico.png`. | Três sequências inativas e zero inscrições ativas no conjunto. A sequência de avaliação tem condição de 24h e inscrição pausada de João Farias, com **Nenhuma execução registrada**. Não alega disparo, entrega externa ou envio a Mariana. |
| 9. Dashboard | Produção: `complemento-09-dashboard.png`, `09-dashboard.png`; Últimos 90 dias. | 16 negócios ativos; 1 auto-avanço, 0 sugestões pendentes, 1 aguardando humano e taxa de aprovação “—” com 0 aprovados/0 rejeitados. São valores da captura, não projeções comerciais. |

A captura completa final do dashboard, liberada por CapturaE2E após recarregar o período, também contém 71 mensagens (33 humanas/38 IA), 26 contatos, 22 conversas, 100% de resposta, 4 min e cobertura de 8,3%. Esses números não são todos focados no filme. Os metadados das capturas complementares registram a data e a URL de produção. As fontes antigas em `source/branch/` e `source/prod/funil-publicado.png` ficam como arquivo histórico, **não são usadas nas cenas de funcionalidades publicadas**.

### Registro autônomo em produção

O arquivo `../prod-pipeline-audit-capture.json` vincula a imagem 10 ao negócio `b2cc2be8-adcb-4bae-86a4-5fca6896613b`, **Contato Cliente simulado**, contato Mariana. A captura foi feita em **16/10/2026, 17:07:17 UTC**, somente abrindo detalhes. Ela mostra **Movido pela IA**, **Novo Paciente → Em Atendimento**, confiança **100%** e o badge **Conflito detectado**, que não foi apagado.

O integrador Main verificou o comando `accepted`, `actor_type=ai`, confiança `1.0`, gatilho `message.sent`, às **14:30:51 UTC**. Também verificou quatro tentativas posteriores de Em Atendimento → Qualificado bloqueadas por `human_active`, às 16:58, depois que a recepção assumiu. A imagem comprova o histórico e exibe o conflito, mas **não mostra textualmente a causa `human_active` nem filma essas tentativas**. A montagem não fabrica essa explicação em uma interface sobreposta.

### Kanban filmado: opção A

O GIF genuíno preservado tem **1440×900, 68 quadros e 8,4 s**. `source/kanban-evidencia.json` registra a gravação original de 13,7 s, espera acelerada por amostragem, atualização realtime e **0 recarregamentos**. Os quadros de transição e auditoria permanecem na ordem original. Nenhum arraste foi acrescentado e o card não é animado separadamente da gravação.

A conversão para MP4 repete quadros a 30 fps, sem interpolação de conteúdo. Os 0,6 s finais do curto de 9 s prolongam o último quadro real enquanto a câmera continua em movimento. O GIF entregue deriva desse MP4, com 8 fps nominais, 960×540, 128 cores e dithering Bayer. Não representa uma segunda execução.

Identificadores locais: negócio `3ea184ec-79a0-5ba7-8f00-b31346398bc7`; histórico `40d6e45f-faeb-49b3-ab64-dbb443e538bf`; comando `650ecc22-a4bd-4a4a-bace-e6e102695c15`; evento `e9e9efd9-b5c3-4ccd-8444-4f7b41f7f805`; `actorType: ai`. O painel mostra confiança 100% e Movido pela IA.

A opção B foi descartada porque **Avaliação Agendada → Proposta** exige avaliação realizada e proposta revisada por profissional. Na leitura de AmbienteLocalDemo de 15/10, 19:53:10 UTC, a consulta ainda era futura, em 22/10, com status `confirmed`, cron pausado e nenhuma tarefa elegível. `payment.approved` não comprovava os critérios. Não houve novo evento, movimento manual, fallback ou alteração de política para filmar. Por isso não existe um falso `kanban-raw.webm`: a fonte bruta disponível é o GIF anterior.

## Protocolo e correções de direção

O storyboard precedeu a composição. A primeira produção começou pela gravação difícil do Kanban, com stills antes/depois/auditoria e render de rascunho a 960×540. Na revisão pós-deploy, a cena 6 foi novamente a primeira a ser inspecionada: três closes de produção e entrada da gravação histórica, antes do filme completo.

A revisão do coordenador havia identificado uma falha real de G1: a legenda cobria rótulos do dashboard. A aprovação visual anterior era insuficiente; o lint não enxerga texto dentro de imagens. A correção permanece em todas as cenas: **janela de captura de 1920×810 e legenda fora dela**, sem gradiente sobre controles. O encerramento atual também conserva o título Performance da IA, além dos rótulos e números.

Na revisão de 16/10, a inspeção da primeira contact sheet detectou outra falha: o plano de transferência humana ainda mostrava o card Comportamento, porque a fonte deixara os termos fora do viewport. A coleta foi corrigida para aguardar os controles carregados, centralizar o título com rolagem instantânea e exigir posição abaixo de 750 px. O still corrigido foi aberto: **falar com humano, atendente, pessoa real, agendar e marcar** aparecem sem alteração de configuração. A correção não se limitou a trocar a descrição do plano; a fonte foi recapturada para regenerar o MP4.

As duas respostas da IA foram recentradas para caberem inteiras; a extração foca e-mail e mensagem-fonte; a memória não confunde o card de Meta Ads com qualificação; o histórico de João não é substituído pelo histórico antigo local de Karina. A cena 6 separa 4,5 s de auditoria de produção e 9 s de vídeo local. A abertura perdeu apenas 0,5 s, fechando a montagem em 60 s.

Foram usados `scripts/render.mjs`, `scripts/look.py` e `scripts/lint.mjs` da skill MotionMaxxing. `Motion.selfTest` está incorporado para busca temporal determinística; não equivale a teste funcional do aplicativo.

## Limitações e melhoria prioritária

A saída FullHD não transforma o Kanban antigo em gravação nativa 1080p. Há ampliação de raster, especialmente nos detalhes de ator e confiança. As linhas principais estão em closes; parágrafos longos secundários podem sair pelas bordas, sem promessa de leitura integral. A inspeção foi feita nas imagens exportadas, **não em projetor físico**.

Os recursos retratados como produção foram publicados antes da recaptura de 16/10. A limitação remanescente é a origem histórica da **filmagem**, não uma suposta pendência de deploy desses recursos. O wizard é uma captura anterior, datada de 15/10; a auditoria de produção é estática. A sequência de follow-up está inativa e seu histórico está vazio: nenhuma entrega externa foi comprovada pelo filme.

O diagnóstico antigo de navegação local em spinner fica em `source/branch/diagnostico-navegacao.png`, fora da montagem. A coleta posterior por links SPA concluiu; isso não é correção do app nem prova de que todo hard reload esteja saudável.

Melhoria prioritária: gravar o próximo avanço genuíno em 1920×1080 **quando existir evento de negócio que satisfaça os critérios**, sem afrouxar política. Antes da apresentação presencial, ensaiar no projetor real para calibrar contraste e tempo de leitura. Áudio só deve ser acrescentado com chave/autorização e roteiro revisado; sua ausência aqui é deliberada.

## Plano A/B

O **Plano A** é demonstrar o produto publicado ao vivo. Se login, rede, navegação ou serviço de IA falhar, o **Plano B — capturas reais e vídeos desta pasta — substitui a demo ao vivo**, reproduzido localmente. O apresentador deve distinguir a captura de histórico em produção da gravação anterior de homologação; nenhuma delas deve ser anunciada como execução naquele instante.

## Inspeção visual dos frames finais

As folhas foram extraídas **do MP4 final corrigido**, não apenas do HTML. Abri as quatro contact sheets, todas as sete folhas por segundo, a sheet automática de 16 quadros e os detalhes FullHD de transferência, modalidades, auditoria e dashboard. A inspeção confirmou um foco principal por plano, títulos/valores necessários dentro da janela e procedência fora da interface. Parágrafos secundários longos podem continuar fora do recorte.

| Folha aberta | Frames / tempos | Verificação por olho |
|---|---|---|
| `contact-sheet-1.jpg` | 01–09 · 0,85–15,25 s | Nicho aplicado, assistente, prompt, playground e controles. Em **10,50 s**, título e cinco palavras reais de transferência estão legíveis; o enquadramento incorreto foi substituído pela recaptura. |
| `contact-sheet-2.jpg` | 10–18 · 16,75–32,25 s | Três modalidades com Sempre em texto; Simulação/IA pausada; dois blocos completos da IA; e-mail/fonte; perfil; 85%/9 mensagens; card de produção e auditoria. **Movido pela IA**, Conflito detectado, Novo Paciente → Em Atendimento e 100% permanecem visíveis. |
| `contact-sheet-3.jpg` | 19–27 · 35,85–52,00 s | Gravação local antes/depois, ator IA e confiança; quatro modos; 80%; alerta de prazo de Elisa; sequência inativa e condição de 24h. A legenda de homologação não é confundida com a de produção. |
| `contact-sheet-4.jpg` | 28–30 · 54,00–58,75 s | João Farias com Nenhuma execução registrada; 16 negócios ativos; painel da IA com 1 auto-avanço e 0 sugestões pendentes. Título Performance da IA e rótulos preservados acima da margem. |

No FullHD de **32,25 s**, a transição de produção e a confiança estão inteiras; Pausar IA e Desfazer movimento são apenas controles visíveis, não ações executadas. No FullHD de **58,75 s**, Performance da IA, Aguardando humano, Taxa de aprovação, Auto-avanços e Sugestões pendentes não são cobertos pela legenda. As descrições secundárias podem sair do close.

### Revisão em intervalos de um segundo

Foram abertos **60 frames, de 0,50 s a 59,50 s**, nas folhas abaixo. Não houve quadro vazio nem legenda sobre pixels da interface.

| Folha aberta | Tempos | Conferência visual |
|---|---|---|
| `review-1s/sheet-1.jpg` | 0,50–8,50 s | Nicho, template aplicado, assistente, prompt e área de teste. |
| `review-1s/sheet-2.jpg` | 9,50–17,50 s | Transferência corrigida, 3000/3/1500, modalidades com aviso ElevenLabs e entrada da conversa. |
| `review-1s/sheet-3.jpg` | 18,50–26,50 s | Simulação explícita, dois blocos da IA, e-mail/fonte, perfil consolidado e qualificação. |
| `review-1s/sheet-4.jpg` | 27,50–35,50 s | Qualificação, três closes de produção e mudança explícita para a gravação histórica local. |
| `review-1s/sheet-5.jpg` | 36,50–44,50 s | Mariana na coluna de destino, auditoria local e quatro modos de autonomia. |
| `review-1s/sheet-6.jpg` | 45,50–53,50 s | Confiança 80, alerta de prazo, sequência inativa, 24h e entrada do histórico vazio. |
| `review-1s/sheet-7.jpg` | 54,50–59,50 s | Histórico real, 16 negócios ativos e painel final com dados fictícios explícitos. |

A sheet automática do Kanban e `reports/kanban/gif-sheet.png`, com quadros decodificados do GIF, também foram abertas. Coluna anterior, coluna de destino e auditoria permanecem legíveis após a redução para 960×540. O entorno de outras colunas é contexto da mesma ação, não uma segunda narrativa.

## Reprodução e fronteira de arquivos

Runtime e ferramentas de mídia ficam nesta pasta ou na skill. O `package.json` do frontend não foi alterado. Nesta regeneração não houve mudança de código do app, commit, push, deploy, alteração em `supabase/functions/**`, formatador, linter ou suíte de testes do projeto.

**Registro da rodada anterior:** por solicitação explícita do coordenador, houve formatação somente de `scripts/imersao-clinica-ft/capture-screenshots.mjs`, `node --check` e captura isolada em `/tmp/check-default`. O resultado registrado foi 1/1 telas, dashboard 1440×900; nenhuma opção de viewport foi acrescentada. `reports/capture-default.json` preserva essa evidência histórica; o teste não foi repetido nesta regeneração.

Comandos de mídia, a partir da raiz do repositório, com as fontes já liberadas e inspecionadas:

```sh
node artifacts/imersao-clinica-ft/motion/build-scenes.mjs
node artifacts/imersao-clinica-ft/motion/freeze-production-sources.mjs
node ~/.claude/skills/motionmaxxing/scripts/render.mjs artifacts/imersao-clinica-ft/motion/scenes/index.html artifacts/imersao-clinica-ft/apresentacao/aceleraflow-clinica-ft.mp4 --crf 17
mv artifacts/imersao-clinica-ft/apresentacao/aceleraflow-clinica-ft.mp4.events.json artifacts/imersao-clinica-ft/motion/
node artifacts/imersao-clinica-ft/motion/audit-motion.mjs final
python3 artifacts/imersao-clinica-ft/motion/make-sheet.py ../apresentacao/aceleraflow-clinica-ft.mp4
python3 artifacts/imersao-clinica-ft/motion/make-sheet.py ../apresentacao/aceleraflow-clinica-ft.mp4 --every-second
node artifacts/imersao-clinica-ft/motion/check-captions.mjs
node artifacts/imersao-clinica-ft/motion/verify-delivery.mjs
```

O render grava `<vídeo>.events.json` ao lado do MP4; o `mv` devolve esse registro para `motion/`, onde `audit-motion.mjs` o lê, e mantém `../apresentacao/` só com material de apresentação. O argumento de `make-sheet.py` é relativo a `motion/`.

`scenes/06-kanban.html` é a cena mista de 13,5 s do filme. **`scenes/kanban-recording.html`** é a composição de 9 s que gera o curto; `audit-motion.mjs kanban` verifica esse arquivo. Nenhuma dependência de renderização foi instalada no frontend.

O GIF leve deriva do MP4 curto:

```sh
ffmpeg -v warning -y -i artifacts/imersao-clinica-ft/apresentacao/kanban-auto.mp4 -filter_complex '[0:v]fps=8,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle' -loop 0 artifacts/imersao-clinica-ft/apresentacao/kanban-auto.gif
```
