# Clínica FT: população e limpeza seletiva

Execute primeiro o plano, sem escrita:

```bash
SEED_TARGET=local node scripts/imersao-clinica-ft/seed.mjs --dry-run
```

## 1. Preparação e execução

Requer Node 24, pnpm e stack Supabase local já iniciado. Os scripts não iniciam, param ou resetam o stack; não fazem commit, push ou deploy.

- **Local:** URL e chave pública vêm de `pnpm exec supabase status -o env`. Apenas endereços de loopback são aceitos. A saída do comando fica em memória; nenhuma chave privilegiada é usada.
- **Produção:** `.env.local` da raiz fornece `VITE_SUPABASE_URL` e `VITE_SUPABASE_PUBLISHABLE_KEY`. O host aceito é exclusivamente `dpdtgddkvdgswndzuofv.supabase.co`.
- **Credenciais:** `~/.config/aceleraflow-imersao/credentials.env`, com `CLINICA_FT_EMAIL` e `CLINICA_FT_PASSWORD`. Nunca copiar esse arquivo para o repositório ou imprimir senha/JWT.
- **Proteção:** login real, perfil admin ativo, exatamente um tenant visível e nome exato `Clínica FT | Demonstração Imersão`. A verificação ocorre antes das escritas do CRM. Cada operação usa JWT do usuário, RLS e FKs derivadas do próprio tenant.
- **Automação:** aplicar o seed exige `tenants.ai_enabled=false`. O seed normal não altera essa política, não habilita features e não conecta canais. Isso evita consumir os eventos históricos como tráfego novo.

Para uma conta local ainda inexistente:

```bash
SEED_TARGET=local node scripts/imersao-clinica-ft/seed.mjs --apply --bootstrap-local --report=/tmp/clinica-ft-primeira.json
```

O bootstrap é permitido somente localmente e com `--apply`. Usa signup oficial com o nome esperado, recebe o tenant/admin pelo trigger de Auth, cria o board padrão se necessário e aplica `apply_niche_template` com o template odontológico do catálogo. Não reaplica template sobre negócios existentes. Desativa a IA apenas desse tenant novo e registra o onboarding. Um tenant existente com nome incorreto é recusado, não renomeado silenciosamente.

Reaplicação idempotente:

```bash
SEED_TARGET=local node scripts/imersao-clinica-ft/seed.mjs --apply --report=/tmp/clinica-ft-segunda.json
```

Produção, **somente leitura para planejamento e diagnóstico**:

```bash
SEED_TARGET=prod node scripts/imersao-clinica-ft/seed.mjs --dry-run --report=/tmp/clinica-ft-prod-plano.json
```

`--dry-run` é o padrão; `--dry-run --apply` é recusado. O integrador deve revisar o plano e a segurança dos workers antes de autorizar aplicação em produção. O plano medido encontrou IA habilitada e informa que `--apply` está bloqueado nesse estado. A proteção nova do pipeline/simulador local não é presumida em produção sem deploy.

Posteriormente, o integrador aplicou o cenário em produção com a IA do tenant desligada e a religou para a apresentação. O diagnóstico desta fatia permaneceu somente leitura; não deve desligar novamente a IA nem reaplicar o seed sobre a demonstração ativa.

## 2. Dataset e contrato de idempotência

`dataset.mjs` é o manifesto fechado do cenário `imersao-clinica-ft/seed-v1`. UUID v5 usa o namespace DNS padrão e o nome:

```text
tenant_id|imersao-clinica-ft|seed-v1|tabela|chave-semântica
```

Os IDs não dependem do login, do relógio ou de dados reais. Datas históricas são ancoradas em `2026-10-15T15:00:00.000Z`, com contatos/conversas distribuídos nos 29 dias anteriores. Não mudar essa âncora para atualizar uma demonstração existente: crie outra versão do cenário. Valores são BRL; idioma pt-BR; fuso `America/Sao_Paulo`.

