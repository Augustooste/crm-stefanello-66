-- Endpoints de webhook, entregas e segredo no vault (Task 2).
-- Roda no shadow DB local: pnpm test:db.
begin;
create extension if not exists pgtap;
select plan(83);

set session_replication_role = replica;
insert into public.tenants(id, name) values
 ('f5000000-0000-4000-8000-000000000001', 'Webhook A'),
 ('f5000000-0000-4000-8000-000000000002', 'Webhook B');
insert into auth.users(id, email) values
 ('f5000000-0000-4000-8000-000000000011', 'wh-admin-a@test.invalid'),
 ('f5000000-0000-4000-8000-000000000012', 'wh-admin-b@test.invalid'),
 ('f5000000-0000-4000-8000-000000000013', 'wh-member@test.invalid');
insert into public.profiles(id, tenant_id, name, role) values
 ('f5000000-0000-4000-8000-000000000011', 'f5000000-0000-4000-8000-000000000001', 'Admin A', 'admin'),
 ('f5000000-0000-4000-8000-000000000012', 'f5000000-0000-4000-8000-000000000002', 'Admin B', 'admin'),
 ('f5000000-0000-4000-8000-000000000013', 'f5000000-0000-4000-8000-000000000001', 'Membro A', 'agent');
insert into public.roles(tenant_id, role_key, name, is_system) values
 ('f5000000-0000-4000-8000-000000000001', 'admin', 'Admin', true),
 ('f5000000-0000-4000-8000-000000000001', 'agent', 'Membro', true),
 ('f5000000-0000-4000-8000-000000000002', 'admin', 'Admin', true);
insert into public.role_permissions(role_id, permission_id)
 select r.id, p.id from public.roles r cross join public.permissions p
 where r.tenant_id in ('f5000000-0000-4000-8000-000000000001', 'f5000000-0000-4000-8000-000000000002')
   and r.role_key = 'admin';
insert into public.tenant_memberships(tenant_id, user_id, role_id, status)
 select p.tenant_id, p.id, r.id, 'active' from public.profiles p join public.roles r
 on r.tenant_id = p.tenant_id and r.role_key = p.role
 where p.id in ('f5000000-0000-4000-8000-000000000011', 'f5000000-0000-4000-8000-000000000012', 'f5000000-0000-4000-8000-000000000013');
insert into public.domain_events(id, tenant_id, event_type, aggregate_type, aggregate_id, idempotency_key) values
 ('f5000000-0000-4000-8000-0000000000e1', 'f5000000-0000-4000-8000-000000000001', 'deal.won', 'deal', gen_random_uuid(), 'wh-test-1'),
 ('f5000000-0000-4000-8000-0000000000e2', 'f5000000-0000-4000-8000-000000000001', 'deal.won', 'deal', gen_random_uuid(), 'wh-test-2'),
 ('f5000000-0000-4000-8000-0000000000e3', 'f5000000-0000-4000-8000-000000000001', 'deal.won', 'deal', gen_random_uuid(), 'wh-test-3');
set session_replication_role = default;

-- Estrutura e lista permitida
select has_table('public', 'webhook_endpoints', 'tabela de endpoints existe');
select has_table('public', 'webhook_deliveries', 'tabela de entregas existe');
select is(
  public.webhook_allowed_event_types(),
  array['deal.won', 'deal.lost', 'deal.stage_changed', 'contact.created'],
  'lista permitida de event_types'
);

