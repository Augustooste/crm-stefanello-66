-- Ligações IA (20260925230500): RBAC, isolamento de tenant, idempotência,
-- máquina de estados (duplicado, fora de ordem, final vence) e resultado sem
-- mexer em funil.
begin;
create extension if not exists pgtap;

select plan(35);

insert into auth.users (id, email) values
  ('a0000001-0000-4000-8000-000000000001', 'voz-admin-a@test.local'),
  ('a0000002-0000-4000-8000-000000000002', 'voz-admin-b@test.local');
insert into public.invites (tenant_id, email, role, token, expires_at)
select tenant_id, 'voz-agent-a@test.local', 'agent', 'voz-agent-token', now() + interval '1 day'
from public.profiles where id = 'a0000001-0000-4000-8000-000000000001';
insert into auth.users (id, email, raw_user_meta_data) values
  ('a0000003-0000-4000-8000-000000000003', 'voz-agent-a@test.local', '{"invite_token":"voz-agent-token"}');

create temp table fx on commit drop as
select
  (select tenant_id from public.profiles where id = 'a0000001-0000-4000-8000-000000000001') as tenant_a,
  (select tenant_id from public.profiles where id = 'a0000002-0000-4000-8000-000000000002') as tenant_b;
grant select on fx to authenticated;

insert into public.contacts (id, tenant_id, name, phone, email)
select 'c0000001-0000-4000-8000-000000000001', tenant_a, 'Ana Souza', '+55 (11) 98888-7777', 'ana@x.com' from fx;
insert into public.contacts (id, tenant_id, name, phone)
select 'c0000002-0000-4000-8000-000000000002', tenant_a, 'Sem Fone', null from fx;
insert into public.contacts (id, tenant_id, name, phone)
select 'c0000003-0000-4000-8000-000000000003', tenant_a, 'Opt Out', '5511977776666' from fx;
insert into public.contacts (id, tenant_id, name, phone)
select 'c0000004-0000-4000-8000-000000000004', tenant_b, 'Bruno B', '5511966665555' from fx;
insert into public.contacts (id, tenant_id, name, phone)
select 'c0000005-0000-4000-8000-000000000005', tenant_a, 'Carla', '5511955554444' from fx;

insert into public.messaging_phone_suppressions (tenant_id, phone, scope, reason)
select tenant_a, '5511977776666', 'phone', 'opt-out' from fx;

insert into public.boards (id, tenant_id, name, is_default)
select 'b0000001-0000-4000-8000-000000000001', tenant_a, 'Funil voz', false from fx;
insert into public.board_stages (id, board_id, name, position) values
  ('e0000001-0000-4000-8000-000000000001', 'b0000001-0000-4000-8000-000000000001', 'Qualificação', 0);
insert into public.deals (id, tenant_id, board_id, stage_id, contact_id, title, status)
select 'd0000001-0000-4000-8000-000000000001', tenant_a, 'b0000001-0000-4000-8000-000000000001',
       'e0000001-0000-4000-8000-000000000001', 'c0000001-0000-4000-8000-000000000001', 'Plano anual', 'open'
from fx;

-- Estrutura e privilégios ----------------------------------------------------
select has_table('public', 'voice_calls', 'voice_calls existe');
select has_table('public', 'voice_call_events', 'voice_call_events existe');
select ok(not has_function_privilege('authenticated', 'public.apply_voice_call_event(jsonb)', 'EXECUTE'),
  'authenticated não aplica evento de ligação');
select ok(not has_function_privilege('anon', 'public.request_voice_call(uuid, uuid, text, text, text)', 'EXECUTE'),
  'anon não pede ligação');
select ok(not has_table_privilege('authenticated', 'public.voice_call_events', 'INSERT'),
  'authenticated não escreve no ledger de eventos');
select ok(not has_table_privilege('authenticated', 'public.voice_calls', 'INSERT'),
  'authenticated não insere ligação direto');

-- Agente do tenant A pede ligação ---------------------------------------------
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0000003-0000-4000-8000-000000000003', 'role', 'authenticated')::text, true);
set local role authenticated;

