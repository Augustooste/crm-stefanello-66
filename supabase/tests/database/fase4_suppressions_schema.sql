-- Fase 4 (user story H) — supressão de telefone: existência/estrutura do
-- schema (rodar: pnpm test:db). Roda contra o shadow DB local (supabase
-- test db --local), que reaplica todas as migrations do zero -- não toca a
-- DB real do Lovable.
begin;
create extension if not exists pgtap;

select plan(17);

-- 1. Tabela existe.
select has_table('public', 'messaging_phone_suppressions', 'tabela messaging_phone_suppressions existe');

-- 2. RLS habilitada, nunca FORCE (convenção real do projeto).
select ok(
  (select relrowsecurity from pg_class where oid = 'public.messaging_phone_suppressions'::regclass),
  'RLS habilitada em messaging_phone_suppressions'
);
select ok(
  not (select relforcerowsecurity from pg_class where oid = 'public.messaging_phone_suppressions'::regclass),
  'RLS NÃO forçada em messaging_phone_suppressions (convenção real do projeto)'
);

-- 3. Constraint unique(tenant_id, phone, scope) existe.
select ok(
  exists (
    select 1
    from pg_constraint
    where conrelid = 'public.messaging_phone_suppressions'::regclass
      and contype = 'u'
      and conkey = (
        select array_agg(attnum order by attnum)
        from pg_attribute
        where attrelid = 'public.messaging_phone_suppressions'::regclass
          and attname in ('tenant_id', 'phone', 'scope')
      )
  ),
  'constraint unique(tenant_id, phone, scope) existe'
);

-- 4. Nenhuma policy de INSERT/UPDATE para authenticated (só service_role
--    escreve nesta fase -- gestão manual e parsing de keyword são futuros).
select is(
  (select count(*)::int from pg_policies
    where tablename = 'messaging_phone_suppressions' and cmd = 'INSERT' and 'authenticated' = any(roles)),
  0,
  'nenhuma policy de INSERT para authenticated em messaging_phone_suppressions'
);
select is(
  (select count(*)::int from pg_policies
    where tablename = 'messaging_phone_suppressions' and cmd = 'UPDATE' and 'authenticated' = any(roles)),
  0,
  'nenhuma policy de UPDATE para authenticated em messaging_phone_suppressions'
);

-- 5. Constraint unique(tenant_id, phone, scope) -- comportamento real (não
--    só existência, testada na seção 3 acima).
insert into auth.users (id, email) values
  ('77777777-7777-7777-7777-777777777777', 'admin-suppressions@test.local');

insert into public.messaging_phone_suppressions (tenant_id, phone, scope, reason)
select tenant_id, '+5511999990000', 'phone', 'keyword PARAR'
from public.profiles where id = '77777777-7777-7777-7777-777777777777';

-- pgTAP: throws_ok(sql, errcode, errmsg, description) -- forma de 4 args com
-- errmsg=NULL checa só o SQLSTATE (23505 = unique_violation) e usa o 4º
-- parâmetro como description (mesmo padrão de fase4_broadcast_schema.sql).
select throws_ok(
  $$insert into public.messaging_phone_suppressions (tenant_id, phone, scope, reason)
    select tenant_id, '+5511999990000', 'phone', 'duplicado' from public.profiles
    where id = '77777777-7777-7777-7777-777777777777'$$,
  '23505',
  NULL,
  'insert duplicado (mesmo tenant_id+phone+scope) é rejeitado pela constraint unique (23505)'
);

-- Mesmo tenant_id+phone, scope diferente -- constraint composta não bloqueia.
insert into public.messaging_phone_suppressions (tenant_id, phone, scope, reason)
select tenant_id, '+5511999990000', 'contact', 'opt-out manual'
from public.profiles where id = '77777777-7777-7777-7777-777777777777';

select is(
  (select count(*)::int from public.messaging_phone_suppressions
    where phone = '+5511999990000'),
  2,
  'mesmo tenant_id+phone com scope diferente (contact) é aceito -- constraint composta não bloqueia'
);

-- =============================================================================
-- add_manual_phone_suppression / reactivate_phone_suppression (Fase 4 PR-B)
-- -- RPCs de gestão manual, security definer, gated por private.is_admin().
-- =============================================================================

-- Fixture: agente (não-admin) no MESMO tenant do admin 77777777, via
-- convite -- mesmo padrão de fase3_hitl_rpcs.sql (handle_new_user exige
-- invites.token == raw_user_meta_data->>'invite_token').
insert into public.invites (tenant_id, email, role, token)
select tenant_id, 'agent-suppressions@test.local', 'agent', 'test-invite-suppressions-token'
from public.profiles where id = '77777777-7777-7777-7777-777777777777';