-- Grants: anon zero; authenticated só SELECT
select is(
  (select count(*)::int from information_schema.role_table_grants
    where table_schema = 'public' and grantee in ('anon', 'PUBLIC')
      and table_name in ('webhook_endpoints', 'webhook_deliveries')),
  0, 'anon/PUBLIC sem nenhum grant nas tabelas novas'
);
select is(
  (select count(*)::int from information_schema.role_table_grants
    where table_schema = 'public' and grantee = 'authenticated'
      and table_name in ('webhook_endpoints', 'webhook_deliveries')
      and privilege_type <> 'SELECT'),
  0, 'authenticated só tem SELECT nas tabelas novas'
);
select is(
  (select count(*)::int from information_schema.role_table_grants
    where table_schema = 'public' and grantee = 'authenticated'
      and table_name in ('webhook_endpoints', 'webhook_deliveries')),
  0, 'authenticated sem grant de tabela inteira (só por coluna)'
);
select is(
  (select string_agg(column_name::text, ',' order by column_name) from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'webhook_endpoints' and grantee = 'authenticated' and privilege_type = 'SELECT'
      and column_name in ('vault_secret_id', 'previous_vault_secret_id')),
  null, 'authenticated sem SELECT nas colunas de vault'
);
select is(
  (select string_agg(column_name::text, ',' order by column_name) from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'webhook_deliveries' and grantee = 'authenticated' and privilege_type = 'SELECT'
      and column_name in ('locked_by', 'locked_at')),
  null, 'authenticated sem SELECT em locked_by e locked_at'
);
select ok(not has_function_privilege('anon', 'public.create_webhook_endpoint(text,text[],text)', 'EXECUTE'), 'anon não executa create_webhook_endpoint');
select ok(has_function_privilege('authenticated', 'public.create_webhook_endpoint(text,text[],text)', 'EXECUTE'), 'authenticated executa create_webhook_endpoint');
select ok(not has_function_privilege('authenticated', 'public.get_webhook_secrets(uuid)', 'EXECUTE'), 'authenticated não executa get_webhook_secrets');
select ok(not has_function_privilege('authenticated', 'public.claim_webhook_deliveries(int,text)', 'EXECUTE'), 'authenticated não executa claim_webhook_deliveries');
select ok(has_function_privilege('service_role', 'public.get_webhook_secrets(uuid)', 'EXECUTE'), 'service_role executa get_webhook_secrets');

-- Membro comum não cria
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-8000-000000000013","role":"authenticated"}', true);
select throws_ok(
  $$select * from public.create_webhook_endpoint('https://example.com/h', array['deal.won'], 'x')$$,
  '42501', null, 'membro comum não cria endpoint'
);

-- Admin A cria
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-8000-000000000011","role":"authenticated"}', true);
select set_config('teste.secret', (select c.secret from public.create_webhook_endpoint('https://example.com/h', array['deal.won', 'contact.created'], 'principal') c), true);
select set_config('teste.endpoint', (select id::text from public.webhook_endpoints limit 1), true);
select matches(current_setting('teste.secret'), '^whsec_[0-9a-f]{64}$', 'segredo tem prefixo whsec_ e 32 bytes em hex');
reset role;
select is(
  (select count(*)::int from public.webhook_endpoints e where e.id = current_setting('teste.endpoint')::uuid and e::text like '%' || current_setting('teste.secret') || '%'),
  0, 'linha do endpoint não contém o segredo'
);
reset role;
select ok((select vault_secret_id is not null from public.webhook_endpoints), 'vault_secret_id preenchido');
set local role authenticated;
set local role authenticated;
select throws_ok(
  $$select * from public.create_webhook_endpoint('https://example.com/h', array['deal.exploded'], null)$$,
  '22023', null, 'event_type fora da lista permitida é rejeitado'
);
select throws_ok(
  $$select * from public.create_webhook_endpoint('https://example.com/h', array[]::text[], null)$$,
  '22023', null, 'event_types vazio é rejeitado'
);
select throws_ok(
  $$select * from public.create_webhook_endpoint('http://example.com/h', array['deal.won'], null)$$,
  '23514', null, 'URL http:// viola o check'
);
select throws_ok(
  $$select * from public.create_webhook_endpoint('https://user:pass@example.com/h', array['deal.won'], null)$$,
  '23514', null, 'URL com user:pass@ viola o check'
);
select is((select count(*)::int from public.webhook_endpoints), 1, 'admin A lê o próprio endpoint (e só ele)');
select throws_ok(
  $$select * from public.get_webhook_secrets(current_setting('teste.endpoint')::uuid)$$,
  '42501', null, 'authenticated não lê segredos'
);

-- Envio de teste e entregas
select ok(public.send_test_webhook(current_setting('teste.endpoint')::uuid) is not null, 'send_test_webhook devolve id da entrega');
select is(
  (select count(*)::int from public.webhook_deliveries where event_type = 'webhook.test' and status = 'pending'),
  1, 'entrega de teste pendente criada'
);
select set_config('teste.delivery', (select id::text from public.webhook_deliveries limit 1), true);

-- Pausar e rotacionar
select lives_ok($$select public.set_webhook_endpoint_active(current_setting('teste.endpoint')::uuid, false)$$, 'admin pausa endpoint');
select is((select active from public.webhook_endpoints), false, 'endpoint ficou inativo');
select set_config('teste.secret2', public.rotate_webhook_endpoint_secret(current_setting('teste.endpoint')::uuid), true);
select isnt(current_setting('teste.secret2'), current_setting('teste.secret'), 'rotação gera segredo novo');
select matches(current_setting('teste.secret2'), '^whsec_[0-9a-f]{64}$', 'segredo rotacionado tem o formato');
reset role;
select ok(
  (select previous_vault_secret_id is not null
      and previous_secret_expires_at between now() + interval '23 hours' and now() + interval '25 hours'
   from public.webhook_endpoints),
  'segredo antigo guardado por 24 h'
);
set local role authenticated;

