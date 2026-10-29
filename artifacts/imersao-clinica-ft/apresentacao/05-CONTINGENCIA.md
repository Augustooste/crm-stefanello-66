# Contingência: Imersão Clínica FT

> Cópia para levar junto com esta pasta. Original (mesmo conteúdo): `docs/imersao-clinica-ft/05-CONTINGENCIA.md`. Se editar, edite o original e copie de novo.

Abra `kanban-auto.gif` (nesta pasta) se a demonstração ao vivo parar. Identifique-o como execução real da branch local, com transporte simulado.

**Estado em 16/10/2026: PUBLICADO.** Simulador, comportamento, extração e agente de pipeline estão em produção. A conversa simulada da Mariana respondeu em dois blocos, sem envio externo, e gerou **sete extrações** (cinco aplicadas à ficha) em duas rodadas: 14:30 UTC e 16:42–16:53 UTC. Às **14:30:51 UTC** a IA moveu sozinha o negócio “Contato Cliente simulado” de Novo Paciente para Em Atendimento (confiança 1,0; política autônoma de 0,80). Os arquivos locais abaixo são apoio de contingência, não substitutos para o aceite de produção já realizado.

## Resposta por falha

| Falha                           | Ação imediata                                                                                                                                                                                                                                                                                                         | O que dizer                                                                                                                                                             |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App publicado fora do ar        | Mostrar os PNGs de `apresentacao/telas/` (capturas de **produção pós-deploy**, 16/10/2026) e o vídeo principal `apresentacao/aceleraflow-clinica-ft.mp4`. Usar o GIF local como apoio. A stack local hoje está **sem dados** (banco local vazio em 16/10): não conte com ela sem antes repopular em ambiente isolado. | “O fluxo está publicado, mas o app está indisponível neste momento. Estas capturas foram feitas no app publicado; a automação filmada no GIF foi executada localmente.” |
| Login falha                     | Parar o compartilhamento da tela; conferir domínio e conta. Não criar outro usuário nem resetar o tenant. Usar as capturas enquanto o responsável consulta o cofre.                                                                                                                                                   | “O login foi validado na entrega. Vou continuar pelas evidências enquanto verificamos o acesso.”                                                                        |
| IA lenta ou sem crédito Lovable | Não repetir mensagens para forçar resposta. Mostrar a prova registrada de produção (resposta em dois blocos, sete extrações, cinco aplicadas à ficha) ou, como apoio explicitamente local, a conversa gravada, extrações e GIF.                                                                                       | “A IA respondeu de verdade em produção na validação. Essa execução não garante disponibilidade, saldo ou latência agora.”                                               |
| Dados alterados durante a demo  | Não tentar desfazer tudo com seed. Preservar o estado atual e apresentar as capturas. Para restauração planejada, seguir o procedimento abaixo.                                                                                                                                                                       | “O ambiente permite alterações. Este recorte registrado mantém o cenário original sem apagar o que acabou de acontecer.”                                                |
| Internet indisponível           | Usar capturas/GIF já baixados. A UI e o banco locais podem continuar se os serviços já estiverem prontos; novas respostas Gemini exigem rede.                                                                                                                                                                         | “A navegação local não substitui a conexão com a IA externa. Vou mostrar o processamento que já foi executado.”                                                         |

As falhas acima são hipóteses de contingência, não incidentes medidos nesta entrega. O E2E pós-deploy passou **11/11**; F7 teve intermitência de carregamento numa rodada longa e passou **2/2 isolada**. Conta, provas e limites estão em [03-VALIDACAO.md](../../../docs/imersao-clinica-ft/03-VALIDACAO.md).

## Limites conhecidos em produção

