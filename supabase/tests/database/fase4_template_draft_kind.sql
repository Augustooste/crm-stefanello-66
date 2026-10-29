-- Fase 4 (user story C) — create_template_draft() estendido com p_kind/
-- p_provider_template_name (supabase/migrations/
-- 20260710160000_fase4_template_draft_kind.sql). Roda contra o shadow DB
-- local (supabase test db --local; pnpm test:db) -- NÃO rodar aqui agora
-- (mesma decisão da Fase 4: agentes de schema em paralelo compartilham a
-- Postgres local; execução fica pro agente de sincronização depois que os
-- grupos da Fase 4 terminarem).
begin;
create extension if not exists pgtap;

select plan(9);

-- Fixture: 1 tenant admin (via handle_new_user, trigger em auth.users).
insert into auth.users (id, email) values
  ('55555555-5555-5555-5555-555555555555', 'admin-kind@test.local');

-- Fixture: convite + usuário não-admin (role='agent') no MESMO tenant, pro
-- teste de Unauthorized -- mesmo padrão de fase3_hitl_rpcs.sql (invites.token
-- precisa bater com raw_user_meta_data->>'invite_token').
insert into public.invites (tenant_id, email, role, token)
select tenant_id, 'agent-kind@test.local', 'agent', 'test-invite-token-kind'
from public.profiles where id = '55555555-5555-5555-5555-555555555555';

insert into auth.users (id, email, raw_user_meta_data) values
  ('66666666-6666-6666-6666-666666666666', 'agent-kind@test.local',
   jsonb_build_object('invite_token', 'test-invite-token-kind'));

create temp table tmp_kind_ids (key text primary key, id uuid);

select set_config(
  'request.jwt.claims',
  json_build_object('sub', '55555555-5555-5555-5555-555555555555', 'role', 'authenticated')::text,
  false
);

-- 1. chamada com só os 3 args antigos (sem p_kind/p_provider_template_name):
--    kind assume default 'freeform' e provider_template_name fica null --
--    regressão de compatibilidade com quem ainda chama a assinatura antiga
--    (o DROP+CREATE da migration troca a função, não empilha overload).
insert into tmp_kind_ids
select 'freeform_default',
  (public.create_template_draft(null, 'Template freeform', 'corpo livre') ->> 'id')::uuid;

select is(
  (select kind from public.messaging_templates where id = (select id from tmp_kind_ids where key = 'freeform_default')),
  'freeform',
  'create_template_draft: default p_kind=freeform quando omitido (assinatura antiga continua funcionando)'
);
select is(
  (select provider_template_name from public.messaging_templates where id = (select id from tmp_kind_ids where key = 'freeform_default')),
  null,
  'create_template_draft: provider_template_name null no default freeform'
);

-- 2. p_kind='provider_approved' com nome válido persiste kind e
--    provider_template_name (com trim de espaços nas pontas).
insert into tmp_kind_ids
select 'provider_ok',
  (public.create_template_draft(
    p_parent_id := null, p_name := 'Template aprovado', p_body := 'corpo referência',
    p_kind := 'provider_approved', p_provider_template_name := '  confirmacao_pedido_pt_br  '
  ) ->> 'id')::uuid;

select is(
  (select kind from public.messaging_templates where id = (select id from tmp_kind_ids where key = 'provider_ok')),
  'provider_approved',
  'create_template_draft: persiste kind=provider_approved'
);
select is(
  (select provider_template_name from public.messaging_templates where id = (select id from tmp_kind_ids where key = 'provider_ok')),
  'confirmacao_pedido_pt_br',
  'create_template_draft: provider_template_name é gravado com trim'
);

-- 3. p_kind='provider_approved' sem provider_template_name (null ou só
--    espaços) lança exceção -- validação de negócio dentro da RPC, antes do
--    insert.
select throws_ok(
  $$ select public.create_template_draft(p_parent_id := null, p_name := 'Sem nome provider', p_body := 'corpo', p_kind := 'provider_approved', p_provider_template_name := null) $$,
  'provider_template_name é obrigatório quando kind = provider_approved',
  'create_template_draft: provider_approved sem provider_template_name lança exceção'
);
select throws_ok(
  $$ select public.create_template_draft(p_parent_id := null, p_name := 'Nome provider em branco', p_body := 'corpo', p_kind := 'provider_approved', p_provider_template_name := '   ') $$,
  'provider_template_name é obrigatório quando kind = provider_approved',
  'create_template_draft: provider_approved com provider_template_name só espaços lança exceção'
);

-- 4. p_kind inválido (fora de freeform/provider_approved) lança exceção --
--    checagem da RPC dispara antes de qualquer tentativa de insert (que
--    também seria barrado pelo check constraint da coluna, mas não é isso
--    que estamos testando aqui).
select throws_ok(
  $$ select public.create_template_draft(p_parent_id := null, p_name := 'Kind inválido', p_body := 'corpo', p_kind := 'nao_existe') $$,
  'kind inválido: nao_existe',
  'create_template_draft: p_kind fora de (freeform, provider_approved) lança exceção'
);

-- 5. freeform explícito com provider_template_name preenchido: a coluna é
--    forçada a null (provider_template_name só é relevante/gravado quando
--    kind=provider_approved -- não vaza lixo pro freeform).
insert into tmp_kind_ids
select 'freeform_ignores_provider_name',
  (public.create_template_draft(
    p_parent_id := null, p_name := 'Freeform com lixo', p_body := 'corpo',
    p_kind := 'freeform', p_provider_template_name := 'nome_que_deveria_sumir'
  ) ->> 'id')::uuid;

select is(
  (select provider_template_name from public.messaging_templates where id = (select id from tmp_kind_ids where key = 'freeform_ignores_provider_name')),
  null,
  'create_template_draft: kind=freeform ignora/zera provider_template_name mesmo se informado'
);

-- 6. não-admin (role agent, mesmo tenant) continua bloqueado com a nova
--    assinatura -- a checagem de admin já é coberta em geral por
--    fase3_hitl_rpcs.sql; aqui é só pra fechar que ela roda ANTES da
--    validação de kind/provider_template_name (Unauthorized, não "kind
--    inválido").
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '66666666-6666-6666-6666-666666666666', 'role', 'authenticated')::text,
  false
);
select throws_ok(
  $$ select public.create_template_draft(p_parent_id := null, p_name := 'Não-admin kind', p_body := 'corpo', p_kind := 'provider_approved', p_provider_template_name := 'nome') $$,
  'Unauthorized',
  'create_template_draft: não-admin (role agent) é bloqueado mesmo passando kind/provider_template_name'
);

select * from finish();
rollback;
