# Imersão Clínica FT — guia dos arquivos

Esta pasta reúne todo o material visual da demonstração do AceleraFlow para a imersão da **Clínica FT** (clínica odontológica fictícia). Tudo o que aparece nas imagens e vídeos é de um workspace de demonstração com **dados fictícios**.

- App em produção: <https://aceleraflow-remix.lovable.app> (login em `/auth`)
- Workspace: **Clínica FT | Demonstração Imersão**
- Documentação escrita (roteiro, contingência, validação): `../../docs/imersao-clinica-ft/`

---

## 1. Comece por aqui: a pasta `apresentacao/`

Tudo o que você vai mostrar na imersão está em **`apresentacao/`**. Antes, leia o roteiro `../../docs/imersao-clinica-ft/04-ROTEIRO-APRESENTACAO.md` (o que clicar e falar) e deixe aberto `../../docs/imersao-clinica-ft/05-CONTINGENCIA.md` (o que fazer se algo der errado).

Na ordem em que entram na apresentação:

| Ordem | Arquivo em `apresentacao/`                               | Quando usar                                                                                                                               |
| ----- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `onboarding/01-passo.png` … `08-passo.png`               | Etapa 1 do roteiro: os 8 passos reais do wizard de onboarding, sem refazer o wizard no workspace já populado.                             |
| 2     | `telas/01-onboarding.png` … `10-kanban-auditoria-ia.png` | Etapas 1 a 9: **17 capturas da produção atual** (etapas 2, 5, 7, 8 e 9 têm complementos `b`/`c`), para slides ou se o app ao vivo falhar. |
| 3     | `kanban-auto.mp4` ou `kanban-auto.gif`                   | Etapa 6: clipe curto (9 s) do card do Kanban sendo movido pela IA. O GIF é a versão leve para slides.                                     |
| 4     | `aceleraflow-clinica-ft.mp4`                             | **Vídeo principal** (60 s, 1920×1080, sem som) com as 9 etapas da jornada. Use como Plano B se o app ao vivo falhar.                      |

**Plano A:** apresentar o app ao vivo em produção. **Plano B:** usar as capturas de `apresentacao/telas/` e o vídeo principal.

---

## 2. Mapa da pasta

```text
artifacts/imersao-clinica-ft/
├── README.md                          ← este guia
├── apresentacao/                      ← TUDO o que se usa na imersão (abra só esta)
│   ├── aceleraflow-clinica-ft.mp4     ← vídeo principal
│   ├── kanban-auto.mp4                ← clipe do Kanban
│   ├── kanban-auto.gif                ← mesmo clipe em GIF
│   ├── telas/                         ← 17 capturas ATUAIS da produção
│   └── onboarding/                    ← 8 passos reais do wizard de onboarding
│
│   Bastidores (não precisa abrir):
├── screenshots/                       ← relatórios técnicos da captura de produção (resultado*.json)
├── screenshots-pre-deploy/            ← capturas antigas, antes da publicação (histórico)
├── screenshots-branch-local/          ← capturas do ambiente de homologação local (histórico)
├── motion/                            ← material de trabalho do vídeo (MotionMaxxing)
├── kanban-auto.gif                    ← gravação original do Kanban (homologação)
├── kanban-auto.json                   ← dados da gravação acima
├── prod-simulation-enrichment.json    ← provas da conversa simulada em produção
├── prod-pipeline-audit-capture.json   ← provas da auditoria do Kanban em produção
├── local-pipeline-agent-proof.json    ← prova local da movimentação automática
└── local-followup-proof.json          ← prova local do follow-up automático
```

---

## 3. O que tem em `apresentacao/`

### Vídeos e GIF

| Arquivo                      | Formato                  | O que é                                                                                                                                |
| ---------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `aceleraflow-clinica-ft.mp4` | 1920×1080, 60 s, sem som | Vídeo principal com as 9 cenas. Cada cena tem uma legenda dizendo a origem: "Captura real · produção" ou "Captura real · homologação". |
| `kanban-auto.mp4`            | 1920×1080, 9 s           | Clipe do card da Mariana avançando de Qualificado para Avaliação Agendada, movido pela IA, gravado no ambiente de homologação.         |
| `kanban-auto.gif`            | 960×540, 9 s, 4,9 MB     | Mesmo clipe em GIF, leve para slides.                                                                                                  |