-- Isolamento entre tenants
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-8000-000000000012","role":"authenticated"}', true);
select is((select count(*)::int from public.webhook_endpoints), 0, 'admin B não lê endpoints do tenant A');
select is((select count(*)::int from public.webhook_deliveries), 0, 'admin B não lê entregas do tenant A');
select throws_ok($$select public.delete_webhook_endpoint(current_setting('teste.endpoint')::uuid)$$, 'P0002', null, 'admin B não apaga endpoint do tenant A');
select throws_ok($$select public.send_test_webhook(current_setting('teste.endpoint')::uuid)$$, 'P0002', null, 'admin B não dispara teste no endpoint do tenant A');
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-8000-000000000013","role":"authenticated"}', true);
select is((select count(*)::int from public.webhook_endpoints), 0, 'membro comum não lê endpoints');

-- Segredos (service_role)
reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  (select s."current" from public.get_webhook_secrets(current_setting('teste.endpoint')::uuid) s),
  current_setting('teste.secret2'), 'service_role lê segredo atual do vault'
);
select is(
  (select s.previous from public.get_webhook_secrets(current_setting('teste.endpoint')::uuid) s),
  current_setting('teste.secret'), 'service_role lê segredo anterior enquanto válido'
);

-- Claim sem duplicar linha entre workers
reset role;
update public.webhook_endpoints set active = true where id = current_setting('teste.endpoint')::uuid;
update public.webhook_deliveries set status = 'delivered' where id = current_setting('teste.delivery')::uuid;
insert into public.webhook_deliveries(tenant_id, endpoint_id, event_id, event_type, max_attempts)
select e.tenant_id, e.id, ev, 'deal.won', 2
from public.webhook_endpoints e, unnest(array[
  'f5000000-0000-4000-8000-0000000000e1', 'f5000000-0000-4000-8000-0000000000e2',
  'f5000000-0000-4000-8000-0000000000e3']::uuid[]) ev;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('teste.w1', (select string_agg(c.id::text, ',') from public.claim_webhook_deliveries(2, 'w1') c), true);
select set_config('teste.w2', (select string_agg(c.id::text, ',') from public.claim_webhook_deliveries(2, 'w2') c), true);
select is(array_length(string_to_array(current_setting('teste.w1'), ','), 1), 2, 'worker 1 reivindica 2 entregas');
select is(array_length(string_to_array(current_setting('teste.w2'), ','), 1), 1, 'worker 2 pega só a restante');
select is(
  (select count(*)::int from unnest(string_to_array(current_setting('teste.w1'), ',')) a
     join unnest(string_to_array(current_setting('teste.w2'), ',')) b on a = b),
  0, 'nenhuma linha vai a dois workers'
);
select is((select count(*)::int from public.claim_webhook_deliveries(10, 'w3')), 0, 'sem pendentes, nada a reivindicar');

-- complete / fail
select lives_ok(
  format($$select public.complete_webhook_delivery(%L::uuid, 'w1', 200, 'ok')$$, split_part(current_setting('teste.w1'), ',', 1)),
  'complete_webhook_delivery executa'
);
select is((select status from public.webhook_deliveries where id = split_part(current_setting('teste.w1'), ',', 1)::uuid), 'delivered', 'entrega concluída');
select lives_ok(
  format($$select public.fail_webhook_delivery(%L::uuid, 'w2', 'boom', 500, 'erro', now() - interval '1 second')$$, current_setting('teste.w2')),
  'fail_webhook_delivery agenda retry'
);
select is((select status from public.webhook_deliveries where id = current_setting('teste.w2')::uuid), 'pending', 'primeira falha volta para pending');
select is((select count(*)::int from public.claim_webhook_deliveries(10, 'w4')), 1, 'retry vencido é reivindicado de novo');
select lives_ok(
  format($$select public.fail_webhook_delivery(%L::uuid, 'w4', 'boom', 500, 'erro')$$, current_setting('teste.w2')),
  'segunda falha esgota max_attempts'
);
select is((select status from public.webhook_deliveries where id = current_setting('teste.w2')::uuid), 'dead_letter', 'esgotou tentativas e foi para dead_letter');

