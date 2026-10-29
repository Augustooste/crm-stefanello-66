# Clínica FT: configuração, execução e auditoria

## Ideia e direção

**Problema:** uma demonstração ao vivo pode confundir uma regra configurada, um resultado persistido e uma ação filmada.
**Público:** participantes da imersão, diante de uma projeção 16:9, com explicação do apresentador.
**Objetivo:** mostrar o produto publicado e duas provas diferentes, sem misturar os ambientes: o registro de produção **Novo Paciente → Em Atendimento** e a gravação histórica de homologação **Qualificado → Avaliação Agendada**.
**Emoção:** compreender o que a IA fez e quais limites permanecem.

Direção: documentário de interface, usando o azul-safira e a superfície escura do AceleraFlow. Energia 2 / Ritmo 2 / Movimento 2. A câmera aproxima pixels reais, nunca redesenha os controles. Um fragmento domina cada plano. O tempo maior pertence à prova do Kanban; os cortes seguem movimento de câmera com desaceleração curta para leitura. Sem locução, música ou efeitos sonoros por ausência de chave ElevenLabs.

Regeneração pós-deploy de **16/10/2026**: as funcionalidades publicadas usam capturas novas de produção, liberadas por CapturaE2E, e complementos somente leitura. O wizard conserva a execução real de **15/10**, sem reaplicar o template. A gravação de movimento continua histórica e local; “recurso pendente de publicação” foi removido por estar obsoleto, não porque sua origem tenha mudado.

### Alternativas consideradas

1. Tour de nove telas inteiras: rejeitado porque os textos ficariam pequenos e todos os recursos teriam o mesmo peso.
2. Documentário de evidências, com configuração, conversa, governança e auditoria: escolhido para distinguir estado configurado de ação executada.
3. Tipografia sobre resultados: rejeitada porque substituiria a prova por alegações e números isolados.

O teste sem logotipo conserva as mensagens de Mariana, o funil odontológico e os registros de decisão. Esses elementos específicos não podem ser trocados por outro produto sem mudar as provas.

## Mundo visual e herói

A captura ocupa uma janela física de **1920×810**, com `overflow: hidden`. A margem editorial escura abaixo recebe apenas a procedência, sem navegação, relógio, número de cena ou barra de progresso. A legenda não cobre a UI. Profundidade vem da ampliação; não há neon, textura gerada, logotipo redesenhado ou objetos decorativos.

**Herói:** a cena 6. Primeiro, o negócio **Contato Cliente simulado**, vinculado a Mariana, aparece em **Em Atendimento** na produção. Depois, a auditoria mostra **Movido pela IA**, a transição e a confiança. Só então entra a gravação histórica local, com mudança real de coluna e painel de auditoria. A troca de legenda demarca a troca de ambiente. São registros de negócios diferentes, em tenants diferentes, não uma única transação contínua.

Essa cena foi montada primeiro nesta revisão e inspecionada em quatro stills: card de produção, autoria, transição auditada e gravação de homologação. Importância 3 em apenas 1 das 9 cenas.

## Escolha da gravação do Kanban

**Opção A escolhida:** `../kanban-auto.gif`, genuíno, 1440×900 e 8,4 s, preservado em `source/kanban-original.gif`. O MP4 curto amplia os quadros originais com câmera, sem desenhar o movimento do card. A resolução de saída FullHD não é apresentada como resolução nativa da gravação.

A opção B foi descartada na verificação de AmbienteLocalDemo de 15/10, 19:53:10 UTC. **Avaliação Agendada → Proposta** exigia realização confirmada pela recepção e proposta revisada por profissional; a consulta ainda era futura, em 22/10, com status `confirmed`. O evento `payment.approved` não comprova esses critérios. Não se disparou nova execução, não se afrouxou política e não se fabricou evento para obter vídeo.

O registro de produção acrescentado em 16/10 prova outro avanço autônomo já ocorrido. Ele é uma **captura de histórico persistido**, não filmagem da transição.

## Beats, tempos e fontes

Especificação: **60 s / 1800 quadros / 1920×1080 / 30 fps**. Intervalos fechados no início e abertos no fim. As fontes abaixo ficam em `source/prod/`, salvo indicação diferente.

