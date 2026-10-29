# Corrigir o envio de áudio no WhatsApp self-hosted (Evolution Go)

## O que está acontecendo

No teste de conexão o texto chega normalmente, mas o áudio falha com
`HTTP 400 — {"error":"invalid base64 encoding"}`.

Hoje o áudio é enviado ao Evolution como um endereço no formato
`data:audio/mpeg;base64,...`. O servidor do Evolution rejeita esse formato:
ele espera ou um link público do arquivo, ou o conteúdo em base64 puro, sem o
prefixo `data:...`. Como no teste manual nenhum link é gerado, só resta a
tentativa com prefixo — e ela sempre falha.

## O que será feito

1. Enviar o áudio no formato que o Evolution aceita: base64 puro (sem o
   prefixo `data:`), acompanhado do nome do arquivo e do tipo do áudio.
2. Manter a tentativa por link temporário primeiro (mais leve) e a tentativa
   com o conteúdo embutido como segunda opção, já no formato correto.
3. Fazer o teste manual também gerar um link temporário do áudio, para que ele
   siga exatamente o mesmo caminho do envio real da assistente.
4. Melhorar a mensagem de erro: quando o provedor recusar o formato, mostrar
   uma explicação em português em vez do erro cru do servidor.
5. Cobrir com testes: formato do corpo enviado, tentativa em cadeia
   (link → embutido) e a mensagem de erro traduzida.
6. Publicar a função de integrações e pedir que você rode "Enviar teste"
   novamente para confirmar o áudio chegando no WhatsApp.

## Detalhes técnicos

- `supabase/functions/_shared/messaging/evolution-client.ts`
  (`sendEvolutionAudio`): trocar o `dataUri` por base64 puro em `url`, incluir
  `filename` (`audio.ogg`/`audio.mp3` conforme o mime) e `caption` vazio,
  conforme o schema de `POST /send/media` da documentação oficial
  (`caption`, `delay`, `filename`, `id`, `number`, `type`, `url`).
  Manter `type: "audio"` e o header `apikey` com o token da instância.
- `supabase/functions/integration-connect/index.ts`: no passo de áudio do
  `test_messaging`, subir o áudio sintetizado no bucket privado `ai-audio` e
  gerar link assinado curto (mesma rotina usada em `send-dispatch.ts`),
  passando `audioSignedUrl` para `sendAudioViaProvider`.
- `friendlyEvolutionHttp`: mapear `invalid base64 encoding` para mensagem
  em PT-BR sobre formato de mídia recusado.
- Testes: `supabase/functions/tests/` — casos de corpo do `/send/media`,
  fallback link → base64 e mensagem de erro.
