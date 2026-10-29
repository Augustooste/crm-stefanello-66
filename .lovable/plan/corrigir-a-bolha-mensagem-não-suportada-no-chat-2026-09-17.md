# Corrigir a bolha "[mensagem não suportada]" no chat

## O que está acontecendo

A bolha que aparece na conversa é o eco do próprio áudio de teste: o WhatsApp
devolve, pelo webhook, uma cópia de tudo que o número envia. O registro gravado
às 12:19 é de saída, sem arquivo de áudio e com o texto "[mensagem não
suportada]" — ou seja, a leitura do recado não reconheceu o formato do eco.

Hoje a leitura do canal Evolution Go só entende dois formatos: texto e áudio
recebido do cliente. O eco de um áudio **enviado por nós** chega com outra
estrutura, cai no caso final e vira esse texto genérico. Além disso, quando
isso acontece não fica guardado nenhum registro da estrutura original, então
não há como saber qual campo veio — só o texto genérico é gravado.

## O que será feito

1. Guardar um resumo técnico (sem conteúdo pessoal e sem chaves de mídia) toda
   vez que um recado do WhatsApp não for reconhecido: quais campos vieram e
   qual o tipo declarado. Isso fica no registro de eventos do sistema e é o que
   permite fechar o caso sem tentativa e erro.
2. Reconhecer o eco de mensagens enviadas pelo próprio número: quando a
   mensagem já existe no histórico (mesmo identificador do provedor), ela é
   apenas atualizada em vez de virar uma bolha nova; quando é um envio de
   diagnóstico, entra como "Áudio enviado" em vez do texto genérico.
3. Ampliar a leitura de mídia do Evolution Go para aceitar as variações de
   formato do servidor (áudio de voz, áudio comum, imagem, vídeo, documento, e
   as mesmas chaves com inicial maiúscula), guardando o arquivo quando ele vem
   junto.
4. Ignorar eventos internos do WhatsApp (recibos, reações, chaves de
   criptografia) nesse canal, como já é feito no canal Zappaz — eles nunca
   deveriam virar bolha.
5. Apagar a bolha antiga "[mensagem não suportada]" dessa conversa, já que ela
   é resíduo do teste.
6. Testes cobrindo: eco de áudio próprio, áudio recebido com arquivo embutido,
   evento interno ignorado e formato desconhecido gerando o resumo técnico.
7. Publicar a função de mensagens e pedir um novo teste de texto + áudio para
   confirmar que o chat mostra as duas mensagens corretamente.

## Detalhes técnicos

- `supabase/functions/_shared/messaging/normalizers.ts`
  (`normalizeEvolutionInbound`): aceitar `audioMessage`/`AudioMessage`,
  `ptt`, `imageMessage`, `videoMessage`, `documentMessage` e o
  `viewOnceMessage*` que encapsula os anteriores; retornar `null` para as
  chaves de protocolo (mesma lista `ZAPPAZ_PROTOCOL_KEYS` já usada em
  `messaging-webhook/index.ts`); para `fromMe` com mídia, usar rótulo
  "[áudio enviado]" em vez do genérico.
- `supabase/functions/messaging-webhook/index.ts`: antes de gravar um
  `[mensagem não suportada]`, registrar em `system_events` um resumo com
  `Object.keys(Message)`, `Info.Type`, `Info.MediaType` e `fromMe` (sem
  `mediaKey`, sem base64, sem texto) e, no caminho `fromMe`, procurar
  `messages.external_id` existente para atualizar em vez de inserir.
- Limpeza pontual da linha `98fb09e1-9bc5-4a83-838b-ebaa3f81762b` em
  `public.messages` (bolha residual do teste).
- Testes em `supabase/functions/tests/messaging-webhook.test.ts` e
  `normalizers`-relacionados; sem mudança de RLS, policies ou migrations.
