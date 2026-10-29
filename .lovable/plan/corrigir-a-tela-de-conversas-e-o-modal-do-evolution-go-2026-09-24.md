# Corrigir a tela de Conversas e o modal do Evolution Go

## Diagnóstico confirmado

- **Conversas:** a tela ainda depende de uma altura calculada a partir da janela (`100svh - 6.5rem`) dentro de uma área externa que também controla rolagem. Isso mantém áreas concorrentes e torna o resultado frágil conforme a altura da janela, a barra superior e os espaçamentos mudam.
- **Modal Evolution Go:** o modal inteiro é a área rolável, então cabeçalho, conteúdo e ações se deslocam juntos. Além disso, o catálogo salvo no banco contém `setup_steps` como três textos simples, enquanto a tela tenta ler cada item como `{ title, body }`; por isso a captura mostra somente os círculos “1, 2, 3” e um grande espaço vazio.

## Correções

### 1. Conversas ocupando o espaço real disponível
- Completar a cadeia de altura flexível do conteúdo principal até a rota de Conversas, removendo o cálculo manual baseado em `100svh`.
- Organizar a página em duas linhas: faixa superior compacta e painel de conversa com `minmax(0, 1fr)`.
- Manter somente três rolagens intencionais e isoladas: menu lateral, lista de conversas e histórico de mensagens.
- Impedir que a roda do mouse escape para a área externa ao atingir o início ou fim da lista ou do histórico.
- Preservar o comportamento de uma área por vez em telas estreitas, com retorno claro da conversa para a lista.

### 2. Modal Evolution Go estável e legível
- Dividir o modal em cabeçalho fixo, conteúdo central rolável e barra de ações fixa no rodapé.
- Limitar a altura pela área visível e garantir que fechar, desativar e atualizar credenciais permaneçam acessíveis sem disputar espaço com o conteúdo.
- Ajustar o checklist e as etapas para larguras pequenas, evitando cortes, espaços vazios e botões espremidos.
- Aplicar a mesma estrutura ao formulário passo a passo para que a troca entre credenciais e gerenciamento não recrie o problema.

### 3. Corrigir as etapas vazias do Evolution Go
- Criar uma migration corretiva e idempotente que atualize apenas o `setup_steps` da integração `evolution` para o formato esperado, com título e descrição em PT-BR.
- Tornar a leitura defensiva para não voltar a renderizar círculos vazios caso algum catálogo legado ainda entregue textos simples.
- Não alterar credenciais, canais, regras de acesso, mensagens ou funcionamento da integração.

### 4. Validação
- Atualizar os testes da tela de Conversas, do modal, do assistente e das etapas do catálogo.
- Validar no navegador autenticado em **695×654**, **1280×900** e **1685×768**.
- Exercitar a roda do mouse sobre lista, mensagens, fundo da página e conteúdo do modal.
- Confirmar que o rodapé do modal permanece visível, as três etapas têm texto e não há barras concorrentes, conteúdo cortado ou espaço vazio artificial.
- Confirmar compilação sem erros e ausência de novos erros no navegador.

## Escopo

A correção será limitada à apresentação e rolagem dessas duas experiências e ao formato textual das etapas do Evolution Go. Nenhuma regra de negócio ou credencial será modificada.
