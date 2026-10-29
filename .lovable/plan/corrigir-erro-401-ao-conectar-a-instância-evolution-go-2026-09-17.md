# Corrigir erro 401 ao conectar a instância Evolution Go

## O que está acontecendo

A conexão falha com "Evolution respondeu HTTP 401 em /instance/status" mesmo com o servidor
funcionando e a instância `ali-simuladorlead03` pareada. O motivo não é credencial errada:

- O assistente pede só três dados — endereço do servidor, **GLOBAL_API_KEY** e nome da instância.
- O teste de conexão consulta o endereço de status da instância enviando a chave global.
- Na documentação oficial, esse endereço **não recebe o nome da instância** em lugar nenhum: a
  instância é identificada exclusivamente pela chave enviada, e cada instância tem um **token
  próprio** (um UUID criado junto com ela).

Ou seja: com a chave global, o servidor não sabe de qual instância se trata e devolve 401. O nome
digitado no assistente hoje é usado só como rótulo — nunca chega na consulta.

## Como fica depois da correção

1. Ao salvar, o app usa a chave global para listar as instâncias do servidor, encontra a instância
   pelo nome digitado e guarda automaticamente o token dela. O usuário continua informando apenas
   endereço, chave global e nome — nada muda no que ele precisa saber.
2. Se o nome não existir no servidor, a mensagem passa a ser clara: "A instância X não existe neste
   servidor Evolution Go", com a lista de nomes encontrados — em vez de um 401 sem explicação.
3. Campo opcional novo no passo 2, "Token da instância", para quem usa um servidor que não permite
   listar instâncias com a chave global: preenchido, ele é usado direto e a busca é dispensada.
4. Status, reconexão, QR Code e envio de mensagens passam a usar o token da instância, então o
   card deixa de oscilar para "erro" e o envio deixa de falhar por 401.

## Detalhes técnicos

- `supabase/functions/_shared/messaging/evolution-client.ts`
  - Nova função `resolveEvolutionInstanceToken(cred)`: `GET /instance/all` com header `apikey` =
    GLOBAL_API_KEY, procura em `data[]` o item cujo `name` bate com `instance_name` (comparação
    exata, sem sensibilidade a maiúsculas) e devolve `token`. Mesmo padrão dos demais: SSRF via
    `validatePublicHttpsUrl`, `AbortSignal.timeout`, nunca lança, erro redigido com `redactSecrets`.
    Erros distintos para HTTP 401 (chave global inválida), instância não encontrada (lista os nomes
    disponíveis) e falha de rede.
  - `checkEvolutionInstanceStatus`, `reconnectEvolutionInstance`, `sendEvolutionMessage` e
    `connectEvolutionInstance` passam a receber credenciais já com `instance_token` resolvido;
    `resolveInstanceAuthToken` deixa de cair no `api_key` silenciosamente e passa a exigir o token
    para os endpoints por instância (mantendo `api_key` apenas em `/instance/connect` e
    `/instance/all`, que são globais).
  - Mensagem de 401 em `friendlyEvolutionHttp` ganha a dica de token de instância.
- `supabase/functions/integration-connect/index.ts`
  - `testEvolution`: resolve o token antes do status (usa `instance_token` informado, se houver) e
    devolve o erro específico de instância inexistente.
  - No fluxo de conexão, o token resolvido é persistido em `integration_secrets` (chave
    `instance_token`) — nunca em `channels.config`, mantendo a convenção atual de segredo.
- `supabase/functions/evolution-watchdog/runner.ts` e
  `supabase/functions/messaging-channels-reconcile/runner.ts`: quando o canal não tiver
  `instance_token` nos segredos (canais criados antes desta correção), resolvem uma vez pela chave
  global e gravam, em vez de repetir 401 a cada ciclo.
- Migration idempotente: acrescenta `instance_token` (opcional) em `required_secrets` da linha
  `slug = 'evolution'` em `public.integrations`. Sem tocar em policies/grants.
- `src/lib/integrations/wizards/registry.ts`: passo 2 ganha o campo opcional e o texto explicando
  que normalmente não precisa ser preenchido.
- `src/components/integrations/checklists.ts`: item novo sobre token de instância, com link para
  `docs.evolutionfoundation.com.br/evolution-go/getting-started`.
- Testes: casos novos em `supabase/functions/tests/evolution-client.test.ts` (token resolvido por
  nome, instância inexistente, chave global inválida, token informado dispensa a listagem) e
  ajuste dos testes de watchdog/reconcile para o novo contrato de credenciais.