-- redeliver e delete (admin A)
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-8000-000000000011","role":"authenticated"}', true);
select lives_ok(format($$select public.redeliver_webhook(%L::uuid)$$, current_setting('teste.w2')), 'admin reenvia entrega em dead_letter');
select is((select status || attempts from public.webhook_deliveries where id = current_setting('teste.w2')::uuid), 'pending0', 'reenvio zera tentativas');
select lives_ok($$select public.delete_webhook_endpoint(current_setting('teste.endpoint')::uuid)$$, 'admin apaga o endpoint');
select is((select count(*)::int from public.webhook_endpoints), 0, 'endpoint apagado');

-- Limites, tenant da entrega, vault e EXECUTE (fix round 1)
reset role;
select ok(not has_function_privilege('authenticated', 'public.complete_webhook_delivery(uuid,text,int,text)', 'EXECUTE'), 'authenticated não executa complete_webhook_delivery');
select ok(not has_function_privilege('authenticated', 'public.fail_webhook_delivery(uuid,text,text,int,text,timestamptz)', 'EXECUTE'), 'authenticated não executa fail_webhook_delivery');
select is(
  (select count(*)::int from vault.secrets where name like 'webhook_endpoint:%'),
  0, 'delete do endpoint apagou os dois segredos do vault'
);
insert into public.domain_events(id, tenant_id, event_type, aggregate_type, aggregate_id, idempotency_key) values
 ('f5000000-0000-4000-8000-0000000000b1', 'f5000000-0000-4000-8000-000000000002', 'deal.won', 'deal', gen_random_uuid(), 'wh-test-b1');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-8000-000000000011","role":"authenticated"}', true);
select set_config('teste.endpoint2', (select c.id::text from public.create_webhook_endpoint('https://example.com/2', array['deal.won'], null) c), true);
reset role;
select throws_ok(
  format($$insert into public.webhook_deliveries(tenant_id, endpoint_id, event_id, event_type) values ('f5000000-0000-4000-8000-000000000002', %L::uuid, 'f5000000-0000-4000-8000-0000000000b1', 'deal.won')$$, current_setting('teste.endpoint2')),
  '23503', null, 'entrega com tenant diferente do endpoint é rejeitada'
);
select throws_ok(
  format($$insert into public.webhook_deliveries(tenant_id, endpoint_id, event_id, event_type) values ('f5000000-0000-4000-8000-000000000001', %L::uuid, 'f5000000-0000-4000-8000-0000000000b1', 'deal.won')$$, current_setting('teste.endpoint2')),
  '23514', null, 'entrega com evento de outro tenant é rejeitada'
);
set local role authenticated;
select throws_ok(
  $$select * from public.create_webhook_endpoint('https://example.com/h h', array['deal.won'], null)$$,
  '23514', null, 'URL com espaço viola o check'
);
select throws_ok(
  $$select * from public.create_webhook_endpoint('https://example.com/' || repeat('a', 2050), array['deal.won'], null)$$,
  '23514', null, 'URL acima de 2048 caracteres viola o check'
);
select throws_ok(
  $$select * from public.create_webhook_endpoint('https://example.com/h', array['deal.won'], repeat('d', 501))$$,
  '23514', null, 'descrição acima de 500 caracteres viola o check'
);
select throws_ok(
  $$select * from public.create_webhook_endpoint('https://example.com/h', null, null)$$,
  '22023', null, 'event_types nulo é rejeitado'
);
select lives_ok(
  $$select count(*) from generate_series(1, 19) g, lateral public.create_webhook_endpoint('https://example.com/n' || g, array['deal.won'], null)$$,
  'cria até 20 endpoints'
);
select throws_ok(
  $$select * from public.create_webhook_endpoint('https://example.com/21', array['deal.won'], null)$$,
  '54000', null, 'o 21º endpoint do tenant é rejeitado'
);

-- Fix round 2: p_limit, backoff com muitas tentativas, tenant no UPDATE, isolamento, EXECUTE
reset role;
insert into public.webhook_deliveries(id, tenant_id, endpoint_id, event_id, event_type, status, attempts, max_attempts, locked_by, locked_at)
values ('f5000000-0000-4000-8000-0000000000d1', 'f5000000-0000-4000-8000-000000000001', current_setting('teste.endpoint2')::uuid,
        'f5000000-0000-4000-8000-0000000000e2', 'deal.won', 'processing', 60, 100, 'w9', now());