Telefones sintéticos: `+55 11 90000-0001` a `+55 11 90000-0025`; e-mails em `example.com`. Não há CPF, prontuário nem dado clínico real. Esses números são material fictício, não uma afirmação de reserva oficial de numeração: **nunca habilitar um provedor real para enviá-los**.

| Entidade do manifesto               | Quantidade medida localmente |
| ----------------------------------- | ---------------------------: |
| Canal desconectado                  |                            1 |
| Definições de campos                |                            4 |
| Contatos                            |                           25 |
| Conversas                           |                           21 |
| Mensagens                           |                          132 |
| Negócios                            |                           21 |
| Atividades                          |                           16 |
| `deal_followups`                    |                           10 |
| Sequências                          |                            3 |
| Passos                              |                            5 |
| Inscrições legítimas, pausadas      |                            3 |
| Snapshots legítimos de qualificação |                            3 |

Há exatamente **3 negócios em cada um dos 7 estágios**: Novo Paciente, Em Atendimento, Qualificado, Avaliação Agendada, Proposta, Ganho e Perdido. Os 3 ganhos têm fechamento; as 3 perdas têm fechamento e motivo.

### Mariana Lopes

Pergunta sobre serviços, horários e valores; informa terça/quinta após 18h, prefere WhatsApp e aceita o valor demonstrativo de R$ 150 para avaliação, mas ainda não confirma consulta. `custom_fields` e `ai_memory` reproduzem essas mensagens. A memória é identificada como preparada para demonstração, não como saída de consolidação LLM.

Seu negócio nasce em Em Atendimento e avança para Qualificado por `transition_deal_stage`, com JWT admin, ator **human**, evidências dos IDs das mensagens e chave idempotente. Não se forja decisão autônoma, confiança LLM nem histórico retroativo: a RPC registra a data real da revisão. Há follow-up interno para apresentar opções de horário.

IDs locais desta execução:

- Tenant: `977f9af2-d513-44bf-ab95-723345d584fd`; board: `fe8f91dd-744c-58b7-a1f8-a4dbb4b81f87`.
- Contato Mariana: `f4d0a552-f86a-5b33-8272-d48f1b29ef91`.
- Negócio Mariana: `0699d8c5-ab16-5229-906e-9ff0882755e0`.
- Conversa Mariana: `932e9250-69d7-529a-b43d-593ea544e7ea`.

### Configuração preservada

O seed reutiliza o board/IDs dos estágios e renomeia somente `Triagem` para `Em Atendimento` e `Orçamento Enviado` para `Proposta`. Configura objetivos e critérios odontológicos. Nos prompts existentes, substitui apenas as citações dos nomes antigos. As 4 transições progressivas iniciais usam `autonomous` e confiança mínima `0.80`; Proposta → Ganho usa `assisted` e aprovação humana. Não altera políticas globais, reversões, transições para perda, cooldowns ou features de outros tenants. Negócios semeados permanecem com `automation_mode=paused`.

A comparação precede toda mutação: JSON é comparado sem depender da ordem das chaves; timestamps PostgreSQL equivalentes são normalizados; `created_at`/`updated_at` server-managed não geram updates artificiais. Mensagens divergentes são recusadas, nunca sobrescritas. Mudança externa de estágio não é revertida por UPDATE direto.

Depois dos INSERTs de mensagens, os dados históricos/contadores e o estado de handoff das conversas são recompostos. Isso também corrige o efeito do trigger que usa `now()` em `last_message_at`. `awaiting_human_since` não faz parte do payload: o início do SLA pertence ao trigger de abertura do handoff e não deve ser retroagido para a data das mensagens fictícias.

### Nurture sem disparo

As três sequências derivam de `local://seed/sequencias.json`, fornecido pela fatia FollowupNurture: confirmação de avaliação, reativação de proposta e recall periódico. Permanecem **inativas**.

