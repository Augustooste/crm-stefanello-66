-- Fix wave da integração (webhooks e API pública):
-- I1: funções só de service_role recusam outro papel MESMO com EXECUTE concedido
--     (remix não herda REVOKE; a guarda tem que estar no corpo).
-- I3: claim faz round robin por tenant; send_test_webhook tem teto de 10 por minuto.
-- Roda no shadow DB local: pnpm test:db.
begin;
create extension if not exists pgtap;
select plan(19);

set session_replication_role = replica;
insert into public.tenants(id, name) values
 ('f6000000-0000-4000-8000-000000000001', 'Fila C'),
 ('f6000000-0000-4000-8000-000000000002', 'Fila D');
insert into auth.users(id, email) values
 ('f6000000-0000-4000-8000-000000000011', 'fila-admin-c@test.invalid'),
 ('f6000000-0000-4000-8000-000000000012', 'fila-admin-d@test.invalid');
insert into public.profiles(id, tenant_id, name, role) values
 ('f6000000-0000-4000-8000-000000000011', 'f6000000-0000-4000-8000-000000000001', 'Admin C', 'admin'),
 ('f6000000-0000-4000-8000-000000000012', 'f6000000-0000-4000-8000-000000000002', 'Admin D', 'admin');
insert into public.roles(tenant_id, role_key, name, is_system) values
 ('f6000000-0000-4000-8000-000000000001', 'admin', 'Admin', true),
 ('f6000000-0000-4000-8000-000000000002', 'admin', 'Admin', true);
insert into public.role_permissions(role_id, permission_id)
 select r.id, p.id from public.roles r cross join public.permissions p
 where r.tenant_id in ('f6000000-0000-4000-8000-000000000001', 'f6000000-0000-4000-8000-000000000002');
insert into public.tenant_memberships(tenant_id, user_id, role_id, status)
 select p.tenant_id, p.id, r.id, 'active' from public.profiles p join public.roles r
 on r.tenant_id = p.tenant_id and r.role_key = p.role
 where p.id in ('f6000000-0000-4000-8000-000000000011', 'f6000000-0000-4000-8000-000000000012');
-- 30 eventos do tenant C (fila grande e mais antiga) e 1 do tenant D.
insert into public.domain_events(tenant_id, event_type, aggregate_type, aggregate_id, idempotency_key)
 select 'f6000000-0000-4000-8000-000000000001', 'deal.won', 'deal', gen_random_uuid(), 'fila-c-' || g
 from generate_series(1, 30) g;
insert into public.domain_events(tenant_id, event_type, aggregate_type, aggregate_id, idempotency_key) values
 ('f6000000-0000-4000-8000-000000000002', 'deal.won', 'deal', gen_random_uuid(), 'fila-d-1');
set session_replication_role = default;

-- Um endpoint por tenant, criado pelo próprio admin.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f6000000-0000-4000-8000-000000000011","role":"authenticated"}', true);
select count(*) from public.create_webhook_endpoint('https://example.com/c', array['deal.won'], 'C');
select set_config('request.jwt.claims', '{"sub":"f6000000-0000-4000-8000-000000000012","role":"authenticated"}', true);
select count(*) from public.create_webhook_endpoint('https://example.com/d', array['deal.won'], 'D');
reset role;
select set_config('teste.ep_c', (select id::text from public.webhook_endpoints where tenant_id = 'f6000000-0000-4000-8000-000000000001'), true);
select set_config('teste.ep_d', (select id::text from public.webhook_endpoints where tenant_id = 'f6000000-0000-4000-8000-000000000002'), true);

-- C chegou primeiro: 30 entregas de 10 minutos atrás. D: 1 entrega de 1 minuto atrás.
insert into public.webhook_deliveries(tenant_id, endpoint_id, event_id, event_type, available_at)
 select ev.tenant_id, current_setting('teste.ep_c')::uuid, ev.id, 'deal.won',
        now() - interval '10 minutes' + (row_number() over (order by ev.idempotency_key)) * interval '1 second'
 from public.domain_events ev where ev.idempotency_key like 'fila-c-%';
insert into public.webhook_deliveries(tenant_id, endpoint_id, event_id, event_type, available_at)
 select ev.tenant_id, current_setting('teste.ep_d')::uuid, ev.id, 'deal.won', now() - interval '1 minute'
 from public.domain_events ev where ev.idempotency_key = 'fila-d-1';

-- ---------------------------------------------------------------------------
-- I1: EXECUTE concedido de propósito (simula remix sem REVOKE); a guarda recusa.
-- ---------------------------------------------------------------------------
grant execute on function
  public.get_webhook_secrets(uuid),
  public.claim_webhook_deliveries(int, text),
  public.complete_webhook_delivery(uuid, text, int, text),
  public.fail_webhook_delivery(uuid, text, text, int, text, timestamptz),
  public.authenticate_api_key(text)
