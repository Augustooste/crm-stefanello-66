# Áudio no WhatsApp (Evolution Go): enviar e receber

## O que está acontecendo

O teste mostra "Este provedor não envia áudio" porque o canal Evolution Go nunca foi
declarado como capaz de áudio: a lista de provedores com voz é `zapi`, `zappaz` e
`meta-cloud`. Quando a assistente gera a fala pela ElevenLabs, o envio é abortado antes
de tentar e a resposta cai para texto (com registro `canal_nao_suporta_audio`).

Na entrada o problema é outro: a leitura das mensagens do Evolution Go só aproveita
texto. Áudio recebido vira a bolha "[audio recebida — abra no WhatsApp para ver]" sem
guardar o arquivo, então a transcrição (também ElevenLabs) nunca roda nesse canal.

A voz em si já funciona: a geração de fala, a transcrição, o armazenamento do áudio e o
re-hospedamento de áudio cifrado do WhatsApp já existem e são usados pelos outros canais.

## O que será feito

### 1. Enviar áudio pelo Evolution Go
- Passar a tratar o Evolution Go como canal com áudio.
- Publicar a fala gerada usando o endpoint oficial de mídia do Evolution Go
  (`POST /send/media` com `type: "audio"`), autenticando com o token da instância —
  o mesmo esquema já corrigido para status, QR Code e envio de texto.
- O arquivo já é gravado no armazenamento privado do projeto; será gerado um link
  temporário e assinado (validade curta) para o servidor Evolution Go buscar o áudio.
  Se o servidor não conseguir buscar o link, o áudio é reenviado embutido no próprio
  pedido, e só então a resposta cai para texto — sempre com o motivo registrado.
- Limites e proteções já existentes continuam: teto de tamanho, tempo máximo de espera,
  recusa de endereços internos e erro do provedor registrado no servidor, nunca cru na tela.

### 2. Receber áudio pelo Evolution Go
- Ler `audioMessage` das mensagens recebidas: quando o servidor manda o arquivo junto
  (campo `base64`, padrão do Evolution Go), ele é gravado direto no armazenamento; quando
  manda só um endereço de mídia, o caminho já existente de decifrar com a `mediaKey` e
  re-hospedar é reaproveitado.
- Com o arquivo guardado, a transcrição pela ElevenLabs passa a rodar normalmente e a
  assistente responde ao que o cliente falou; a bolha no inbox mostra o áudio em vez de
  texto genérico.
- Se nada disso for possível (arquivo ausente), o comportamento atual de aviso e registro
  é mantido — nada fica falhando em silêncio.

### 3. Sinalização na tela
- O teste de conexão do cartão WhatsApp (Evolution Go) passa a exercitar áudio de verdade,
  em vez de exibir "Este provedor não envia áudio".
- A lista de verificação do cartão ganha um item indicando se o canal está apto a voz.

### 4. Testes
- Novos testes do cliente Evolution Go: corpo e cabeçalhos do envio de áudio conforme a
  documentação oficial, recusa de endereço interno, falha de rede sem derrubar o fluxo.
- Testes de leitura de mensagem: áudio com arquivo embutido, áudio só com endereço
  cifrado, mensagem de texto inalterada.
- Teste do despacho: canal Evolution Go com voz ligada envia áudio em vez de cair para texto.

## Detalhes técnicos

- `supabase/functions/_shared/messaging/provider-send.ts`: incluir `evolution` em
  `AUDIO_CAPABLE_PROVIDERS` e adicionar `sendEvolutionAudio` (via novo helper em
  `evolution-client.ts`, reaproveitando `resolveEvolutionInstanceToken`,
  `validatePublicHttpsUrl` e `AbortSignal.timeout`).
- `sendAudioViaProvider` passa a aceitar, opcionalmente, o caminho do objeto no bucket
  `ai-audio` para que o ramo Evolution gere `createSignedUrl` (TTL curto); mantém o
  contrato atual (`bytes`/`mime`) para os demais provedores e usa data URI como segundo
  tento.
- `send-dispatch.ts`: `persistGeneratedAudio` já devolve/define `audio_storage_path`;
  repassar esse caminho ao envio.
- `normalizers.ts` (`normalizeEvolutionInbound`): mapear `Message.audioMessage`
  (`url`, `mimetype`, `mediaKey`) e `Message.base64`/`mediaUrl` para `media`.
- `messaging-webhook/index.ts`: ramo novo para mídia recebida em base64 — gravar no
  bucket `ai-audio` (mesmo helper de upload usado por `rehostEncryptedWhatsAppAudio`) e
  apontar `messages.media_url` para o objeto; o ramo `media.key` existente continua para
  URL cifrada.
- Testes em `supabase/functions/tests/evolution-client.test.ts`,
  `messaging-webhook.test.ts`, `send-dispatch.test.ts` e `provider-send.test.ts`.
- Sem alteração de RLS, policies ou migrations de dados; a linha do catálogo `evolution`
  só ganha, se necessário, ajuste idempotente de texto do passo de áudio.
