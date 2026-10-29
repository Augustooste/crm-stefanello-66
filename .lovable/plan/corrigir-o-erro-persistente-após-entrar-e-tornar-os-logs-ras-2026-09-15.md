# Corrigir o erro persistente após entrar e tornar os logs rastreáveis

## Diagnóstico confirmado

- A autenticação funcionou às **20:28:07 UTC**.
- A referência exibida, `37809a05 · 42501`, está gravada em `system_events` como `permission denied for table hitl_decisions`.
- A consulta que originou o erro ocorreu durante a saída, às **20:27:47 UTC**, já sem sessão; no mesmo instante, outras leituras do painel também receberam 401/42501.
- O registro foi enviado somente após a nova entrada, com `has_session=true`. Portanto, o horário e o estado de sessão atuais mascararam a origem real: a tela reaproveitou um erro pendente da sessão anterior.
- A conta atual está corretamente provisionada como administradora, com membership ativo e 28 permissões. Não há motivo para ampliar RLS ou conceder acesso anônimo.

## Implementação

1. **Tornar a troca de sessão atômica**
   - Centralizar a transição de entrada/saída para cancelar consultas, limpar erros e cache da identidade anterior e só então navegar.
   - Na entrada, invalidar o estado antigo do roteador antes de abrir `/app`, impedindo que o boundary reapresente o `42501` da sessão encerrada.
   - Evitar navegações duplicadas entre o retorno do login e `onAuthStateChange`.

2. **Impedir leituras protegidas durante transições**
   - Bloquear as consultas globais do cabeçalho, notificações e dashboard enquanto a identidade estiver mudando.
   - Revisar os hooks irmãos que montam junto com o layout para aplicar o mesmo gate de sessão, sem alterar políticas do banco.

3. **Otimizar a telemetria**
   - Preservar, desde a primeira captura, a referência, o horário real do erro, a operação/query e o estado da sessão naquele momento.
   - Usar armazenamento em memória por objeto de erro para manter a mesma referência mesmo em erros congelados.
   - Quando um erro for registrado depois, enviar `observed_at`, `reported_at`, atraso do registro, rota, boundary e operação original; manter redação de e-mail, telefone, tokens e segredos.
   - Diferenciar explicitamente `erro durante logout`, `erro após login` e `permissão realmente negada` para que o horário do envio não seja confundido com o horário da falha.
   - Manter o registro restrito a usuários autenticados e sem abrir tabelas para visitantes.

4. **Melhorar a tela de erro**
   - Fazer “Tentar novamente” limpar o erro e as consultas falhas antes de recarregar a seção.
   - Mostrar ao administrador a operação afetada e o horário real, quando disponíveis, mantendo para os demais apenas a referência segura.

5. **Validar a correção**
   - Testar saída com consultas em andamento, nova entrada na mesma aba e troca entre contas.
   - Confirmar que erros antigos não reaparecem, que um 42501 real gera uma única referência correlacionável e que nenhum dado sensível entra no log.
   - Rodar os testes direcionados de autenticação, cache, roteador, telemetria e tela de erro, além da verificação de tipos e compilação.

## Limites de segurança

- Não conceder acesso anônimo a `hitl_decisions`, `deals`, `contacts`, `conversations` ou outras tabelas protegidas.
- Não afrouxar RLS.
- Não registrar payloads livres, credenciais ou dados pessoais.
- Não zerar a base nem alterar os dados da conta atual.