create temp table r1 on commit drop as
select public.request_voice_call('c0000001-0000-4000-8000-000000000001',
  'd0000001-0000-4000-8000-000000000001', 'Reativar plano anual', null, 'chave-idem-0001') as r;

select is((select r -> 'call' ->> 'status' from r1), 'queued', 'agente cria ligação queued');
select is((select r -> 'call' ->> 'phone' from r1), '+5511988887777', 'telefone normalizado em E.164');
select is(
  (select jsonb_object_keys_agg from (
     select string_agg(k, ',' order by k) as jsonb_object_keys_agg
       from jsonb_object_keys((select r -> 'context' from r1)) k) s),
  'contact,deal,objective,recent_messages',
  'contexto só com as chaves da whitelist');
select is((select r -> 'context' -> 'contact' from r1), '{"first_name":"Ana"}'::jsonb,
  'contato vai só com o primeiro nome (sem e-mail/telefone)');
select is((select r -> 'context' -> 'deal' from r1), '{"title":"Plano anual","stage":"Qualificação"}'::jsonb,
  'negócio vai com título e estágio');

select is(
  (select public.request_voice_call('c0000001-0000-4000-8000-000000000001', null, 'outro', null, 'chave-idem-0001')
     -> 'call' ->> 'id'),
  (select r -> 'call' ->> 'id' from r1),
  'mesma idempotency_key devolve a mesma ligação');
select throws_ok(
  $$select public.request_voice_call('c0000001-0000-4000-8000-000000000001', null, 'de novo', null, 'chave-idem-0002')$$,
  '23505', null, 'uma ligação ativa por contato');
select throws_ok(
  $$select public.request_voice_call('c0000002-0000-4000-8000-000000000002', null, 'teste', null, 'chave-idem-0003')$$,
  '22023', null, 'contato sem telefone é recusado');
select throws_ok(
  $$select public.request_voice_call('c0000003-0000-4000-8000-000000000003', null, 'teste', null, 'chave-idem-0004')$$,
  '42501', null, 'contato com opt-out é recusado');
select throws_ok(
  $$select public.request_voice_call('c0000004-0000-4000-8000-000000000004', null, 'teste', null, 'chave-idem-0005')$$,
  'P0002', null, 'contato de outro tenant não existe para quem pede');
select throws_ok(
  $$select public.request_voice_call('c0000005-0000-4000-8000-000000000005',
      'd0000001-0000-4000-8000-000000000001', 'teste', null, 'chave-idem-0006')$$,
  'P0002', null, 'negócio de outro contato é recusado');

-- Cancelamento antes de discar: resolve local.
create temp table r2 on commit drop as
select public.request_voice_call('c0000005-0000-4000-8000-000000000005', null, 'Confirmar agenda', null, 'chave-idem-0007') as r;
select is(
  (select public.request_voice_call_cancel((select (r -> 'call' ->> 'id')::uuid from r2)) ->> 'action'),
  'cancelled_locally', 'ligação ainda não entregue cancela no CRM');
reset role;

-- Isolamento: admin B não vê a ligação do tenant A.
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0000002-0000-4000-8000-000000000002', 'role', 'authenticated')::text, true);
set local role authenticated;
select is((select count(*)::int from public.voice_calls), 0, 'admin B não vê ligações do tenant A');
select is((select count(*)::int from public.voice_call_events), 0, 'admin B não vê eventos do tenant A');
reset role;

-- Eventos (service_role) ------------------------------------------------------
create temp table ev on commit drop as
select (r -> 'call' ->> 'id')::uuid as call_id, (select tenant_a from fx) as tenant_id from r1;

create or replace function pg_temp.evt(p_id text, p_type text, p_data jsonb default '{}', p_seq int default null)
returns jsonb language sql as $$
  select public.apply_voice_call_event(jsonb_build_object(
    'event_id', p_id, 'type', p_type, 'sequence', p_seq,
    'call_id', (select call_id from ev), 'tenant_id', (select tenant_id from ev),
    'provider_call_id', 'prov-1', 'occurred_at', now(), 'data', p_data));
