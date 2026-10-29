-- Task 9: permissão developer.manage governa webhooks (Task 2) e chaves de API (Task 6).
-- Rodar: pnpm test:db.
begin;
create extension if not exists pgtap;

select plan(30);

-- Fixture: admin A, admin B (outro tenant) e agente C (convite no tenant A).
insert into auth.users (id, email) values
  ('a9000000-0000-4000-8000-00000000000a', 'dev-adm-a@test.local'),
  ('a9000000-0000-4000-8000-00000000000b', 'dev-adm-b@test.local');
insert into public.invites (tenant_id, email, role, token, expires_at)
select tenant_id, 'dev-agente-c@test.local', 'agent', 'dev-perm-agent-token', now() + interval '1 day'
from public.profiles where id = 'a9000000-0000-4000-8000-00000000000a';
insert into auth.users (id, email, raw_user_meta_data) values
  ('a9000000-0000-4000-8000-00000000000c', 'dev-agente-c@test.local',
   '{"invite_token":"dev-perm-agent-token"}');

-- 1-4. Catálogo e concessão por papel (admin sim, agent não), inclusive tenants criados pelo trigger.
select ok(
  exists (select 1 from public.permissions where permission_key = 'developer.manage'),
  'permissão developer.manage existe no catálogo'
);
select is(
  (select count(*)::int from public.roles r
    where r.role_key = 'admin'
      and not exists (select 1 from public.role_permissions rp
                      join public.permissions p on p.id = rp.permission_id
                      where rp.role_id = r.id and p.permission_key = 'developer.manage')),
  0,
  'todo papel admin (inclusive de tenants novos) tem developer.manage'
);
select is(
  (select count(*)::int from public.role_permissions rp
     join public.permissions p on p.id = rp.permission_id
     join public.roles r on r.id = rp.role_id
    where p.permission_key = 'developer.manage' and r.role_key <> 'admin'),
  0,
  'nenhum papel além de admin tem developer.manage'
);
select ok(
  exists (select 1 from public.roles r
            join public.tenant_memberships m on m.role_id = r.id
           where m.user_id = 'a9000000-0000-4000-8000-00000000000c' and r.role_key = 'agent'),
  'fixture: C é agent no tenant A'
);

-- Admin B perde a permissão (papel sem developer.manage, mas ainda admin legado).
delete from public.role_permissions rp
 using public.permissions p, public.tenant_memberships m
 where p.id = rp.permission_id and p.permission_key = 'developer.manage'
   and m.role_id = rp.role_id and m.user_id = 'a9000000-0000-4000-8000-00000000000b';

-- Dados do tenant B (como dono do banco) para provar o filtro das policies.
insert into public.webhook_endpoints (tenant_id, url, event_types)
select tenant_id, 'https://b.example.com/hook', array['deal.won']
from public.profiles where id = 'a9000000-0000-4000-8000-00000000000b';
insert into public.api_keys (tenant_id, name, key_prefix, key_hash, scopes)
select tenant_id, 'chave B', 'acf_live_bbb', 'hash-b', array['contacts:read']
from public.profiles where id = 'a9000000-0000-4000-8000-00000000000b';

-- 5-8. Anon sem grants nas tabelas e sem EXECUTE nas RPCs.
select ok(
  not exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ('webhook_endpoints', 'webhook_deliveries', 'api_keys')
      and grantee in ('anon', 'PUBLIC')
  ) and not exists (
    select 1 from information_schema.role_column_grants
    where table_schema = 'public'
      and table_name in ('webhook_endpoints', 'webhook_deliveries', 'api_keys')
      and grantee in ('anon', 'PUBLIC')
  ),
  'anon/PUBLIC continua sem nenhum grant nas 3 tabelas'
);
select ok(
  not has_function_privilege('anon', 'public.create_webhook_endpoint(text,text[],text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.create_api_key(text,text[],timestamptz)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.revoke_api_key(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.redeliver_webhook(uuid)', 'EXECUTE'),
  'anon não executa as RPCs recriadas'
);
select ok(
  has_function_privilege('authenticated', 'public.create_webhook_endpoint(text,text[],text)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.create_api_key(text,text[],timestamptz)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.revoke_api_key(uuid)', 'EXECUTE'),
  'authenticated mantém EXECUTE nas RPCs'
);
select ok(
  not has_function_privilege('authenticated', 'public.authenticate_api_key(text)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.authenticate_api_key(text)', 'EXECUTE'),
  'authenticate_api_key segue só para service_role'
);