to anon, authenticated;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f6000000-0000-4000-8000-000000000011","role":"authenticated"}', true);
select throws_ok(format($$select * from public.get_webhook_secrets(%L::uuid)$$, current_setting('teste.ep_c')),
  '42501', null, 'authenticated com EXECUTE não lê segredo');
select throws_ok($$select * from public.claim_webhook_deliveries(10, 'intruso')$$,
  '42501', null, 'authenticated com EXECUTE não reivindica entregas');
select throws_ok($$select public.complete_webhook_delivery(gen_random_uuid(), 'intruso', 200, 'ok')$$,
  '42501', null, 'authenticated com EXECUTE não marca entrega como entregue');
select throws_ok($$select public.fail_webhook_delivery(gen_random_uuid(), 'intruso', 'x', 500, 'x', now())$$,
  '42501', null, 'authenticated com EXECUTE não marca entrega como falha');
select throws_ok($$select * from public.authenticate_api_key(repeat('0', 64))$$,
  '42501', null, 'authenticated com EXECUTE não autentica chave de API');
reset role;

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok(format($$select * from public.get_webhook_secrets(%L::uuid)$$, current_setting('teste.ep_c')),
  '42501', null, 'anon com EXECUTE não lê segredo');
select throws_ok($$select * from public.claim_webhook_deliveries(10, 'intruso')$$,
  '42501', null, 'anon com EXECUTE não reivindica entregas');
select throws_ok($$select public.complete_webhook_delivery(gen_random_uuid(), 'intruso', 200, 'ok')$$,
  '42501', null, 'anon com EXECUTE não marca entrega como entregue');
select throws_ok($$select public.fail_webhook_delivery(gen_random_uuid(), 'intruso', 'x', 500, 'x', now())$$,
  '42501', null, 'anon com EXECUTE não marca entrega como falha');
select throws_ok($$select * from public.authenticate_api_key(repeat('0', 64))$$,
  '42501', null, 'anon com EXECUTE não autentica chave de API');
reset role;

-- service_role continua funcionando.
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select ok((select s."current" is not null from public.get_webhook_secrets(current_setting('teste.ep_c')::uuid) s),
  'service_role lê segredo');
select is((select count(*)::int from public.authenticate_api_key(repeat('0', 64))), 0,
  'service_role autentica (hash desconhecido, 0 linhas)');

-- ---------------------------------------------------------------------------
-- I3: round robin por tenant no claim.
-- ---------------------------------------------------------------------------
select set_config('teste.lote', (select string_agg(c.id::text, ',') from public.claim_webhook_deliveries(10, 'wf') c), true);
select is(array_length(string_to_array(current_setting('teste.lote'), ','), 1), 10, 'claim de 10 devolve 10');
select is(
  (select count(*)::int from public.webhook_deliveries d
    where d.id = any(string_to_array(current_setting('teste.lote'), ',')::uuid[])
      and d.tenant_id = 'f6000000-0000-4000-8000-000000000002'),
  1, 'entrega do tenant D entra no lote apesar da fila maior e mais antiga de C'
);
select lives_ok(
  format($$select public.complete_webhook_delivery(%L::uuid, 'wf', 200, 'ok')$$, split_part(current_setting('teste.lote'), ',', 1)),
  'service_role completa entrega reivindicada'
);
select lives_ok(
  format($$select public.fail_webhook_delivery(%L::uuid, 'wf', 'boom', 500, 'erro')$$, split_part(current_setting('teste.lote'), ',', 2)),
  'service_role registra falha de entrega reivindicada'
);
reset role;

-- ---------------------------------------------------------------------------
-- I3: send_test_webhook com teto de 10 por minuto por tenant.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f6000000-0000-4000-8000-000000000011","role":"authenticated"}', true);
select is(
  -- Função volátil na lista do select: uma chamada por linha.
  (select count(public.send_test_webhook(current_setting('teste.ep_c')::uuid))::int from generate_series(1, 10)),
  10, '10 testes no mesmo minuto passam'
);
select throws_ok(format($$select public.send_test_webhook(%L::uuid)$$, current_setting('teste.ep_c')),
  '54000', null, '11o teste no mesmo minuto é recusado (54000)');
select set_config('request.jwt.claims', '{"sub":"f6000000-0000-4000-8000-000000000012","role":"authenticated"}', true);
select lives_ok(format($$select public.send_test_webhook(%L::uuid)$$, current_setting('teste.ep_d')),
  'limite é por tenant: tenant D segue enviando');
reset role;

select * from finish();
rollback;
