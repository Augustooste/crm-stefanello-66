begin;
create extension if not exists pgtap;
select plan(41);

select has_table('public', 'domain_events', 'domain_events existe');
select has_table('public', 'domain_event_subscriptions', 'subscriptions existe');
select has_table('public', 'event_deliveries', 'event_deliveries existe');
select ok((select relrowsecurity from pg_class where oid = 'public.domain_events'::regclass), 'RLS em domain_events');
select ok((select relrowsecurity from pg_class where oid = 'public.event_deliveries'::regclass), 'RLS em deliveries');
select has_index('public', 'domain_events', 'domain_events_tenant_occurred_idx', 'índice tenant/evento existe');
select has_index('public', 'event_deliveries', 'event_deliveries_claimable_idx', 'índice parcial de claim existe');
select col_is_pk('public', 'domain_events', 'id', 'evento tem PK');
select col_is_pk('public', 'event_deliveries', 'id', 'delivery tem PK');
select col_is_unique('public', 'domain_events', 'idempotency_key', 'idempotency key é única');
select col_is_unique('public', 'event_deliveries', array['event_id', 'subscriber_id'], 'uma entrega por evento/consumer');

select has_function('public', 'claim_event_deliveries', array['text','integer','integer','text[]','text[]'], 'claim RPC existe');
select has_function('public', 'ack_event_delivery', array['uuid','text'], 'ack RPC existe');
select has_function('public', 'fail_event_delivery', array['uuid','text','text','integer'], 'fail RPC existe');
select ok((select prosecdef from pg_proc where oid = 'public.claim_event_deliveries(text,integer,integer,text[],text[])'::regprocedure), 'claim é SECURITY DEFINER');
select ok((select pg_get_functiondef('public.claim_event_deliveries(text,integer,integer,text[],text[])'::regprocedure) ilike '%skip locked%'), 'claim usa SKIP LOCKED');
select ok((select pg_get_functiondef('public.claim_event_deliveries(text,integer,integer,text[],text[])'::regprocedure) ilike '%locked_at%'), 'claim usa lease');
select ok(not has_function_privilege('authenticated', 'public.claim_event_deliveries(text,integer,integer,text[],text[])', 'EXECUTE'), 'authenticated não executa claim');
select ok(not has_function_privilege('anon', 'public.claim_event_deliveries(text,integer,integer,text[],text[])', 'EXECUTE'), 'anon não executa claim');
select ok(has_function_privilege('service_role', 'public.claim_event_deliveries(text,integer,integer,text[],text[])', 'EXECUTE'), 'service_role executa claim');
select is((select count(*)::int from pg_policies where tablename = 'domain_events' and cmd = 'SELECT' and 'authenticated'=any(roles)), 1, 'evento tem policy tenant SELECT');
select is((select count(*)::int from pg_policies where tablename = 'event_deliveries' and cmd = 'SELECT' and 'authenticated'=any(roles)), 1, 'delivery tem policy tenant SELECT');
select is((select count(*)::int from pg_policies where tablename in ('domain_events','event_deliveries') and cmd in ('INSERT','UPDATE','DELETE') and 'authenticated'=any(roles)), 0, 'authenticated não escreve outbox');
-- renomeado/ampliado em domain_events_runtime.sql (20260719161000): cobre
-- 'in' (message.received) e 'out' (message.sent), não só inbound.
select has_trigger('public', 'messages', 'messages_publish_domain_event', 'publisher transacional instalado');
select has_trigger('public', 'domain_events', 'domain_events_create_deliveries', 'fan-out transacional instalado');

insert into auth.users (id, email) values
  ('71111111-1111-1111-1111-111111111111', 'outbox-a@test.local'),
  ('72222222-2222-2222-2222-222222222222', 'outbox-b@test.local');

insert into public.domain_event_subscriptions(subscriber_id, event_types, max_attempts)
values ('test.message-projector', array['message.received'], 2);

insert into public.contacts(id, tenant_id, name)
select '73333333-3333-3333-3333-333333333331', tenant_id, 'Contato A'
from public.profiles where id = '71111111-1111-1111-1111-111111111111';
insert into public.channels(id, tenant_id, type, provider_slug)
select '74444444-4444-4444-4444-444444444441', tenant_id, 'whatsapp', 'test-provider'
from public.profiles where id = '71111111-1111-1111-1111-111111111111';
insert into public.conversations(id, tenant_id, contact_id, channel_id)
select '75555555-5555-5555-5555-555555555551', p.tenant_id,
       '73333333-3333-3333-3333-333333333331', '74444444-4444-4444-4444-444444444441'