- O avanço autônomo depende de evento legítimo novo, elegibilidade e cron nos minutos **8/18/28/38/48/58**. Já houve um avanço autônomo genuíno em produção: às **14:30:51 UTC**, Novo Paciente → Em Atendimento no card “Contato Cliente simulado” (ver o painel do card ou `apresentacao/telas/10-kanban-auditoria-ia.png`). Às 16:58 UTC, 4 tentativas do cron `pipeline-agent` foram bloqueadas (`human_active`) porque a recepção havia assumido a conversa. Não force eventos nem arraste um card para encenar automação; use o GIF local se a espera não couber na apresentação.
- O risco de admin comum pausar rotinas globais está fechado. Por decisão do usuário, a conta demo `engmtgg@gmail.com` é a operadora da plataforma e vê **Ativar rotinas** e **Pausar**: **não clique** nesses botões durante a demo, porque afetam todos os tenants. `pipeline-agent` e `contact-enrichment-dispatcher` já estão ativos, com opt-in somente da Clínica FT. Não pause jobs globais para contornar uma falha da demo.
- O simulador recebeu a correção `20261015180000_simulador_sem_schema_private.sql`, e `/contatos/duplicados` a correção `20261016200000_duplicados_sem_schema_private.sql` (mesmo tipo de defeito; tela validada em produção em 16/10).
- O período do topo vale na hora para todas as telas, sem recarregar (corrigido em 16/10). A janela de 30 dias já exclui a Mariana do seed; escolha 90 dias. A Mariana simulada é outra identidade.
- Após a imersão, trocar a senha da conta demo; rotacionar a chave Gemini do cliente. Não registrar credenciais nem reaproveitar saídas antigas de ferramentas.

## Subir a stack local, sem tocar produção

**Não execute reset, bootstrap ou seed sobre a demo ativa.** O worktree da imersão foi removido em 16/10/2026; os comandos abaixo rodam a partir do checkout principal, e o banco local precisa ser repopulado (em ambiente isolado) antes de servir de contingência. Reiniciar serviços preserva dados; `pnpm test:db` faz reset e não é comando de contingência.

Pré-requisitos: Docker, Node 24, pnpm e dependências do projeto instalados; migrations da branch disponíveis. Acesso ao arquivo de credenciais autorizado e ao arquivo local do gateway. Não abrir esses arquivos na tela compartilhada.

### 1. Banco local

No terminal do operador:

```bash
cd /home/freedom/freedomdigitalhub/clientes/acelera-ia/aceleraflow-remix
pnpm exec supabase start
```

O CLI é o `supabase start` do projeto, resolvido pelo pnpm. Não usar `supabase db reset`, `pnpm test:db` ou outro worktree que compartilhe a mesma stack durante a apresentação. O banco usado nas provas é local, em `127.0.0.1:54321`; a UI local não deve apontar para o projeto de produção.

### 2. Edge functions, em outro terminal

No mesmo diretório:

```bash
pnpm exec supabase functions serve --env-file /tmp/imersao-pipeline-functions.env
```

O arquivo usado na prova contém `AI_GATEWAY_URL`, `AI_GATEWAY_API_KEY` e `AI_GATEWAY_MODEL=gemini-2.5-flash`. A URL é o endpoint OpenAI-compatível autorizado do Google. Esses valores pertencem ao ambiente do processo, não ao frontend nem ao Git. Sem override, o código continua usando o gateway Lovable.

O arquivo em `/tmp` é transitório. Se não existir ou a chave tiver sido rotacionada, o operador deve recriá-lo a partir do cofre autorizado antes de iniciar o runtime. Não copiar chave de transcrição, relatório ou comando antigo. Uma stack iniciada sem esse pré-requisito **não** é uma contingência de IA validada.

### 3. Frontend com `VITE_*` locais, em outro terminal

O comando de desenvolvimento exercitado foi `pnpm dev --host 127.0.0.1 --port 5173 --strictPort`, com URL e chave pública locais. Para obtê-las sem imprimir a saída sensível de `supabase status`, no mesmo diretório:

```bash
node --input-type=module -e '
import { execFileSync, spawn } from "node:child_process";
import { parseEnv } from "node:util";
let local;
try {
  local = parseEnv(execFileSync("pnpm", ["exec", "supabase", "status", "-o", "env"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
  }));
} catch {
  throw new Error("Não foi possível consultar a stack local; saída sensível omitida.");
}
const publicKey = local.PUBLISHABLE_KEY || local.ANON_KEY;
if (!local.API_URL?.startsWith("http://127.0.0.1:") || !publicKey) {
  throw new Error("Stack local ou chave pública local indisponível.");
}
const dev = spawn("pnpm", ["dev", "--host", "127.0.0.1", "--port", "5173", "--strictPort"], {
  stdio: "inherit",
  env: {
    ...process.env,
    VITE_SUPABASE_URL: local.API_URL,
    VITE_SUPABASE_PUBLISHABLE_KEY: publicKey,
    VITE_SUPABASE_PROJECT_ID: "local-clinica-ft"
  }
});
dev.on("exit", code => process.exit(code ?? 1));
'
```

`PUBLISHABLE_KEY`/`ANON_KEY` são nomes da saída do CLI local, não variáveis de ambiente Vite. A leitura reutiliza o contrato de `seed.mjs`; a saída fica em memória, inclusive em caso de falha. O frontend recebe **`VITE_SUPABASE_PUBLISHABLE_KEY`**, nunca uma credencial privilegiada. Não alterar `src/integrations/supabase/client.ts` gerado.

O comando encapsulado acima é uma receita documental `[NÃO VERIFICADO]` como bloco único; `supabase status`, o comando `pnpm dev` e os três `VITE_*` foram usados por `AmbienteLocalDemo`. A prova de navegador confirmou login no endpoint local, redirecionamento para `/app` e nenhuma chamada ao backend de produção.

### 4. Bootstrap apenas se a conta local ainda não existir

O script lê as credenciais de `~/.config/aceleraflow-imersao/credentials.env` sem exibi-las. Não passar a senha como argumento.

```bash
SEED_TARGET=local node scripts/imersao-clinica-ft/seed.mjs --apply --bootstrap-local --report=/tmp/clinica-ft-primeira.json
```

Esse caminho é permitido somente em loopback: signup oficial, tenant/admin pelo trigger, template odontológico em board vazio e IA desligada no tenant novo. Não recria as saídas LLM, decisões, GIF ou a conversa genuína que foram produzidos depois do seed. Depois do bootstrap, uma nova demonstração automática exige preparação e validação explícitas.

### 5. Confirmar o ambiente antes de apresentar

Abra `http://127.0.0.1:5173/auth`, entre e confira **Clínica FT | Demonstração Imersão**. O banco local estava **vazio** em 16/10/2026 (0 tenants): o tenant local da missão (`3a807208-3f4b-4a02-b633-34fd7ef0c686`) e seus registros, incluindo o movimento filmado no GIF, não existem mais. Um bootstrap novo gera outro tenant, com outro UUID. Os dados do GIF só existem como evidência em JSON: `artifacts/imersao-clinica-ft/kanban-auto.json` e `artifacts/imersao-clinica-ft/local-pipeline-agent-proof.json`. Se não houver os dados esperados, use as capturas, sem rodar provas globais para tentar preencher a tela.

Fontes dos comandos/contratos: `agent://AmbienteLocalDemo`, `scripts/imersao-clinica-ft/README.md`, `seed.mjs` e `supabase/functions/_shared/ai/gateway.ts`. Reinício completo em máquina limpa e operação sem internet: `[NÃO VERIFICADO]`.

## Reaplicar seed: restauração planejada, não ação ao vivo

1. Interrompa a demonstração e preserve os registros que precisam permanecer. Confirme o tenant, os IDs do manifesto e que nenhum worker/prova concorrente está operando nele.
2. Desligue a IA **somente do tenant da demo** antes de aplicar. O script exige `tenants.ai_enabled=false`; não faz essa mudança no caminho normal e não deve pausar rotinas globais. Não conectar os números MOCK a um provedor real.
3. Gere o plano e revise as diferenças:

   ```bash
   SEED_TARGET=local node scripts/imersao-clinica-ft/seed.mjs --dry-run --report=/tmp/clinica-ft-reaplicacao-plano.json
   ```

