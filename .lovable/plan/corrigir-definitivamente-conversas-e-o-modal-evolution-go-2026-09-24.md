# Corrigir definitivamente Conversas e o modal Evolution Go

## Diagnóstico confirmado

- **Conversas:** a captura mostra três barras verticais simultâneas: menu lateral, lista de conversas e histórico. As duas últimas são áreas intencionais, mas os trilhos permanecem visualmente dominantes e dão a sensação de rolagem concorrente. O cabeçalho da conversa também concentra muitas ações na mesma linha.
- **Altura da página:** o bloqueio de rolagem externa é aplicado hoje a toda a rota de Conversas, embora somente o modo Lista tenha uma área interna com altura e rolagem próprias. Isso pode cortar os modos Visão geral e Foco em janelas baixas. A correção precisa limitar o bloqueio ao modo Lista e consolidar a responsabilidade de altura, sem adicionar outro cálculo de janela.
- **Modal Evolution Go:** a captura confirma que o modal ainda ultrapassa visualmente a área útil. O checklist ocupa quase toda a altura, as etapas aparecem apenas como círculos e a barra de ações compete com a rolagem principal.
- **Etapas:** o banco já contém as três etapas no formato correto, com título e descrição. Portanto, o conteúdo vazio da captura é um problema de composição/renderização do modal, não falta de dados.

## Correções

### 1. Conversas com uma única área ativa por coluna
- Tornar o painel da rota o único responsável pela altura disponível, simplificando a cadeia externa de `height` e `overflow`.
- Aplicar a contenção rígida somente ao modo Lista; Visão geral e Foco voltam a usar a rolagem normal da página.
- Manter rolagem apenas na lista e no histórico; cabeçalhos, filtros e campo de resposta ficam fixos dentro de suas respectivas colunas.
- Aplicar barras discretas, visíveis durante interação, sem remover a indicação de conteúdo rolável ou prejudicar teclado e acessibilidade.
- Impedir propagação da roda do mouse ao chegar no início ou fim de cada área.
- Reorganizar as ações da conversa em larguras menores para evitar aperto e deslocamento do conteúdo.

### 2. Modal Evolution Go com estrutura rígida
- Dar ao modal altura limitada pela janela e três regiões explícitas: cabeçalho fixo, conteúdo rolável e rodapé fixo.
- Remover qualquer rolagem do elemento externo do modal; somente o conteúdo central poderá rolar.
- Separar checklist e instruções em blocos compactos, preservando os cinco diagnósticos e as três etapas completas.
- Garantir que “Esquecer credenciais”, “Desativar” e “Atualizar credenciais” permaneçam visíveis e utilizáveis em telas baixas e estreitas.
- Aplicar a mesma estrutura ao formulário de atualização de credenciais, evitando mudança de tamanho ou perda do rodapé ao alternar de tela.

### 3. Renderização defensiva das etapas
- Confirmar que objetos `{ title, body }` e registros legados em texto são normalizados antes da renderização.
- Adicionar uma condição de segurança: nenhuma etapa será exibida apenas como número; sem texto válido, ela não entra na lista.
- Cobrir no teste tanto o formato atual do banco quanto o formato legado.

### 4. Validação real
- Validar com sessão autenticada em **695×654**, **1280×900** e **1685×768**, cobrindo os modos Visão geral, Lista e Foco.
- Em Conversas, testar a roda do mouse sobre menu, lista, histórico, cabeçalhos e campo de resposta; confirmar ausência de rolagem da página e de cortes.
- No Evolution Go, abrir “Gerenciar”, percorrer todo o checklist, conferir as três etapas com texto e alternar para “Atualizar credenciais”.
- Registrar capturas dos estados finais, executar os testes direcionados e confirmar a compilação sem erros.

## Escopo

A correção fica restrita à organização, altura, rolagem e apresentação dessas duas experiências. Credenciais, conexão do Evolution Go, mensagens e demais regras de negócio não serão alteradas.