**Sobre a cena do Kanban no vídeo:** os primeiros 4,5 s mostram a auditoria **real de produção** (card movido pela IA). Os 9 s seguintes são a gravação feita na **homologação**, porque a movimentação de produção não foi filmada. A legenda deixa isso claro.

### `telas/` — capturas da produção atual

Capturadas em **1440×900** no app publicado, logado na conta de demonstração, depois da publicação de 16/10/2026. Cada arquivo corresponde a uma etapa da jornada.

| Arquivo                      | Etapa                 | O que mostra                                                                                                                                          |
| ---------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-onboarding.png`          | 1. Onboarding         | Workspace já configurado pelo wizard: funil odontológico com 7 estágios.                                                                              |
| `02-configuracao-ia.png`     | 2. Configuração da IA | Prompt base da assistente e prompts por estágio.                                                                                                      |
| `03-comportamento-ia.png`    | 3. Comportamento      | Card "Comportamento das respostas": máximo de blocos, intervalo entre blocos, janela de agrupamento e formato (texto, espelhar o cliente, áudio).     |
| `04-whatsapp-chat.png`       | 4. WhatsApp           | Conversa da Mariana Lopes no **canal Simulação** (não entregue no WhatsApp): respostas reais da IA, transferência para humano e resposta da recepção. |
| `05-ficha-cliente.png`       | 5. Ficha do cliente   | Ficha da Mariana: informações extraídas pela IA (com a mensagem de origem), memória, resumos e qualificação.                                          |
| `06-kanban-automatico.png`   | 6. Kanban             | Funil com os negócios da Clínica FT por estágio.                                                                                                      |
| `07-autonomia-aprovacao.png` | 7. Autonomia          | Política de autonomia com confiança mínima de 80% e a fila de decisões.                                                                               |
| `08-followup-automatico.png` | 8. Follow-up          | As 3 sequências de acompanhamento automático.                                                                                                         |
| `09-dashboard.png`           | 9. Dashboard          | Indicadores comerciais e de automação da IA.                                                                                                          |
| `10-kanban-auditoria-ia.png` | Extra                 | Painel "Decisão da IA no funil": card movido pela IA de Novo Paciente para Em Atendimento, 3/3 critérios, confiança 100%.                             |

O relatório técnico dessas capturas (rota, resolução, verificação) fica fora, em `screenshots/resultado.json` e `screenshots/resultado-dashboard.json`.

### `onboarding/` — os 8 passos reais do wizard

Executado em produção em 15/10/2026, na criação do workspace (1920×965):

| Arquivo        | Passo do wizard                                |
| -------------- | ---------------------------------------------- |
| `01-passo.png` | Preparar o ambiente                            |
| `02-passo.png` | Empresa (nome do workspace)                    |
| `03-passo.png` | Nicho (modelo "Clínica odontológica" aplicado) |
| `04-passo.png` | Canais                                         |
| `05-passo.png` | Perfil do negócio (especialidades e horário)   |
| `06-passo.png` | Equipe                                         |
| `07-passo.png` | Contatos                                       |
| `08-passo.png` | Rotinas automáticas                            |

> Os 3 arquivos `.mp4`/`.gif` de `apresentacao/` **não estão no Git** (estão só nesta máquina). As capturas de `telas/` e `onboarding/` estão no Git. Para apresentar em outro computador, copie a pasta `apresentacao/` inteira.

---

## 4. Pastas de histórico (não precisa abrir)

### `screenshots/`

Só os relatórios técnicos (`resultado.json`, `resultado-dashboard.json`) da captura de produção cujas imagens estão em `apresentacao/telas/`.

### `screenshots-pre-deploy/`

As mesmas 9 etapas capturadas **antes** de as funções novas serem publicadas (15/10/2026). Ficam guardadas só para comparação. **Não use na apresentação**: mostram a versão antiga.

### `screenshots-branch-local/`

As 9 etapas capturadas no **ambiente de homologação local** (computador de desenvolvimento), onde as funções foram testadas antes da publicação. Têm mais decisões da IA registradas que a produção. Servem como evidência de teste.

---

## 5. `motion/` — bastidores do vídeo (não precisa abrir)

Usados para montar e verificar os vídeos de `apresentacao/`. Ficam aqui para que eles possam ser refeitos.

| Item                                            | O que é                                                                                                                                                                     |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STORYBOARD.md`                                 | Roteiro das 9 cenas: tempo de cada uma e de onde veio cada imagem.                                                                                                          |
| `NOTE.md`                                       | Origem de cada elemento, resultados das verificações de qualidade, limitações e comandos para refazer os vídeos.                                                            |
| `scenes/`                                       | As 9 cenas em HTML (`01-onboarding.html` … `09-dashboard.html`), `index.html`, `kanban-recording.html` e a configuração (`plan.json`, `composition.js`, `composition.css`). |
| `source/prod/`                                  | Capturas de produção em 1920×1080 usadas nas cenas.                                                                                                                         |
| `source/branch/` e demais arquivos de `source/` | Fontes da homologação e da gravação do Kanban.                                                                                                                              |
| `draft.mp4`                                     | Rascunho antigo do vídeo, em baixa resolução. **Não usar.**                                                                                                                 |
| `contact-sheet-1.jpg` … `contact-sheet-4.jpg`   | Folhas com miniaturas do vídeo, usadas na revisão visual.                                                                                                                   |
| `review-1s/`, `stills/`, `hero-stills/`         | Quadros extraídos do vídeo para inspeção.                                                                                                                                   |
| `reports/`                                      | Relatórios dos verificadores do MotionMaxxing (`look.py`, `lint.mjs`) e da aceitação final.                                                                                 |
| `runtime/`                                      | Biblioteca de animação usada pelas cenas.                                                                                                                                   |
| `*.mjs`, `make-sheet.py`                        | Scripts de captura, montagem e verificação do vídeo.                                                                                                                        |
| `*.events.json`                                 | Registro técnico de cada renderização.                                                                                                                                      |