from public.profiles p where p.id = '71111111-1111-1111-1111-111111111111';

insert into public.messages(id, tenant_id, conversation_id, direction, sender, content, external_id)
select '76666666-6666-6666-6666-666666666661', p.tenant_id,
       '75555555-5555-5555-5555-555555555551', 'in', 'contact', 'oi', 'provider-evt-1'
from public.profiles p where p.id = '71111111-1111-1111-1111-111111111111';

select is((select count(*)::int from public.domain_events where aggregate_id='76666666-6666-6666-6666-666666666661'), 1, 'mensagem inbound publica exatamente um evento');
select is((select event_type from public.domain_events where aggregate_id='76666666-6666-6666-6666-666666666661'), 'message.received', 'tipo inicial correto');
select is((select schema_version from public.domain_events where aggregate_id='76666666-6666-6666-6666-666666666661'), 1, 'schema version inicial é 1');
-- Escopado por subscriber (não a tabela toda): domain_events_runtime.sql
-- (migration posterior) registra 2 subscriptions "sempre ligadas"
-- (kernel.projection, kernel.observability com wildcard '*') e publishers
-- adicionais (ex.: contacts_publish_created_event no insert de contact acima)
-- -- ambos legítimos e testados em domain_events_runtime.sql, mas produzem
-- deliveries extras nesta mesma fixture que não são o alvo deste teste.
select is((select count(*)::int from public.event_deliveries where subscriber_id = 'test.message-projector'), 1, 'fan-out cria uma entrega');

-- Positivo sob RLS: tenant A enxerga o próprio evento/entrega (as asserções
-- acima rodam como superuser no seed; sem esta metade o par positivo/negativo
-- não prova que a policy SELECT libera o dono, só que bloqueia o estranho).
set local role authenticated;
set local request.jwt.claims = '{"sub":"71111111-1111-1111-1111-111111111111","role":"authenticated"}';
select is((select count(*)::int from public.domain_events where aggregate_id='76666666-6666-6666-6666-666666666661'), 1, 'tenant A lê o próprio evento sob RLS');
select is((select count(*)::int from public.event_deliveries where subscriber_id = 'test.message-projector'), 1, 'tenant A lê a própria entrega sob RLS');
reset role;

-- RLS isolation: tenant B cannot observe tenant A's facts or delivery state.
set local role authenticated;
set local request.jwt.claims = '{"sub":"72222222-2222-2222-2222-222222222222","role":"authenticated"}';
select is((select count(*)::int from public.domain_events), 0, 'tenant B não lê eventos do tenant A');
select is((select count(*)::int from public.event_deliveries), 0, 'tenant B não lê deliveries do tenant A');
reset role;

-- Atomic claim and consumer idempotency: a second worker cannot reclaim an
-- active lease. The SKIP LOCKED implementation is asserted above; these calls
-- validate the externally visible no-double-claim contract. p_subscriber_ids
-- escopa pro subscriber deste teste -- sem isso, kernel.projection/
-- kernel.observability (subscriptions sempre-ligadas de
-- domain_events_runtime.sql) competem pelas mesmas deliveries e quebram a
-- contagem determinística que este bloco depende.
create temp table claimed_one as select * from public.claim_event_deliveries('worker-a', 1, 60, null, array['test.message-projector']);
create temp table claimed_two as select * from public.claim_event_deliveries('worker-b', 1, 60, null, array['test.message-projector']);
select is((select count(*)::int from claimed_one), 1, 'primeiro worker reivindica a entrega');
select is((select count(*)::int from claimed_two), 0, 'segundo worker não duplica claim com lease ativa');
select is((select attempts from claimed_one), 1, 'claim incrementa attempts');
select ok(not public.ack_event_delivery((select delivery_id from claimed_one), 'worker-b'), 'worker sem lease não confirma entrega');

select is(public.fail_event_delivery((select delivery_id from claimed_one), 'worker-a', 'temporário', 0), 'pending', 'primeira falha agenda retry');
create temp table claimed_retry as select * from public.claim_event_deliveries('worker-b', 1, 60, null, array['test.message-projector']);
select is((select attempts from claimed_retry), 2, 'retry incrementa segunda tentativa');
select is(public.fail_event_delivery((select delivery_id from claimed_retry), 'worker-b', 'fatal', 0), 'dead_letter', 'última falha vai para dead-letter');
select is((select count(*)::int from public.claim_event_deliveries('worker-c', 1, 60, null, array['test.message-projector'])), 0, 'dead-letter nunca volta ao claim');

select * from finish();
rollback;
