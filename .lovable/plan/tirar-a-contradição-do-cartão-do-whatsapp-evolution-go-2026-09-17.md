# Tirar a contradição do cartão do WhatsApp (Evolution Go)

## O que está acontecendo

O áudio agora chega — isso está confirmado. A contradição na tela vem de dois
problemas somados, ambos verificados no banco:

1. O registro do canal ainda guarda uma mensagem antiga de uma verificação que
   falhou no passado ("Evolution respondeu HTTP 401 em /instance/status"). O
   canal já está conectado e o último teste foi "texto: ok · áudio: ok", mas essa
   frase antiga nunca é apagada quando a conexão volta a funcionar.
2. A tradução dessa frase para linguagem simples é grosseira demais: qualquer
   texto que contenha "http" vira "URL da API Evolution inválida". Por isso um
   erro de autenticação antigo aparece como se a URL estivesse errada.

Resultado: a linha mostra "Ativa" e, ao lado, um erro que não existe mais —
enquanto o teste avisa "conexão OK".

## O que será feito

1. Limpar a mensagem de estado do canal sempre que ele voltar a ficar conectado
   ou passar no teste, para não sobrar recado de falha já resolvida.
2. Na tabela "Situação das integrações", só exibir detalhe de erro quando a
   integração realmente estiver com problema. Com a integração ativa e o canal
   conectado, mostrar "Funcionando normalmente".
3. Corrigir a tradução de erros do Evolution: reservar a mensagem de URL
   inválida para erros que falam mesmo do endereço do servidor, e criar
   mensagem própria para falha de autenticação (token da instância).
4. Cobrir com testes: mensagem antiga limpa ao reconectar, detalhe não aparece
   com integração ativa e cada erro do Evolution traduzido para a frase certa.

## Detalhes técnicos

- `supabase/functions/integration-connect/index.ts`: nos caminhos que gravam
  `channels.status = 'connected'` (status/reconnect/test e `test_messaging` com
  sucesso) passar também `status_message: null`; o `last_status_reason` continua
  registrando a trilha.
- `src/components/integrations/IntegrationStatusTable.tsx`: derivar `rawError`
  de `tenant.last_error` e só cair para `channel.status_message` quando o canal
  não estiver `connected`; suprimir o detalhe quando `status === "active"` e o
  canal estiver saudável.
- `src/lib/integrations/friendly-errors.ts` (bloco `evolution`): trocar
  `/api.?url|http/i` por regra restrita a URL (`api.?url`, `url inválid`,
  `invalid url`, `ENOTFOUND`, `certificate`) e mover `401|unauthorized|apikey`
  para mensagem de token da instância.
- Testes: `src/lib/integrations/friendly-errors.test.ts`, novo caso em
  `src/lib/api/integrations.test.tsx` ou teste do componente, e caso em
  `supabase/functions/tests/integration-connect.test.ts`.
