# Validar entrada e saída no navegador, de ponta a ponta

Objetivo: confirmar no navegador real que o erro que aparecia depois de entrar não volta mais, executando o ciclo completo de uso.

## O que será testado

1. Criar uma conta nova pela tela de entrada (primeiro cadastro vira administrador).
2. Entrar com essa conta e conferir que a área interna abre sem a mensagem "Não foi possível carregar essa seção".
3. Sair da conta e confirmar que nenhum aviso de erro aparece durante a saída.
4. Entrar de novo com a mesma conta e confirmar que nenhum erro antigo é reapresentado.
5. Navegar pelas páginas principais (painel, contatos, negócios, conversas, configurações) já autenticado.
6. Recolher mensagens do console e chamadas de rede com falha em cada etapa, com captura de tela nos pontos-chave.

## Além disso

Rodar a bateria automatizada de ponta a ponta já existente (entrada, papéis de acesso, integrações, onboarding, troca de espaço de trabalho, rotas internas e automação de funil) e reportar o resultado.

## Detalhes técnicos

- Playwright já está configurado (`playwright.config.ts`, specs em `e2e/`); execução via `pnpm test:e2e` contra `http://localhost:8080`.
- O roteiro manual será um script Playwright em `/tmp/browser/` (fora do repositório), usando seletores por papel/aria, viewport 1280x1800, coletando `console` e `response` com status >= 400.
- Efeito colateral: será criada uma conta real de teste no banco atual (e o tenant/onboarding associado). Ao final, informo quais registros foram criados para que possam ser removidos, se desejado.
- Nada de RLS, políticas ou dados existentes será alterado; nenhuma migration será criada.

## Entrega

Relatório em chat com: resultado de cada etapa, referências de erro caso apareçam, resumo da bateria automatizada e o que ficou pendente.