Os textos revisados não pressupõem avaliação no dia da mensagem, atendimento já realizado ou tratamento concluído. A reativação considera os 7 dias desde `stage_entered_at`, não desde a última mensagem; o recall admite primeira inscrição imediata e conta os 90 dias de recorrência desde `completed_at`. A orientação clínica de retorno continua sendo do profissional responsável.

A RPC existente `enroll_manual_nurture_sequence` seleciona a primeira sequência manual ativa; não recebe `sequence_id`. Para cada inscrição ausente, o seed verifica que não há manual ativa alheia, torna somente a própria sequência manual/ativa, inscreve com data futura de 90 dias, pausa pela RPC `set_nurture_enrollment_status` e restaura o gatilho original/inatividade em `finally`. Na reaplicação, inscrições existentes não são recriadas. IDs/datas de inscrições são gerados pelo servidor; o vínculo determinístico é sequência + contato. Nenhum histórico arbitrário é fabricado.

A revisão de conteúdo foi aplicada localmente por PATCH restrito sob JWT admin: **3 `description` + 5 `message_template`**, sem INSERT/RPC. A comparação antes/depois das entidades do dataset, inscrições e tenant confirmou alteração somente em `nurture_sequences`/`nurture_steps`; as 3 sequências permaneceram inativas e as 3 inscrições pausadas. Jobs/envios permaneceram 0 e deliveries 464 → 464. Evidência: `/tmp/clinica-ft-local-nurture-copy-apply.json`.

O plano posterior de produção, `/tmp/clinica-ft-prod-plan-4.json`, contém **somente esses 8 updates**, 0 INSERT e 0 RPC; nenhuma aplicação desta revisão foi feita em produção. Durante a medição, o reconciliador Evolution atualizou `channels.status_message` com o diagnóstico de ausência de credenciais. Esse campo operacional também saiu do manifesto para não disputar a autoridade do reconciliador; `status=disconnected`, marcador e nome demonstrativo em `config` continuam sendo comparados. Fonte: `messaging-channels-reconcile/runner.ts`; leitura real: `/tmp/clinica-ft-prod-channel-diff.json`.

## 3. Evidências e limites de segurança

Execução de 15/10/2026, sob JWT admin local:

| Evidência                                                         | Resultado                                                                                        |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Primeira mensagem via REST                                        | `job_queue`: 0 → 0; tentativas de envio: 0 → 0                                                   |
| Fan-out da primeira mensagem                                      | 50 → 53 deliveries internos; 1 por subscriber                                                    |
| Carga inicial completa                                            | 0 jobs; 0 tentativas de envio; 448 deliveries internos                                           |
| Duas reaplicações finais consecutivas                             | ambas: **0 INSERT, 0 UPDATE, 0 RPC**                                                             |
| Deliveries nas reaplicações finais                                | 464 → 464; nenhum novo delivery                                                                  |
| Plano inicial de produção, antes da aplicação pelo integrador     | 243 inserções previstas, 18 updates diretos/de preparação e 7 RPCs; nenhuma escrita pelo dry-run |
| Testes Node da parte pura, após revisões de handoff/nurture/canal | **18 passaram**                                                                                  |
| Qualificação com Gemini autorizado                                | 3 chamadas de edge; **3 snapshots persistidos**, 0 jobs/envios novos                             |

O total passou de 448 para 464 deliveries durante o trabalho concorrente no mesmo tenant local; FollowupNurture confirmou a criação de registros de prova próprios, mas a origem de cada evento adicional não foi auditada individualmente. As contagens do dataset filtram os IDs do manifesto. Ausência de envios foi medida pelo ledger (`send_attempts`/`audio_attempts`), ausência de jobs e mensagens fora do manifesto, além do canal desconectado. Não é alegação de captura de rede externa.