insert into auth.users (id, email, raw_user_meta_data) values
  ('12121212-1212-1212-1212-121212121212', 'agent-suppressions@test.local',
   jsonb_build_object('invite_token', 'test-invite-suppressions-token'));

-- Fixture: admin de um SEGUNDO tenant (sem invite -- handle_new_user cria
-- tenant novo pra usuário sem invite_token válido), pra teste cross-tenant.
insert into auth.users (id, email) values
  ('34343434-3434-3434-3434-343434343434', 'admin-tenant-b-suppressions@test.local');

-- 9-11. add_manual_phone_suppression: admin cria supressão manual no
--       PRÓPRIO tenant -- reason/source/reactivated_at corretos.
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '77777777-7777-7777-7777-777777777777', 'role', 'authenticated')::text,
  false
);

create temp table tmp_manual_suppression_id (id uuid);
insert into tmp_manual_suppression_id
select (public.add_manual_phone_suppression('+5511988880000', 'Pedido do cliente por telefone')).id;

select is(
  (select reason from public.messaging_phone_suppressions where id = (select id from tmp_manual_suppression_id)),
  'Pedido do cliente por telefone',
  'add_manual_phone_suppression: grava reason informado'
);
select is(
  (select source from public.messaging_phone_suppressions where id = (select id from tmp_manual_suppression_id)),
  'manual',
  'add_manual_phone_suppression: source = manual (nunca keyword)'
);
select ok(
  (select reactivated_at is null from public.messaging_phone_suppressions where id = (select id from tmp_manual_suppression_id)),
  'add_manual_phone_suppression: reactivated_at começa null'
);

-- 12. add_manual_phone_suppression: não-admin (role agent) é bloqueado.
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '12121212-1212-1212-1212-121212121212', 'role', 'authenticated')::text,
  false
);
select throws_ok(
  $$ select public.add_manual_phone_suppression('+5511977770000', 'tentativa não-admin') $$,
  'Unauthorized',
  'add_manual_phone_suppression: não-admin (role agent) é bloqueado'
);

-- 13. add_manual_phone_suppression: chamar de novo pro MESMO telefone é
--     upsert idempotente (não lança unique_violation) e atualiza reason.
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '77777777-7777-7777-7777-777777777777', 'role', 'authenticated')::text,
  false
);
select public.add_manual_phone_suppression('+5511988880000', 'Motivo atualizado');
select is(
  (select reason from public.messaging_phone_suppressions where id = (select id from tmp_manual_suppression_id)),
  'Motivo atualizado',
  'add_manual_phone_suppression: chamar de novo (mesmo telefone) atualiza reason via upsert, sem 23505'
);

-- 14. reactivate_phone_suppression: admin reativa supressão do PRÓPRIO
--     tenant.
select public.reactivate_phone_suppression((select id from tmp_manual_suppression_id));
select ok(
  (select reactivated_at is not null from public.messaging_phone_suppressions where id = (select id from tmp_manual_suppression_id)),
  'reactivate_phone_suppression: seta reactivated_at'
);

-- 15. reactivate_phone_suppression: não-admin (role agent) é bloqueado.
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '12121212-1212-1212-1212-121212121212', 'role', 'authenticated')::text,
  false
);
select throws_ok(
  $$ select public.reactivate_phone_suppression((select id from tmp_manual_suppression_id)) $$,
  'Unauthorized',
  'reactivate_phone_suppression: não-admin (role agent) é bloqueado'
);

-- 16. reactivate_phone_suppression: admin de OUTRO tenant é bloqueado
--     (cross-tenant), mesmo sendo admin de verdade -- só não é do tenant
--     dono da supressão.
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '34343434-3434-3434-3434-343434343434', 'role', 'authenticated')::text,
  false
);
select throws_ok(
  $$ select public.reactivate_phone_suppression((select id from tmp_manual_suppression_id)) $$,
  'Unauthorized',
  'reactivate_phone_suppression: admin de outro tenant é bloqueado (cross-tenant)'
);

-- 17. reactivate_phone_suppression: id inexistente lança "Suppression not
--     found" (checagem de is_admin roda antes -- precisa de um admin de
--     verdade pra chegar nesse ponto).
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '77777777-7777-7777-7777-777777777777', 'role', 'authenticated')::text,
  false
);
select throws_ok(
  $$ select public.reactivate_phone_suppression('00000000-0000-0000-0000-000000000001') $$,
  'Suppression not found',
  'reactivate_phone_suppression: id inexistente lança exceção'
);

select * from finish();
rollback;