select throws_ok(
  $$update public.webhook_deliveries set event_id = 'f5000000-0000-4000-8000-0000000000b1' where id = 'f5000000-0000-4000-8000-0000000000d1'$$,
  '23514', null, 'UPDATE de event_id para evento de outro tenant é rejeitado'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok($$select * from public.claim_webhook_deliveries(0, 'wx')$$, '22023', null, 'claim rejeita limite 0');
select throws_ok($$select * from public.claim_webhook_deliveries(501, 'wx')$$, '22023', null, 'claim rejeita limite 501');
select throws_ok($$select * from public.claim_webhook_deliveries(null, 'wx')$$, '22023', null, 'claim rejeita limite nulo');
select lives_ok(
  $$select public.fail_webhook_delivery('f5000000-0000-4000-8000-0000000000d1', 'w9', 'boom')$$,
  'fail com 60 tentativas não estoura o intervalo'
);
select is((select status from public.webhook_deliveries where id = 'f5000000-0000-4000-8000-0000000000d1'), 'pending', 'entrega com 60 de 100 tentativas volta para pending');
select ok((select available_at > now() from public.webhook_deliveries where id = 'f5000000-0000-4000-8000-0000000000d1'), 'backoff agenda para o futuro');

reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-8000-000000000012","role":"authenticated"}', true);
select throws_ok(format($$select public.rotate_webhook_endpoint_secret(%L::uuid)$$, current_setting('teste.endpoint2')), 'P0002', null, 'admin B não rotaciona segredo do tenant A');
select throws_ok(format($$select public.set_webhook_endpoint_active(%L::uuid, false)$$, current_setting('teste.endpoint2')), 'P0002', null, 'admin B não pausa endpoint do tenant A');
select throws_ok($$select public.redeliver_webhook('f5000000-0000-4000-8000-0000000000d1')$$, 'P0002', null, 'admin B não reenvia entrega do tenant A');

reset role;
select is(
  (select count(*)::int from unnest(array[
      'public.create_webhook_endpoint(text,text[],text)', 'public.rotate_webhook_endpoint_secret(uuid)',
      'public.set_webhook_endpoint_active(uuid,boolean)', 'public.delete_webhook_endpoint(uuid)',
      'public.send_test_webhook(uuid)', 'public.redeliver_webhook(uuid)', 'public.webhook_allowed_event_types()',
      'public.get_webhook_secrets(uuid)', 'public.claim_webhook_deliveries(int,text)',
      'public.complete_webhook_delivery(uuid,text,int,text)',
      'public.fail_webhook_delivery(uuid,text,text,int,text,timestamptz)',
      'public.webhook_deliveries_check_event_tenant()']::regprocedure[]) f
    where has_function_privilege('anon', f, 'EXECUTE')),
  0, 'anon não executa nenhuma função de webhook'
);

-- Segredo anterior expirado não é devolvido
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-8000-000000000011","role":"authenticated"}', true);
select public.rotate_webhook_endpoint_secret(current_setting('teste.endpoint2')::uuid);
reset role;
update public.webhook_endpoints set previous_secret_expires_at = now() - interval '1 hour' where id = current_setting('teste.endpoint2')::uuid;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select ok(
  (select s."current" is not null and s.previous is null from public.get_webhook_secrets(current_setting('teste.endpoint2')::uuid) s),
  'segredo anterior expirado vem nulo e o atual continua'
);

-- Fix round 3: SELECT por coluna
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-8000-000000000011","role":"authenticated"}', true);
select lives_ok($$select id, tenant_id, url, description, event_types, active, disabled_reason, created_by, created_at, updated_at, previous_secret_expires_at from public.webhook_endpoints$$, 'admin lê as colunas seguras de endpoints');
select throws_ok($$select vault_secret_id from public.webhook_endpoints$$, '42501', null, 'vault_secret_id negado');
select throws_ok($$select previous_vault_secret_id from public.webhook_endpoints$$, '42501', null, 'previous_vault_secret_id negado');
select throws_ok($$select * from public.webhook_endpoints$$, '42501', null, 'select estrela em endpoints negado');
select lives_ok($$select id, endpoint_id, event_id, event_type, status, attempts, max_attempts, available_at, response_status, response_excerpt, last_error, delivered_at, created_at from public.webhook_deliveries$$, 'admin lê as colunas de interface de entregas');
select throws_ok($$select locked_by from public.webhook_deliveries$$, '42501', null, 'locked_by negado');
reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok($$select * from public.webhook_endpoints$$, 'service_role lê tudo em endpoints');
select lives_ok($$select * from public.webhook_deliveries$$, 'service_role lê tudo em entregas');

select * from finish();
rollback;
