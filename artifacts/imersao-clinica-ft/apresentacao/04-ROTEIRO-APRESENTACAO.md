# Roteiro ao vivo: Clínica FT

> Cópia para levar junto com esta pasta. Original (mesmo conteúdo): `docs/imersao-clinica-ft/04-ROTEIRO-APRESENTACAO.md`. Se editar, edite o original e copie de novo.

Abra `https://aceleraflow-remix.lovable.app/auth` e entre na conta `engmtgg@gmail.com` sem compartilhar a tela de autenticação.

**Fluxo PUBLICADO em 16/10/2026.** A jornada principal usa comportamento, simulador, extração e agente de pipeline em produção. A narrativa acompanha **Mariana Lopes**, personagem fictícia interessada em avaliação odontológica. A Mariana da conversa simulada é uma identidade nova, distinta da Mariana do seed. Provas e limites estão em [03-VALIDACAO.md](../../../docs/imersao-clinica-ft/03-VALIDACAO.md).

## Preparação antes de compartilhar a tela

1. Confirme o nome **Clínica FT | Demonstração Imersão** no app. Não use `aceleraflow.aceleraia.ai`, que pertence a outro projeto.
2. Abra as abas `/app`, `/configuracoes`, `/inbox`, `/contatos`, `/pipeline`, `/decisions` e `/nurture` no mesmo domínio. No filtro de período do topo, selecione **Últimos 90 dias** (vale na hora para todas as telas, sem recarregar): a conversa da Mariana (16/09) fica fora da janela padrão de 30 dias a partir de 16/10/2026. Os dados MOCK têm datas fixas e envelhecem; perto da imersão, confira se a janela de 90 dias ainda os cobre.
3. Deixe acessíveis `artifacts/imersao-clinica-ft/apresentacao/` (subpastas `onboarding/` e `telas/`, vídeo principal e clipe do Kanban), `screenshots-branch-local/` e `kanban-auto.gif`.
4. Preserve as rotinas globais. **A conta demo é operadora da plataforma**, então os controles **Ativar**/**Pausar** ficam visíveis para ela e afetam os 17 tenants — **não clique neles** durante a demo. Os crons de pipeline e enriquecimento já estão ativos, com opt-in somente da Clínica FT.
5. Diga antes da jornada: “Os pacientes, mensagens e valores são fictícios. A IA responde e extrai dados de verdade em produção pelo simulador, sem envio externo. O GIF é uma prova local de apoio, não uma gravação de produção.”

Fontes operacionais: atualização verificada pelo integrador em 16/10/2026 e [03-VALIDACAO.md](../../../docs/imersao-clinica-ft/03-VALIDACAO.md); histórico em `local://imersao-evidencias.md`. Rotas, abas e rótulos documentados em `e2e/imersao-clinica-ft/jornada-helpers.mjs` e nos relatórios `CapturaE2E`/`AmbienteLocalDemo`.

## 1. Onboarding

**Clique:** `/configuracoes` → **Empresa**. Mostre **Nome da empresa**. Abra as oito capturas `apresentacao/onboarding/01-passo.png` até `08-passo.png`; volte ao app e mostre o funil em `/pipeline`.

**Diga:** “A clínica foi configurada pelo wizard real de oito passos. O template odontológico aplicou o prompt base, os prompts de estágio e um funil de sete etapas. Para preservar os dados, estou mostrando a execução registrada e o estado que ela deixou.”

**Não afirme:** que a captura `01-onboarding.png` é uma nova execução do wizard. Não resete o onboarding, não reaplique o template e não altere `onboarded_at`. Moeda, idioma e fuso não têm campos no wizard; o app usa os padrões BRL, pt-BR e America/Sao_Paulo.

**Evidência:** `local://imersao-evidencias.md`, Onboarding; oito PNGs em `apresentacao/onboarding/`. O seed renomeou Triagem para **Em Atendimento** e Orçamento Enviado para **Proposta** depois do wizard.

## 2. Configuração da IA

**Clique:** `/configuracoes` → **IA** → **Assistente** → **Configuração**. Mostre **Prompt base do assistente**, os modos **Automático** e **Rascunho para aprovação**. Abra **Em Atendimento** para mostrar **Objetivo do estágio** e **Prompt do estágio**. Não salve alterações durante a demo.

**Diga:** “O assistente recebe as regras da clínica e o objetivo de cada etapa. O editor guarda o template; o nome da empresa é aplicado quando o prompt é usado. Mariana quer avaliação, não diagnóstico ou promessa de tratamento.”

**Não afirme:** que os prompts por estágio foram criados nesta branch; a UI já existia. A presença de um seletor de rascunho não prova que uma aprovação humana foi executada nesta apresentação.

**Evidência:** E2E F2 e `apresentacao/telas/02-configuracao-ia.png`; cinco configurações de estágio persistidas no onboarding.

## 3. Comportamento das respostas

**Clique:** `/configuracoes` → **IA** → **Assistente** → **Configuração** → **Comportamento das respostas**. Mostre a configuração publicada: máximo de **3 blocos**, intervalo de **1500 ms** e agrupamento de **3000 ms**. Preserve os valores preparados e use texto.

**Diga:** “Estas preferências pertencem à Clínica FT. Três é o limite de blocos, não uma quantidade obrigatória. Na prova de produção, a IA respondeu em dois blocos.”

**Não afirme:** que os intervalos garantem latência ou que houve prova de áudio real. STT/TTS externo não foi validado nesta missão.

**Evidência:** F3 pós-deploy valida o card em produção; ativação às 14:25:53 UTC e resposta real em dois blocos, conforme [03-VALIDACAO.md](../../../docs/imersao-clinica-ft/03-VALIDACAO.md).

## 4. Conversa da Mariana pelo simulador

**Clique:** `/configuracoes` → **Integrações** → **Canal de demonstração** para mostrar o canal Simulação já criado (`af9d157e-bc0d-4ca3-a471-6dbf11ba2111`). Em `/inbox`, abra a conversa simulator preparada. Para uma entrada nova, use **Mensagem do cliente simulado** → **Enviar como cliente**. Se usar **Nova simulação**, ela criará outra identidade/conversa; não reutiliza automaticamente a Mariana do seed.

**Diga:** “Esta Mariana é uma personagem em uma nova simulação. A mensagem entra como cliente simulado e a IA de produção responde de verdade, sem enviar a um telefone.”

Para continuar a conversa, use intenção fictícia de avaliação, Campinas, terça/quinta após 18h e orçamento demonstrativo. **Antes de enviar, confirme que a IA está ativa naquela conversa**: a conversa preparada ficou com a IA pausada após a transferência humana (`ai_active=false`), e sem reativá-la uma nova mensagem não gera resposta. Reative a IA na conversa (ou abra uma nova simulação com IA ativa) e então aguarde a resposta real, sem repetir a mensagem para forçar processamento. O histórico MOCK continua disponível pela busca `Mariana Lopes`, com **Últimos 90 dias** e recarregamento; identifique-o como histórico, não como resposta ao vivo.

**Não afirme:** que Mariana é paciente real, que existe WhatsApp conectado ou que a nova conversa é a ficha do seed. Não conecte os números MOCK a um provedor real.

**Evidência:** mensagem às **14:30:31 UTC**, respostas às **14:30:42 e 14:30:46**, `delivery=simulator`, sem envio externo, em 16/10.

## 5. Ficha do cliente

**Clique:** abra a ficha do contato vinculado à conversa simulator do passo anterior → **Memória IA**. Mostre **Informações extraídas pela IA**, confiança e **Ver mensagem-fonte**. Confira o negócio vinculado antes de mostrar **Qualificação por IA**. Não abra por engano a ficha semeada da outra Mariana.

**Diga:** “O enriquecimento automático desta simulação gerou sete extrações em produção, cinco aplicadas. Cada campo deve ser lido junto com sua fonte. A memória inicial da Mariana do seed é MOCK e não serve como prova de extração.”

**Não afirme:** que todo campo ou resumo da ficha foi gerado agora. Aguarde processamento real antes de mostrar novas saídas; não preencha manualmente para simular extração. A ausência de veredito Meta Ads não significa ausência de qualificação do negócio; são fluxos distintos.

**Evidência:** sete extrações (cinco aplicadas) na prova de produção, em `prod-simulation-enrichment.json`; `contact_auto_enrichment` com `auto_qualify` habilitado. As seis extrações e o resumo de 17 mensagens documentados anteriormente pertencem à prova local.

## 6. Kanban

**Clique:** `/pipeline`. Aponte os estágios **Novo Paciente**, **Em Atendimento**, **Qualificado**, **Avaliação Agendada**, **Proposta**, **Ganho** e **Perdido**. Identifique o negócio elegível relacionado ao caso demonstrado. A Mariana do seed é outra identidade; não arraste seu card para encenar automação.

**Diga:** “O agente de pipeline está publicado e ativo para a Clínica FT. Um avanço depende de evento legítimo novo, negócio elegível e política de autonomia. O cron executa a cada dez minutos, nos minutos 8, 18, 28, 38, 48 e 58; não é uma resposta imediata ao abrir o Kanban.”

Acompanhe movimento e auditoria somente se ocorrerem de verdade. Entregas `pipeline.agent` com status `delivered` provam processamento, não garantem avanço. Não execute `local-pipeline-agent-proof.mjs` contra produção e não fabrique evento para preencher a apresentação.

Se não surgir uma decisão no tempo da demo, abra `kanban-auto.gif` (nesta pasta): “Esta é uma prova local de apoio. O pipeline-agent moveu Mariana para Avaliação Agendada; a auditoria registrou ator IA e confiança de 100%, acima do mínimo de 80%. A espera foi acelerada.”

**Não afirme:** que o GIF veio de produção, que 8,4 segundos é um SLA ou que houve pagamento real. A prova local usa sinal de negócio simulado, confirmação textual e agendamento demonstrativo.

**Evidência:** produção com cron ativo e entregas processadas; `kanban-auto.json` comprova o movimento local com realtime e zero recarregamentos.

## 7. Autonomia e revisão humana

**Clique:** `/decisions` para mostrar o estado da fila. Depois `/pipeline` → **Autonomia** → diálogo **Autonomia do funil**. Mostre **Em Atendimento → Qualificado**, modo **Autônomo**, confiança **80**; mostre que **Proposta → Ganho** permanece assistida.

**Diga:** “A política define quando a IA pode avançar e quando precisa de aprovação humana. O agente está ativo somente para a Clínica FT entre os 17 tenants. A fila de decisões tem itens gerados pela IA — em 16/10 eram 26 pendentes (atividades atrasadas, negócios parados com risco ou oportunidade, SLA). Avanços de estágio que exigem aprovação aparecem na mesma fila; em 16/10 não havia nenhum pendente.”

**Não afirme:** que fila vazia significa ausência de leads ou falha da IA. Não aprove/rejeite registros apenas para encenar uma ação e não altere rotinas globais para preencher a fila.

**Evidência:** E2E F7 pós-deploy; houve intermitência de carregamento numa rodada longa e aprovação 2/2 isolada. As nove decisões de [03-VALIDACAO.md](../../../docs/imersao-clinica-ft/03-VALIDACAO.md) são locais; o total atual de produção precisa ser lido na fila.

## 8. Follow-up

**Clique:** `/nurture`. Abra as sequências **Confirmação de Avaliação Agendada**, **Reativação de Proposta Parada** e **Recall Periódico de Pacientes Finalizados** para mostrar passos e condições. Preserve o estado inativo e as inscrições pausadas.

**Diga:** “As correções de follow-up e o histórico estão publicados. A clínica tem três cadências demonstrativas e dez follow-ups internos do seed. Não vamos disparar mensagens. A prova do runner com envio simulator, pausa e cancelamento foi local.”

**Não afirme:** que recall comprova tratamento finalizado ou que houve novo envio nurture em produção. Reativação por estágio e recorrência não equivalem a uma consulta realizada.

**Evidência:** F8, `local-followup-proof.json` e relatório `FollowupNurtureV2`.

## 9. Dashboard

**Clique:** `/app` → **Últimos 90 dias**. Mostre **Visão Geral**, **Saúde da Carteira**, **Performance de Mensagens** e **Performance da IA (revisão humana)** no app publicado.

**Diga:** “Os números vêm dos registros desta demonstração, não de resultados comerciais reais. A versão publicada filtra por quadro e conta movimentos da IA sem duplicar comandos e aprovações.”

**Não afirme:** receita real, eficácia clínica ou total de decisões não observado. As contagens locais de 4 auto-avanços e 9 decisões não são contagens da produção.

**Evidência:** E2E F9 pós-deploy. As capturas 09 anteriores continuam como apoio histórico; a fonte de cada imagem é seu `resultado*.json`.

## Pendências que não impedem a jornada publicada

- A conta demo já é operadora da plataforma (decisão de 16/10). Pendência de segurança: mover a autoridade de operador para uma conta interna dedicada e trocar a senha da demo.
- Trocar a senha da conta demo após a imersão e rotacionar a chave Gemini do cliente.
- Conferir a idade dos dados MOCK antes da apresentação (janela de 90 dias).

Se o app, a rede ou a IA falhar, abra [05-CONTINGENCIA.md](05-CONTINGENCIA.md). Não resete a Clínica FT para continuar a apresentação.
