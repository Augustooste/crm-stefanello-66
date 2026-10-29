# Material da apresentação — Imersão Clínica FT

Esta pasta tem **somente** o que é usado na imersão. Tudo mostra o workspace de demonstração **Clínica FT | Demonstração Imersão**, com **dados fictícios**.

- App ao vivo: <https://aceleraflow-remix.lovable.app> (login em `/auth`)
- Roteiro do que clicar e falar: [`04-ROTEIRO-APRESENTACAO.md`](04-ROTEIRO-APRESENTACAO.md) (nesta pasta)
- O que fazer se algo falhar: [`05-CONTINGENCIA.md`](05-CONTINGENCIA.md) (nesta pasta)

---

## Como usar

**Plano A — app ao vivo:** apresente direto no link acima, seguindo o roteiro. Use as imagens desta pasta só como apoio.

**Plano B — se o app, a internet ou uma integração falhar:**

1. Passe as 17 imagens de `telas/`, na ordem dos nomes (01, 02, 02b, 02c, 03 … 09, 09b, 10).
2. Na etapa do Kanban, mostre `kanban-auto.mp4` (ou `kanban-auto.gif` no slide).
3. Feche com o vídeo `aceleraflow-clinica-ft.mp4`, ou use o vídeo inteiro no lugar das imagens.

---

## O que é cada arquivo

### Vídeos

| Arquivo                      | Formato                  | O que mostra                                                                                                                                                                                                 |
| ---------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `aceleraflow-clinica-ft.mp4` | 1920×1080, 60 s, sem som | A jornada completa em 9 cenas: onboarding, configuração da IA, comportamento, WhatsApp, ficha do cliente, Kanban, autonomia, follow-up e dashboard. Cada cena tem uma legenda dizendo de onde veio a imagem. |
| `kanban-auto.mp4`            | 1920×1080, 9 s           | O card da Mariana Lopes sendo movido sozinho pela IA, de Qualificado para Avaliação Agendada, com o painel de auditoria. Gravado no ambiente de homologação.                                                 |
| `kanban-auto.gif`            | 960×540, 9 s             | O mesmo clipe em GIF, leve para colocar em slide.                                                                                                                                                            |

### `telas/` — capturas do app em produção (1440×900)

| Arquivo                           | Etapa                 | O que mostra                                                                                                                                             |
| --------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-onboarding.png`               | 1. Onboarding         | Workspace já configurado, com o funil odontológico de 7 estágios.                                                                                        |
| `02-configuracao-ia.png`          | 2. Configuração da IA | Prompt base da assistente e modo de envio (Automático ou Rascunho para aprovação).                                                                       |
| `02b-prompts-e-transferencia.png` | 2. Configuração da IA | Estágio "Em Atendimento": objetivo, prompt do estágio, critérios de avanço e as palavras que transferem a conversa para humano.                          |
| `02c-playground.png`              | 2. Configuração da IA | Área de teste (playground) da IA: simula a conversa sem enviar nada por WhatsApp.                                                                        |
| `03-comportamento-ia.png`         | 3. Comportamento      | Até 3 blocos por resposta, 1500 ms entre blocos, 3000 ms de agrupamento e as opções Sempre em texto, Espelhar o cliente e Sempre em áudio.               |
| `04-whatsapp-chat.png`            | 4. WhatsApp           | Conversa da Mariana no **canal Simulação**: respostas reais da IA, transferência para humano e resposta da recepção. Nada foi entregue em WhatsApp real. |
| `05-ficha-cliente.png`            | 5. Ficha do cliente   | Informações que a IA extraiu da conversa da Mariana (e-mail, canal, cidade, serviço, período), cada uma com confiança e mensagem de origem.              |
| `05b-qualificacao.png`            | 5. Ficha do cliente   | Qualificação por IA: 85% de confiança com base em 9 mensagens, resumo, dimensões, abordagem e próximo passo.                                             |
| `06-kanban-automatico.png`        | 6. Kanban             | Funil com os negócios da Clínica FT por estágio.                                                                                                         |
| `07-autonomia-aprovacao.png`      | 7. Autonomia          | Regra Em Atendimento → Qualificado em modo Autônomo com confiança mínima de 80%, com a lista dos quatro modos aberta.                                    |
| `07b-autonomia-agente.png`        | 7. Autonomia          | Agente de pipeline ligado, explicação dos quatro modos e contadores (1 movimento automático, 4 bloqueados).                                              |
| `07c-fila-decisoes.png`           | 7. Autonomia          | Fila de decisões da IA aguardando aprovação (prazos, riscos e oportunidades).                                                                            |
| `08-followup-automatico.png`      | 8. Follow-up          | As 3 sequências e os passos da "Reativação de Proposta Parada" com as regras de tempo (primeira janela de atendimento; aguarda 72h).                     |
| `08b-followup-regras.png`         | 8. Follow-up          | Gatilho da sequência: negócio parado há 7 dias na etapa Proposta.                                                                                        |
| `09-dashboard.png`                | 9. Dashboard          | Visão Geral em "Últimos 90 dias": prioridade do dia, 4 KPIs comerciais e Saúde da Carteira com LTV médio de R$ 1.550.                                    |
| `09b-performance-mensagens.png`   | 9. Dashboard          | Card Performance de Mensagens com os 4 indicadores alinhados (71 mensagens, 26 contatos, 4 min, 100%) e Performance da IA.                               |
| `10-kanban-auditoria-ia.png`      | Extra                 | Painel "Decisão da IA no funil": card movido pela IA de Novo Paciente para Em Atendimento, 3 de 3 critérios cumpridos, confiança de 100%.                |

### `onboarding/` — os 8 passos reais do wizard

Capturados em produção em 15/10/2026, quando o workspace foi criado. Use para mostrar o onboarding sem refazer o wizard.

| Arquivo        | Passo                                          |
| -------------- | ---------------------------------------------- |
| `01-passo.png` | Preparar o ambiente                            |
| `02-passo.png` | Empresa (nome do workspace)                    |
| `03-passo.png` | Nicho (modelo "Clínica odontológica" aplicado) |
| `04-passo.png` | Canais                                         |
| `05-passo.png` | Perfil do negócio (especialidades e horário)   |
| `06-passo.png` | Equipe                                         |
| `07-passo.png` | Contatos                                       |
| `08-passo.png` | Rotinas automáticas                            |

---

## O que dizer para não prometer o que não aconteceu

- **Dados:** "Os pacientes, mensagens e valores são fictícios, preparados para a demonstração."
- **WhatsApp:** "Esta conversa usa o canal Simulação. As respostas são da IA de verdade, mas nada foi enviado a um telefone real."
- **Kanban no vídeo:** os primeiros segundos mostram o registro **real de produção** da IA movendo o card. A animação seguinte foi **gravada no ambiente de homologação**, porque a movimentação de produção não foi filmada. A legenda do vídeo indica isso.

## Cuidados no app ao vivo

- Escolha **"Últimos 90 dias"** no filtro de período do topo para ver todos os dados (vale na hora, sem recarregar).
- **Não clique em "Ativar rotinas" nem em "Pausar":** a conta de demonstração é operadora da plataforma e esses botões afetam todos os clientes.
- Troque a senha da conta de demonstração depois da imersão.

## Ao copiar para outro computador

Copie esta pasta `apresentacao/` inteira. Os vídeos e o GIF **não estão no Git**: existem só no computador onde foram gerados.