| Cena / tempo / quadros | Papel / importância | Evidência e fonte | Movimento e limite da alegação |
|---|---|---|---|
| 1. Onboarding · 0–4,5 s · 0–134 | Abertura / 2 | `wizard-nicho.png`, cópia de `../apresentacao/onboarding/03-passo.png`; produção em 15/10. | Título do passo Nicho → cartão odontológico Aplicado e descrição do funil com 7 estágios. Não inventa uma etapa separada de edição do funil. |
| 2. Configuração da IA · 4,5–11,5 s · 135–344 | Preparação / 2 | `complemento-assistente-topo.png`, `complemento-02-configuracao-ia.png`, `complemento-playground.png`, `complemento-transferencia-humana.png`. | Um controle por vez: assistente, prompt, área de teste vazia e palavras de transferência. Nenhuma resposta fabricada no playground. |
| 3. Comportamento · 11,5–17,5 s · 345–524 | Preparação / 2 | `complemento-03-comportamento-ia.png`, `complemento-comportamento-modalidades.png`. | Agrupamento 3000 ms → 3 blocos → intervalo 1500 ms → modalidades, com **Sempre em texto** selecionado e aviso ElevenLabs não conectada. |
| 4. WhatsApp · 17,5–22,5 s · 525–674 | Prova / 2 | `complemento-04-whatsapp-chat.png`, `complemento-conversa-blocos-ia.png`. | Identificação de Mariana e Simulação → dois blocos genuínos da IA. O canal não entregou mensagens no WhatsApp. A IA está pausada após transferência; a resposta humana não é atribuída à IA. |
| 5. Ficha · 22,5–28,5 s · 675–854 | Prova / 2 | `complemento-ficha-extracao.png`, `complemento-ficha-memoria.png`, `complemento-ficha-qualificacao.png`. | E-mail extraído e link de mensagem-fonte → perfil consolidado → qualificação de 85% baseada em 9 mensagens. O nome foi definido pela recepção, não extraído pela IA. |
| 6. Kanban · 28,5–42 s · 855–1259 | Prova principal / 3 | `06-kanban-automatico.png`, `10-kanban-auditoria-ia.png` e `kanban-auto.mp4` (em `../apresentacao/`), derivado de `source/kanban-original.gif`. | **28,5–33 s:** card, ator e transição auditada em produção. **33–42 s:** gravação real de homologação, Qualificado → Avaliação Agendada, seguida do painel. Sem arraste, cursor fabricado ou substituição de UI. |
| 7. Autonomia · 42–49 s · 1260–1469 | Governança / 2 | `complemento-autonomia-quatro-modos.png`, `complemento-07-autonomia-aprovacao.png`, `complemento-fila-decisoes.png`. | Manual, Shadow, Assistido e Autônomo → confiança mínima de 80% → alerta real de prazo de Elisa na fila. Não aprova decisão nem confunde alerta de SLA com sugestão de avanço. |
| 8. Follow-up · 49–55 s · 1470–1649 | Consequência / 2 | `complemento-followup-sequencia.png`, `complemento-followup-historico.png`. | Sequência inativa → “Aguarda 24h após o passo anterior” → histórico de João Farias, **Nenhuma execução registrada**. Mostra configuração e histórico real, sem alegar envio ou ativação. |
| 9. Dashboard · 55–60 s · 1650–1799 | Encerramento / 1 | `complemento-09-dashboard.png`, `09-dashboard.png`; últimos 90 dias. | Card com 16 negócios ativos → painel de revisão humana com 1 auto-avanço, 0 sugestões pendentes e taxa de aprovação “—”. Termina no produto, sem end card nem projeção de resultado comercial. |

## Procedência e honestidade em tela

Cada cena publicada traz **“Captura real · produção”**. A abertura e o fechamento acrescentam **“Dados fictícios para demonstração”**. A conversa informa **“Canal Simulação — sem entrega no WhatsApp”**.

No começo da cena 6, a legenda esclarece **“Registro auditado · sem filmagem da transição”**. Ao entrar o vídeo histórico, muda para **“Captura real · homologação / Gravação anterior · avanço real da IA”**. O badge real **Conflito detectado** não é apagado; o filme não inventa uma explicação textual que a UI não mostra.

G1: ampliar a linha necessária, sem exigir leitura da tela inteira. G2: evitar frames vazios e congelamentos. G3: end hold máximo de 1,4 s, sem cartão final. G4: um fragmento principal por plano. G5: manter a procedência mesmo se o lint a questionar; resultados e eventual exceção devem ser registrados em `NOTE.md`. O protocolo inclui `look.py`, `lint.mjs`, contact sheets e inspeção de frames a cada segundo do MP4.

## Plano A/B para a apresentação

O **Plano A** é demonstrar o produto publicado ao vivo. Se login, rede, navegação ou serviço de IA falhar, o **Plano B são as capturas reais e os vídeos desta pasta**, reproduzidos localmente. O Plano B substitui a demo ao vivo, não finge execução naquele instante: a auditoria de produção é um registro persistido e o movimento entre colunas é uma gravação anterior de homologação, explicitamente identificada.