$$;

select is(pg_temp.evt('e1', 'call.created') ->> 'result', 'applied', 'created aplica');
select is(pg_temp.evt('e1', 'call.created') ->> 'result', 'duplicate', 'mesmo event_id é duplicado');
select is(
  public.apply_voice_call_event(jsonb_build_object('event_id', 'e-x', 'type', 'call.ringing',
    'call_id', (select call_id from ev), 'tenant_id', (select tenant_id from ev),
    'provider_call_id', 'outro-provider-id')) ->> 'result',
  'mismatch', 'provider_call_id diferente é recusado');
select is(
  public.apply_voice_call_event(jsonb_build_object('event_id', 'e-y', 'type', 'call.ringing',
    'call_id', (select call_id from ev), 'tenant_id', (select tenant_b from fx),
    'provider_call_id', 'prov-1')) ->> 'result',
  'not_found', 'tenant errado não encontra a ligação');
select is(pg_temp.evt('e2', 'call.answered') ->> 'status', 'answered', 'answered aplica');
select is(pg_temp.evt('e3', 'call.ringing') ->> 'result', 'ignored', 'ringing depois de answered é ignorado (fora de ordem)');
select is(pg_temp.evt('e4', 'call.completed', '{"duration_seconds": 227, "outcome": "callback_requested"}') ->> 'status',
  'completed', 'completed aplica');
select is(pg_temp.evt('e5', 'call.failed', '{"reason": "failed"}') ->> 'result', 'ignored', 'final não é sobrescrito');
select is(pg_temp.evt('e6', 'call.transcript.updated', '{"transcript": "v2"}', 2) ->> 'result', 'applied', 'transcript seq 2 aplica');
select is(pg_temp.evt('e7', 'call.transcript.updated', '{"transcript": "v1"}', 1) ->> 'result', 'ignored', 'transcript mais antigo não sobrescreve');

select is(
  (select stage_id from public.deals where id = 'd0000001-0000-4000-8000-000000000001'),
  'e0000001-0000-4000-8000-000000000001'::uuid, 'resultado da ligação não move o negócio de estágio');
select is(
  (select count(*)::int from public.activities
    where metadata ->> 'voice_call_id' = (select call_id::text from ev) and type = 'task'),
  1, 'pedido de retorno vira tarefa para humano');

-- Ligação ativa sem sinal há mais de 2h não bloqueia o contato para sempre.
insert into public.voice_calls (tenant_id, contact_id, phone, objective, idempotency_key, status, started_at, created_at)
select tenant_a, 'c0000005-0000-4000-8000-000000000005', '+5511955554444', 'antiga', 'chave-velha-0001',
       'initiating', now() - interval '3 hours', now() - interval '3 hours'
from fx;
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0000003-0000-4000-8000-000000000003', 'role', 'authenticated')::text, true);
set local role authenticated;
select is(
  (select public.request_voice_call('c0000005-0000-4000-8000-000000000005', null, 'Nova tentativa', null, 'chave-idem-0010')
     -> 'call' ->> 'status'),
  'queued', 'ligação presa há 3h não bloqueia nova ligação');
reset role;
select is(
  (select count(*)::int from public.voice_calls
    where contact_id = 'c0000005-0000-4000-8000-000000000005' and error_code = 'stale_timeout'),
  1, 'ligação presa foi expirada como falha');

-- RBAC: membro sem vínculo ativo (sem crm.contacts.write) não liga.
update public.tenant_memberships set status = 'revoked', revoked_at = now()
 where user_id = 'a0000003-0000-4000-8000-000000000003';
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0000003-0000-4000-8000-000000000003', 'role', 'authenticated')::text, true);
set local role authenticated;
select throws_ok(
  $$select public.request_voice_call('c0000005-0000-4000-8000-000000000005', null, 'teste', null, 'chave-idem-0099')$$,
  '42501', null, 'sem permissão crm.contacts.write não pede ligação');
reset role;

select * from finish();
rollback;
