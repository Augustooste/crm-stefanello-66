# Corrigir erro 42501 ao sair do aplicativo

## Diagnóstico confirmado

- O registro do banco mostra `permission denied for table niche_templates` às **20:11:13**, exatamente no momento do logout.
- A sessão é removida antes de a área interna desmontar; nesse intervalo, o cache é limpo e uma consulta protegida é refeita como visitante, recebendo `42501`.
- Dois segundos depois, o registro automático dessa falha também tenta executar `log_client_error` sem sessão e recebe outro `42501`. Essa segunda falha não é a origem, mas dificulta o diagnóstico.
- As permissões e políticas de `niche_templates` estão corretas para usuários autenticados. A correção não deve liberar esse catálogo para visitantes nem afrouxar RLS.

## Implementação

1. **Tornar o logout atômico**
   - Marcar a saída antes de encerrar a sessão.
   - Cancelar consultas autenticadas em andamento e impedir novos carregamentos da área interna durante a transição.
   - Limpar os dados da conta anterior e concluir a navegação para `/auth` sem deixar a tela protegida refazer consultas como visitante.
   - Exibir falha tratada caso o logout não conclua, em vez de deixar a interface em estado inconsistente.

2. **Proteger consultas do shell autenticado**
   - Fazer a consulta de modelos de nicho respeitar o estado da sessão/saída, pois hoje ela pode rodar incondicionalmente enquanto a área interna ainda está montada.
   - Revisar os demais carregamentos iniciais do shell para garantir que nenhum deles execute depois de `SIGNED_OUT`.

3. **Evitar a falha secundária de telemetria**
   - Manter `log_client_error` restrita a usuários autenticados.
   - Não tentar registrar no banco erros ocorridos após a sessão ter sido encerrada; manter apenas o registro local seguro nesse caso.

4. **Cobertura de regressão**
   - Testar que clicar em “Sair” cancela/encerra os carregamentos protegidos antes da remoção da sessão.
   - Testar que `niche_templates` não é consultada após `SIGNED_OUT`.
   - Testar que a telemetria não chama a função protegida quando não existe sessão.
   - Preservar os testes de login, primeiro acesso e recuperação de senha já adicionados.

5. **Validação final**
   - Rodar os testes direcionados, verificação de tipos e confirmar o build automático.
   - Executar um fluxo real de login e logout no navegador.
   - Conferir que a saída termina em `/auth`, sem a tela “Não foi possível carregar essa seção” e sem novos eventos `42501` nos registros do banco.

## Limites

- Não alterar as políticas RLS nem conceder acesso anônimo aos catálogos.
- Não mexer no banco de usuários, dados demonstrativos ou no problema separado de cópia de integrações durante o remix.