-- 9-10. Corpos e policies usam developer.manage, não is_admin.
select is(
  (select count(*)::int from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('create_webhook_endpoint', 'rotate_webhook_endpoint_secret',
                        'set_webhook_endpoint_active', 'delete_webhook_endpoint',
                        'send_test_webhook', 'redeliver_webhook',
                        'create_api_key', 'revoke_api_key',
                        -- v1.1 (20261020160000): sobrecarga de 5 parâmetros + edição
                        'update_webhook_endpoint')
      and pg_get_functiondef(p.oid) like '%developer.manage%'
      and pg_get_functiondef(p.oid) not like '%is_admin%'),
  10,
  '10 RPCs (create_webhook_endpoint com 2 sobrecargas) exigem developer.manage e não usam is_admin'
);
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public'
      and policyname in ('webhook_endpoints admin select', 'webhook_deliveries admin select', 'api_keys_select_admin')
      and qual like '%developer.manage%' and qual not like '%is_admin%'),
  3,
  '3 policies de SELECT exigem developer.manage e não usam is_admin'
);

-- Admin A (tem a permissão): cria e enxerga.
select set_config('request.jwt.claims', '{"sub":"a9000000-0000-4000-8000-00000000000a","role":"authenticated"}', false);
set local role authenticated;

-- 11. has_permission verdadeiro.
select ok(private.has_permission('developer.manage'), 'admin A tem developer.manage');

-- 12-13. RPCs funcionam.
create temp table t_ep on commit drop as
  select * from public.create_webhook_endpoint('https://a.example.com/hook', array['deal.won']);
grant all on t_ep to public;
select ok((select id is not null and secret like 'whsec\_%' from t_ep), 'admin A cria endpoint de webhook');
create temp table t_key on commit drop as
  select * from public.create_api_key('chave A', array['contacts:read']);
grant all on t_key to public;
select matches((select token from t_key), '^acf_live_', 'admin A cria chave de API');

-- 14-16. Demais RPCs de webhook funcionam para quem tem a permissão.
select lives_ok($$ select public.send_test_webhook((select id from t_ep)) $$, 'admin A envia webhook de teste');
select lives_ok($$ select public.rotate_webhook_endpoint_secret((select id from t_ep)) $$, 'admin A rotaciona segredo');
select lives_ok($$ select public.revoke_api_key((select id from t_key)) $$, 'admin A revoga chave');

-- 17-19. Policies de SELECT: A vê só o próprio tenant.
select is((select count(*)::int from public.webhook_endpoints), 1, 'admin A vê 1 endpoint (o do tenant dele)');
select is((select count(*)::int from public.webhook_deliveries), 1, 'admin A vê 1 entrega');
select is((select count(*)::int from public.api_keys), 1, 'admin A vê 1 chave');

-- Agente C (sem a permissão).
select set_config('request.jwt.claims', '{"sub":"a9000000-0000-4000-8000-00000000000c","role":"authenticated"}', false);

-- 20-22. Agent não tem a permissão nem lê as tabelas do próprio tenant.
select ok(not private.has_permission('developer.manage'), 'agente C não tem developer.manage');
select is((select count(*)::int from public.webhook_endpoints), 0, 'agente C não vê endpoints');
select is(
  (select (select count(*)::int from public.webhook_deliveries) + (select count(*)::int from public.api_keys)),
  0, 'agente C não vê entregas nem chaves'
);

-- 23-25. Agent não executa RPCs de criação.
select throws_ok(
  $$ select * from public.create_webhook_endpoint('https://c.example.com/hook', array['deal.won']) $$,
  '42501', 'permission denied', 'agente C não cria endpoint'
);
select throws_ok(
  $$ select * from public.create_api_key('chave C', array['contacts:read']) $$,
  '42501', null, 'agente C não cria chave de API'
);
select throws_ok(
  $$ select public.send_test_webhook((select id from t_ep)) $$,
  '42501', 'permission denied', 'agente C não envia webhook de teste'
);

-- Admin B (papel admin, mas sem developer.manage): a checagem é pela permissão, não pelo papel.
select set_config('request.jwt.claims', '{"sub":"a9000000-0000-4000-8000-00000000000b","role":"authenticated"}', false);

-- 26-27. Sem a permissão, nega mesmo sendo admin do próprio tenant.
select throws_ok(
  $$ select * from public.create_webhook_endpoint('https://b2.example.com/hook', array['deal.won']) $$,
  '42501', 'permission denied', 'admin B sem developer.manage não cria endpoint'
);
select throws_ok(
  $$ select * from public.create_api_key('chave B2', array['contacts:read']) $$,
  '42501', null, 'admin B sem developer.manage não cria chave de API'
);

-- 28-29. Policies também negam leitura sem a permissão.
select is((select count(*)::int from public.webhook_endpoints), 0, 'admin B sem developer.manage não vê o próprio endpoint');
select is((select count(*)::int from public.api_keys), 0, 'admin B sem developer.manage não vê a própria chave');

-- 30. Anon continua sem acesso.
reset role;
set local role anon;
select throws_ok($$ select 1 from public.api_keys $$, '42501', null, 'anon não lê api_keys');

select * from finish();
rollback;
