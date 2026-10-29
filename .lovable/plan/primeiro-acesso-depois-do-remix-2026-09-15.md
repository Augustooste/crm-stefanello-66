# Primeiro acesso depois do remix

## O que está acontecendo

Ao remixar, o clone recebe um banco de dados **novo e vazio**. Nenhuma conta de usuário é copiada — as contas existem só neste projeto (hoje são 5, todas confirmadas). Daí os dois sintomas:

- **"Senha inválida"**: o e-mail usado não existe no ambiente novo, e a resposta padrão para e-mail desconhecido é exatamente "credenciais inválidas". Não é senha errada; é conta inexistente.
- **O link de redefinição não avança**: pedir redefinição para um e-mail que não existe sempre responde "enviamos o link", mas nada é enviado. E, mesmo com conta existente, o ambiente recém-criado ainda não tem envio de e-mail ativo nem o endereço do clone liberado para retorno do link — então o link não chega ou volta expirado.

Confirmado na leitura do projeto: o cadastro sem convite já cria automaticamente a empresa e o perfil de administrador do primeiro usuário. Ou seja, **o caminho certo no clone é criar conta, não recuperar senha** — a tela só não diz isso.

## O que vou fazer

1. **Detectar ambiente sem nenhuma conta.** Uma consulta mínima e segura ao banco (devolve apenas sim/não, sem expor dados) informa à tela de entrada se o ambiente ainda está vazio.
2. **Tela de primeiro acesso.** Quando o ambiente está vazio, a tela abre no modo "Criar a conta do administrador", com aviso explicando que este ambiente é novo e que as contas do projeto de origem não vêm junto. Some o campo de senha de entrada e o link "esqueci a senha" nesse estado.
3. **Recuperação de senha mais honesta.** Depois de pedir o link, a tela passa a mostrar: se o e-mail não chegar em alguns minutos, é provável que a conta não exista neste ambiente ou que o envio de e-mail ainda não esteja ativo — com atalho direto para criar a conta.
4. **Confirmação de e-mail no primeiro acesso.** Vou ligar a confirmação automática de cadastro por e-mail/senha, para que o clone funcione sem depender de envio de e-mail. Sem isso, todo remix fica travado no mesmo ponto até o dono configurar um remetente.
5. **Registro no onboarding e no README**, em uma linha: "o primeiro acesso do remix é criar a conta; ela vira administradora do ambiente".

## Detalhes técnicos

- Nova migration idempotente com `public.tem_alguma_conta()`: `SECURITY DEFINER`, `SET search_path = public`, retorna `boolean` a partir de `count(*) > 0` em `auth.users`, `REVOKE EXECUTE FROM PUBLIC` e `GRANT EXECUTE TO anon, authenticated`. Nenhum dado de usuário é exposto.
- `src/routes/auth.tsx`: novo estado `primeiroAcesso` alimentado por essa RPC (falha na chamada = comportamento atual, sem travar a tela); ajustes de cópia nos modos `signin`, `signup` e `recovery`. Fluxo de `update` fica como está — já volta para `recovery` quando o link chega expirado.
- `supabase--configure_auth` com `auto_confirm_email = true`, mantendo cadastro aberto e a verificação de senha vazada ligada.
- Testes: cobertura para ambiente vazio (abre em criar conta), ambiente com conta (abre em entrar) e falha da RPC (não quebra a tela).

## Fora deste plano

O erro "Remix failed while copying the project's integrations" é outro problema, da plataforma, e continua dependendo do suporte.