**Deliveries não são envios ao paciente.** Os triggers existentes publicam `domain_events` e fan-out para `kernel.projection`, `kernel.observability` e `pipeline.agent`; não é possível alegar zero deliveries ao inserir mensagens sob RLS. A demonstração segura conserva o tenant sem IA, contatos `ai_paused`, conversas sem IA ativa, negócios pausados e canal sem conexão/credenciais. O seeder não desliga triggers nem apaga outbox para esconder efeitos.

Relatórios sem segredos desta sessão: `/tmp/clinica-ft-local-first.json`, `/tmp/clinica-ft-local-idempotence-final-a.json`, `/tmp/clinica-ft-local-idempotence-final-b.json`, `/tmp/clinica-ft-prod-plan.json`, `/tmp/clinica-ft-cleanup-plan.json`, `/tmp/clinica-ft-final-measure.json` (medição anterior à qualificação) e `/tmp/clinica-ft-local-qualification-gemini.json`.

Foi detectada e corrigida uma regressão real: `awaiting_human_since` devolvido como `+00:00` provocava UPDATE repetido contra o mesmo instante em `Z`. O teste focado falhou antes da correção e os 13 testes passaram depois.

```bash
node --test scripts/imersao-clinica-ft/dataset.test.mjs
```

### Update adicional de handoff em produção

A segunda aplicação do integrador registrou 1 UPDATE na conversa de Elisa Martins (`7c053c0f-7d43-55d9-bdba-dbe9c597fdc8`). Não era atualização recorrente nem problema de timezone: `close_handoff_sla_event` fecha o handoff ao inserir uma mensagem de atendente; o reparo posterior reabre `awaiting_human=false→true`, e `open_handoff_sla_event` substitui `awaiting_human_since` por `now()`, mesmo que o payload contenha uma data histórica.

A trilha real de SLA registra `2026-10-15T17:57:09.073795+00:00`. A segunda aplicação sobrescreveu o campo da conversa com `2026-09-20T15:50:00+00:00`; por isso o terceiro dry-run já mostrou **0/0/0 antes da correção**. O dataset agora deixa esse campo server-managed fora dos INSERTs/PATCHes. Dois testes de regressão falharam antes da alteração e passaram depois.

Prova somente leitura após a correção: `/tmp/clinica-ft-prod-plan-3-fixed.json` apresenta **0 INSERT, 0 UPDATE, 0 RPC**, 21 conversas puladas e nenhum job/envio/delivery novo. `/tmp/clinica-ft-prod-differences.json` contém os campos comparados e a trilha de SLA. `tenants.ai_enabled=true` foi preservado. Não se alterou o timestamp histórico já gravado pela aplicação anterior.

### Qualificação real opcional

```bash
SEED_TARGET=local node scripts/imersao-clinica-ft/seed.mjs --apply --with-ai-qualification --report=/tmp/clinica-ft-qualificacao.json
```

A flag invoca `ai-qualification` com JWT admin para Mariana, Henrique Dias e Isabela Melo. Não aceita produção. Pula negócios que já tenham snapshot e não usa INSERT privilegiado nem fabrica snapshot. O runtime local precisa de `functions serve` com gateway LLM autorizado, mantido pelo integrador. Falha da edge mantém saída não zero e é registrada no relatório, sem imprimir a resposta sensível do provedor.

A primeira tentativa local recebeu HTTP 500; o responsável pelo gateway mediu DeepSeek HTTP 402 `Insufficient Balance`. Não houve repetição para reconfirmar esse erro. Após autorização do integrador, o runtime foi trocado para Gemini `gemini-2.5-flash`. A execução da flag terminou em 13,81 segundos com **3 snapshots persistidos**, um para cada negócio alvo, e nenhuma nova tentativa de envio/job/delivery. A memória inline permanece explicitamente demonstrativa; os snapshots são saídas reais da edge.

## 4. Limpeza seletiva

A limpeza **nunca é executada automaticamente**:

```bash
SEED_TARGET=local node scripts/imersao-clinica-ft/cleanup.mjs --dry-run --report=/tmp/clinica-ft-limpeza.json
```

