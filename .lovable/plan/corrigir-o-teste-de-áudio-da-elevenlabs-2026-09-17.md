# Corrigir o teste de áudio da ElevenLabs

## Diagnóstico confirmado

- A conta **MSA Participações** tem a ElevenLabs ativa.
- A voz `ORgG8rwdAiMYRug8RJwR` e o modelo `eleven_multilingual_v2` estão salvos corretamente.
- O modo de resposta por voz está `off`.
- O teste de integração usa a mesma leitura das respostas automáticas. Essa leitura retorna “sem voz” quando o modo está desligado, embora a voz esteja configurada; por isso o áudio é ignorado e a mensagem exibida é incorreta.
- O texto “Sem voz escolhida” mostrado no cartão é uma orientação fixa, não o estado real da seleção.

## Alterações

1. Separar a configuração de síntese de voz da preferência de resposta automática:
   - o botão **Enviar teste** usará a voz e o modelo salvos sempre que a ElevenLabs estiver ativa;
   - o modo `off` continuará impedindo respostas automáticas em áudio, sem alterar o comportamento da assistente em produção.
2. Corrigir os estados da tela:
   - mostrar claramente quando uma voz está selecionada;
   - remover o aviso contraditório “Sem voz escolhida” quando houver seleção;
   - fazer a lista de verificação reconhecer a voz salva.
3. Melhorar o diagnóstico do teste para distinguir:
   - integração ElevenLabs desconectada;
   - voz não selecionada;
   - modo automático de voz desligado;
   - falha real de geração ou envio do áudio.
4. Adicionar testes de regressão para o cenário atual: ElevenLabs ativa, voz salva e modo automático `off` deve permitir áudio no teste manual.
5. Executar os testes direcionados, publicar a função de conexão e validar o novo resultado nos registros do ambiente.

## Resultado esperado

O teste manual enviará texto e áudio com a voz já selecionada, mesmo que as respostas automáticas por voz estejam desligadas. O modo automático continuará respeitando a configuração atual.