4. Somente após revisão, aplique:

   ```bash
   SEED_TARGET=local node scripts/imersao-clinica-ft/seed.mjs --apply --report=/tmp/clinica-ft-reaplicacao.json
   ```

5. Confira o relatório antes de religar a IA. Uma reaplicação sem alterações deve ser 0 INSERT / 0 UPDATE / 0 RPC; mudanças externas podem gerar diferenças ou recusa. O seed não reverte estágio por UPDATE direto nem sobrescreve mensagem divergente.

Produção só deve receber nova aplicação após autorização operacional específica, fora da apresentação. O diagnóstico seguro é:

```bash
SEED_TARGET=prod node scripts/imersao-clinica-ft/seed.mjs --dry-run --report=/tmp/clinica-ft-prod-plano.json
```

Idempotência já medida: produção, terceira e quinta aplicações 0/0/0; local, reaplicação 0/0/0. Isso não garante que a reaplicação depois de decisões novas preserve toda a encenação. A aplicação original ocorreu com IA desligada e foi seguida de reativação controlada. Fonte: `local://imersao-evidencias.md`, Seed.

## Limpeza seletiva

**A limpeza apaga dados; nunca executá-la durante a apresentação.** Primeiro gerar o relatório:

```bash
SEED_TARGET=local node scripts/imersao-clinica-ft/cleanup.mjs --dry-run --report=/tmp/clinica-ft-limpeza-plano.json
```

Depois de revisar os IDs e obter autorização para a exclusão, o comando é:

```bash
SEED_TARGET=local node scripts/imersao-clinica-ft/cleanup.mjs --apply --report=/tmp/clinica-ft-limpeza-aplicada.json
```

O `--apply` de limpeza **não foi executado nesta missão**. O dry-run medido antes das qualificações encontrou 51 removíveis, 187 bloqueados e 3 inscrições preservadas; a lista atual será diferente se houver novos artefatos. Fonte: `scripts/imersao-clinica-ft/README.md`, Limpeza seletiva.

| Limite            | Comportamento seguro                                                                                                                                                               |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Escopo            | UUID v5 do manifesto + tenant + marcador `imersao-clinica-ft/seed-v1` e FKs esperadas. Nunca apagar pelo tenant inteiro ou prefixo do nome.                                        |
| Filhos e relações | Filho retido ou sem permissão de leitura bloqueia o pai; não usar cascata para contornar a proteção.                                                                               |
| Dados protegidos  | Mensagens `sent`, inscrições, identidades, filas e artefatos server-managed não são apagados livremente pelo JWT admin.                                                            |
| Configuração      | Board, nomes de estágios e políticas ficam preservados; não existe snapshot anterior confiável para restaurar automaticamente.                                                     |
| Remoção integral  | Exige backup, acesso SQL privilegiado, manifesto revisado, transação e aprovação específica. Procedimento no README dos scripts; não há rollback integral automático implementado. |

## Frases para identificar simulações

- “Os pacientes, preferências, valores e sinais de negócio são fictícios.”
- “A entrada e o transporte são simulados; a IA e sete extrações (cinco aplicadas à ficha) foram executadas de verdade em produção. Quando eu abrir o GIF, estarei mostrando uma prova local anterior.”
- “Este GIF mostra quadros reais com espera acelerada; não é prova de tempo de resposta em produção.”
- “Nenhuma mensagem foi entregue a WhatsApp ou e-mail real pela prova do simulador. A ausência de envio foi sustentada pelos guards e pelos registros executados, não por uma captura externa de toda a rede.”
- “As nove migrations da imersão, a correção de follow-up de 16/10 (sequência concluída não é reinscrita), 25 Edge Functions e o frontend foram publicados. A Clínica FT está com as features habilitadas. Esta conta é a operadora da plataforma; por isso não clico em Ativar/Pausar rotinas, que afetam todos os tenants.”

Para continuar sem alterar dados, volte ao passo correspondente de [04-ROTEIRO-APRESENTACAO.md](04-ROTEIRO-APRESENTACAO.md) usando o PNG daquela etapa.