Somente após revisão explícita do relatório, `--apply` habilita DELETE. Não foi executado nesta missão.

1. Confere o mesmo login/admin/tenant único e reconstrói os UUIDs determinísticos.
2. Exige UUID + tenant + marcador/FKs esperados. O DELETE inclui esses filtros, não apenas o ID; mensagens exigem também `status=draft`.
3. Remove filhos antes dos pais. Dependências retidas ou sem permissão de leitura bloqueiam a remoção do pai, evitando `CASCADE`/`SET NULL` em dados não aprovados.
4. Preserva mensagens `sent`, inscrições, artefatos server-managed e contatos com identidades/filas. Também preserva definições de campo enquanto houver contatos, inclusive fora do cenário.
5. Mantém board, nomes de estágios, configurações e políticas: não existe snapshot confiável do estado anterior para desfazê-los automaticamente.

O dry-run local medido, antes de qualificação, listou **51 removíveis, 187 bloqueados e 3 inscrições preservadas**; executou **0 exclusões**. Os 51 incluem 10 follow-ups, 16 atividades, 5 passos e 20 negócios sem filhos retidos. A lista é recalculada a cada execução; snapshots gerados depois podem bloquear mais negócios.

### Procedimento privilegiado para remoção integral

Exige operador autorizado com acesso administrativo ao banco, fora destes scripts. Não se deve introduzir `service_role` em `seed.mjs`/`cleanup.mjs` nem enfraquecer RLS.

1. Suspender atividade **apenas da demonstração**, gerar o dry-run atualizado e guardar backup. Registrar o tenant e os UUIDs aprovados; nunca usar `DELETE WHERE tenant_id=...` como critério único.
2. Abrir transação administrativa e carregar os UUIDs aprovados em tabela temporária de manifesto. Revalidar marcadores e FKs com locks. Enumerar explicitamente filhos server-managed por FK e tenant: inscrições, identidades, snapshots, histórico/comandos, resumos, logs de IA e handoff. Abortá-la se houver filho real ou ligação fora do cenário.
3. Apagar primeiro esses filhos aprovados, depois mensagens, follow-ups/atividades/passos, sequências, conversas, negócios, contatos e canal. Mensagens devem casar simultaneamente UUID, tenant, conversa demo e `external_id='demo:imersao-clinica-ft/seed-v1:<chave>'`. Em sessão administrativa sem `auth.uid()`, o guard existente de mensagens permite exclusão; **não desabilitar o trigger**.
4. Revisar eventos de domínio por `aggregate_type` + IDs aprovados e comandos/histórico vinculados; remover deliveries/projeções apenas dos event IDs aprovados. Não apagar eventos do tenant inteiro, subscriptions globais nem filas de outros cenários.
5. Conferir contagens e ausência de referências cruzadas ainda dentro da transação. Fazer `COMMIT` somente se todos os IDs removidos pertencem ao manifesto aprovado; caso contrário `ROLLBACK`. Registrar a evidência sem credenciais. Board/configuração ficam preservados, salvo plano separado aprovado.

Não existe rollback integral privilegiado implementado ou executado aqui. O limite é deliberado: o admin pode inserir mensagens históricas, mas não pode apagar `sent` nem fabricar/apagar livremente as superfícies do backend.

## 5. Demonstração ao vivo

Abra a ficha de Mariana, sua conversa e o card em Qualificado; mostre as preferências sustentadas pelas mensagens e o follow-up interno. Os demais cards cobrem atendimento humano, negociação, ganhos, perdas e pendências.

Para tráfego simulado novo no stack local, a fatia SimuladorWhatsApp fornece `create_simulator_channel()` e o opt-in `channel_simulator`. Essa ativação conecta **somente o simulador**, não um provider externo. IA conversacional/pipeline devem ser habilitados conscientemente pelo integrador, após revisar o backlog histórico. O seed deixa tudo pausado e não serve como rotina de reset após a demonstração começar.
