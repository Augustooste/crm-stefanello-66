# Corrigir e publicar áudio no Evolution Go

## Diagnóstico confirmado

- Os registros do teste feito às **15:35 UTC** mostram `audio_unsupported` e “Este provedor não envia áudio”.
- No código atual, `evolution` já está incluído entre os canais capazes de áudio e o envio por `POST /send/media` já está implementado.
- Portanto, o botão está chamando uma versão publicada antiga da função de integração; a alteração local ainda não chegou ao ambiente que executa o teste.
- A mensagem usa `toLocaleTimeString("pt-BR")` sem informar fuso. No ambiente do servidor isso usa UTC, por isso apareceu **15:34:32** em vez de **12:34:32** no horário de Brasília.
- Um teste automatizado antigo ainda afirma que Evolution Go não aceita áudio, contrariando a implementação atual.

## Implementação

1. **Corrigir o horário do teste**
   - Formatar a hora explicitamente com `timeZone: "America/Sao_Paulo"`.
   - Identificar o fuso na própria mensagem, por exemplo: `Teste do AceleraFlow (12:34:32, horário de Brasília)`.

2. **Fechar a cobertura do teste de áudio**
   - Atualizar o teste antigo para considerar Evolution Go compatível com áudio.
   - Adicionar cobertura do fluxo `test_messaging` para garantir que Evolution Go tenta gerar e enviar o áudio, em vez de retornar `skipped`.
   - Cobrir também o horário de Brasília para impedir regressão para UTC.

3. **Validar o fluxo completo**
   - Rodar os testes direcionados do cliente Evolution Go, envio de voz, integração, recebimento e despacho da assistente.
   - Rodar a suíte completa das funções e a verificação do aplicativo.

4. **Publicar as funções corretas**
   - Publicar `integration-connect`, responsável pelo botão “Enviar teste”.
   - Publicar `ai-respond`, para respostas de voz reais da assistente.
   - Publicar `messaging-webhook`, para receber, guardar e transcrever áudios recebidos.

5. **Confirmar no ambiente real**
   - Executar novamente o teste do cartão Evolution Go.
   - Conferir nos registros que o passo de áudio mudou de `skipped` para `ok` ou, se o servidor Evolution recusar a mídia, exibir o erro real do `/send/media` em vez da mensagem incorreta de falta de suporte.
   - Confirmar que a mensagem de texto mostra o horário de Brasília.

## Resultado esperado

O teste enviará texto e áudio de verdade pelo Evolution Go. A tela não mostrará mais “Este provedor não envia áudio”; qualquer falha restante será específica do envio de mídia, e o horário da mensagem será o de Brasília.