> `draft.mp4` e o conteúdo pesado de trabalho (imagens e vídeos de `source/`, `runtime/`, `review-1s/`, `stills/`, `hero-stills/`) **não estão no Git**; ficam só nesta máquina.

---

## 6. Arquivos soltos na raiz

| Arquivo                            | O que é                                                                                                                                        |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `kanban-auto.gif`                  | Gravação original (1440×900, 8,4 s) do card da Mariana sendo movido pela IA no ambiente de homologação. É a fonte do clipe em `apresentacao/`. |
| `kanban-auto.json`                 | Dados dessa gravação: estágio de origem, de destino e auditoria.                                                                               |
| `prod-simulation-enrichment.json`  | Provas da conversa simulada em produção: mensagens enviadas, respostas da IA, transferência para humano e informações extraídas pela IA.       |
| `prod-pipeline-audit-capture.json` | Provas da movimentação automática em produção: negócio, critérios cumpridos e confiança.                                                       |
| `local-pipeline-agent-proof.json`  | Prova, no ambiente local, de que a IA move o card sozinha quando os critérios são cumpridos.                                                   |
| `local-followup-proof.json`        | Prova, no ambiente local, de que o follow-up automático executa, pausa e cancela corretamente.                                                 |

---

## 7. Cuidados

- **Dados fictícios:** Mariana Lopes e os demais pacientes não existem. Os telefones e e-mails são de teste.
- **Simulação:** a conversa usa o canal Simulação. Nenhuma mensagem foi entregue em um WhatsApp real.
- **Período:** no app, escolha "Últimos 90 dias" no filtro do topo para ver todos os dados de demonstração (vale na hora, sem recarregar).
- **Rotinas globais:** a conta de demonstração é operadora da plataforma. Não clique em "Ativar rotinas" nem em "Pausar", porque isso afeta todos os clientes.
- **Senha:** troque a senha da conta de demonstração depois da imersão.
