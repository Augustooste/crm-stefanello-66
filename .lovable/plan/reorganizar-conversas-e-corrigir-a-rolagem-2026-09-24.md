# Reorganizar Conversas e corrigir a rolagem

## Objetivo
Fazer a tela de Conversas ocupar corretamente a altura disponível, eliminar o espaço vazio inferior e tornar a rolagem do mouse previsível.

## Alterações
1. **Estrutura da página**
   - Trocar a altura fixa atual do painel por uma composição flexível baseada no espaço real abaixo da barra superior.
   - Manter título, exportação e modos em uma faixa compacta e alinhada, sem empurrar o conteúdo para baixo.
   - Fazer a lista e a conversa preencherem toda a área útil até o rodapé da janela.

2. **Rolagem previsível**
   - Impedir que a rolagem da lista ou das mensagens “escape” para a página externa ao chegar no limite.
   - Preservar rolagens independentes apenas onde fazem sentido: lista de conversas, histórico de mensagens e menu lateral.
   - Manter cabeçalho da conversa e campo de resposta fixos dentro do painel, rolando somente as mensagens.

3. **Organização e adaptação de largura**
   - Ajustar proporção entre lista e conversa para aproveitar melhor telas largas.
   - Reorganizar cabeçalho e ações sem sobreposição em larguras menores.
   - Em telas estreitas, priorizar uma área por vez para evitar duas colunas comprimidas e rolagem confusa.

4. **Validação no navegador**
   - Testar a tela autenticada nos tamanhos 695×654, 1280×900 e 1440×900.
   - Usar o mouse para validar lista, histórico, menu lateral e limites de cada rolagem.
   - Conferir ausência de espaço inferior excessivo, barras concorrentes, cortes e sobreposições.
   - Rodar os testes existentes da tela de Conversas e confirmar que a aplicação continua sem erros.

## Escopo
Somente apresentação e interação da tela de Conversas e do contêiner visual necessário para sua altura. Nenhuma regra de negócio, dado, integração ou banco será alterado.
