# Criar membros da equipe com senha definida

Objetivo: as oito pessoas abaixo passam a entrar no mesmo workspace da conta
`executivo.expansao@msaparticipacoes.com.br` (MSA Participações), como
administradores, usando a senha `Acelera@2026`.

## Contas a criar

| Pessoa | E-mail |
| --- | --- |
| Liderry | expansao@aceleraia.ia.br |
| Cerqueira | gestao.relacional@aceleraia.ia.br |
| Fernanda | executiva.expansao@aceleraia.ia.br |
| Joeverton | gestao.relacionamento@aceleraia.ia.br |
| Richard | executivo.expansao@aceleraia.ia.br |
| Raphael Silva | gestao.experiencia@aceleraia.ia.br |
| Thiago | executivo.resultados@aceleraia.ia.br |
| Zayra Lima | executiva.negocios@aceleraia.ia.br |

Todas com papel de administrador e e-mail já confirmado — ninguém precisa clicar
em link de confirmação para entrar.

## Nova opção em Configurações → Equipe

Hoje a tela de Equipe só permite convidar por link. Ela ganha um segundo caminho,
visível apenas para administradores:

- Botão "Adicionar membro" abre um formulário com nome, e-mail, papel
  (Administrador ou Atendente) e senha inicial.
- A conta é criada na hora, já dentro do workspace de quem está criando, e a
  pessoa aparece imediatamente na lista de membros.
- Mensagens de erro em português para os casos reais: e-mail já cadastrado,
  senha curta demais, e-mail inválido, sem permissão.
- A tela avisa que a senha inicial deve ser trocada pela pessoa no primeiro
  acesso.

Depois de pronta a tela, uso essa mesma função uma vez para criar as oito contas
acima.

## Segurança

- A criação roda no servidor, nunca no navegador: a chave privilegiada não sai
  do ambiente protegido.
- O workspace de destino nunca vem do formulário — é derivado da sessão de quem
  está pedindo. Assim ninguém consegue inserir membro em workspace alheio.
- Só administrador do workspace pode criar membro; atendente recebe recusa.
- Senha nunca é gravada em log nem em tabela do banco.

## Detalhes técnicos

- Nova Edge Function `team-create-member`:
  1. valida o JWT da requisição e resolve `user_id` e `tenant_id` pela sessão;
  2. confirma papel admin via `tenant_memberships`/`profiles` (falha fechada);
  3. valida entrada com esquema (nome, e-mail, papel `admin|agent`, senha mínima
     de 8 caracteres);
  4. grava um convite interno (`invites`) para o e-mail, com o papel e um token
     de uso único;
  5. chama `auth.admin.createUser` com `email_confirm: true` e
     `user_metadata: { name, invite_token }`;
  6. se a criação falhar, apaga o convite (sem deixar convite órfão).
- O caminho pelo convite é proposital: o gatilho `handle_new_user` já existente
  reconhece o `invite_token` e vincula o perfil ao tenant do convite em vez de
  abrir um workspace novo. O gatilho `profiles_sync_tenant_membership` cria o
  vínculo de RBAC automaticamente — nenhuma migration de schema é necessária.
- Front-end: `src/lib/api/team.ts` com `createTeamMember()` chamando
  `supabase.functions.invoke`, e um diálogo novo em
  `src/components/settings/TeamTab.tsx` (tokens do DS, `forceMount` nas abas,
  `onError` com `userFacingErrorMessage()`), invalidando a query da equipe.
- Testes: unitário da função (admin cria, atendente recebe 403, e-mail duplicado
  vira mensagem tratada, convite removido em falha) e de componente do diálogo.
- Execução final: chamada única da função para os oito e-mails, seguida de
  conferência no banco (perfil no tenant MSA + vínculo ativo como admin) e de um
  login de verificação com uma das contas.
