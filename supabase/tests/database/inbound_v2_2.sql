-- v2.2 E1 (20261023100000_inbound_v2_2.sql): reprocesso de ignored por condição falsa,
-- contador de ignorados (ignored_count/last_ignored_*, record_inbound_ignored),
-- set_inbound_rule_limits, inbound_rule_stats_tenant e action_config.match_fallback_path.
-- Rodar: pnpm test:db.
begin;
create extension if not exists pgtap;
select plan(77);

-- Fixture: admin A e admin B (tenants próprios via handle_new_user) e agente C (convite no tenant A).
insert into auth.users (id, email) values
  ('e5200000-0000-4000-8000-00000000000a', 'v22-adm-a@test.local'),
  ('e5200000-0000-4000-8000-00000000000b', 'v22-adm-b@test.local');
insert into public.invites (tenant_id, email, role, token, expires_at)
select tenant_id, 'v22-agente-c@test.local', 'agent', 'v22-agent-token', now() + interval '1 day'
  from public.profiles where id = 'e5200000-0000-4000-8000-00000000000a';
insert into auth.users (id, email, raw_user_meta_data) values
  ('e5200000-0000-4000-8000-00000000000c', 'v22-agente-c@test.local', '{"invite_token":"v22-agent-token"}');
create temp table fx(k text primary key, v uuid);
insert into fx select 'ta', tenant_id from public.profiles where id = 'e5200000-0000-4000-8000-00000000000a';
insert into fx select 'tb', tenant_id from public.profiles where id = 'e5200000-0000-4000-8000-00000000000b';
grant select on fx to public;

insert into public.boards (id, tenant_id, name) values
  ('e5200000-0000-4000-8000-0000000000a1', (select v from fx where k = 'ta'), 'Funil V22'),
  ('e5200000-0000-4000-8000-0000000000b1', (select v from fx where k = 'tb'), 'Funil V22 B');
insert into public.board_stages (id, board_id, name, position, is_won, is_lost) values
  ('e5200000-0000-4000-8000-000000000a11', 'e5200000-0000-4000-8000-0000000000a1', 'Novo', 0, false, false),
  ('e5200000-0000-4000-8000-000000000a12', 'e5200000-0000-4000-8000-0000000000a1', 'Proposta', 1, false, false),
  ('e5200000-0000-4000-8000-000000000b11', 'e5200000-0000-4000-8000-0000000000b1', 'Etapa B', 0, false, false);
insert into public.contacts (id, tenant_id, name, email, phone) values
  ('e5200000-0000-4000-8000-0000000000c1', (select v from fx where k = 'ta'), 'Ana', 'ana@x.com', null),
  ('e5200000-0000-4000-8000-0000000000c2', (select v from fx where k = 'ta'), 'Bia', 'bia@x.com', '+5511988887777'),
  ('e5200000-0000-4000-8000-0000000000c3', (select v from fx where k = 'ta'), 'Cia', 'cia@x.com', null);
insert into public.deals (id, tenant_id, board_id, stage_id, contact_id, title, status) values
  ('e5200000-0000-4000-8000-0000000000d1', (select v from fx where k = 'ta'), 'e5200000-0000-4000-8000-0000000000a1',
   'e5200000-0000-4000-8000-000000000a11', 'e5200000-0000-4000-8000-0000000000c1', 'Ana', 'open'),
  ('e5200000-0000-4000-8000-0000000000d2', (select v from fx where k = 'ta'), 'e5200000-0000-4000-8000-0000000000a1',
   'e5200000-0000-4000-8000-000000000a11', 'e5200000-0000-4000-8000-0000000000c2', 'Bia', 'open'),
  ('e5200000-0000-4000-8000-0000000000d3', (select v from fx where k = 'ta'), 'e5200000-0000-4000-8000-0000000000a1',
   'e5200000-0000-4000-8000-000000000a12', 'e5200000-0000-4000-8000-0000000000c3', 'Cia', 'open');

-- Regras gravadas direto (o validador é testado à parte, abaixo).
--   1 Asaas (payment.id, in)   2 email com fallback   3 phone com fallback
--   4 move_stage (already_in_stage)   b1 tenant B
insert into public.inbound_rules (id, tenant_id, name, verification_mode, board_id, allowed_stage_ids,
  action, action_config, match_field, match_path, event_id_path, conditions) values
  ('e5200000-0000-4000-8000-0000000e0001', (select v from fx where k = 'ta'), 'Asaas', 'aceleraflow_hmac',
   'e5200000-0000-4000-8000-0000000000a1', array['e5200000-0000-4000-8000-000000000a12']::uuid[],
   'add_note', '{"text":"pago {{event}}"}', 'email', 'payment.email', 'payment.id',
   '[{"path":"event","in":["PAYMENT_CONFIRMED","PAYMENT_RECEIVED"]}]'),
  ('e5200000-0000-4000-8000-0000000e0002', (select v from fx where k = 'ta'), 'Fallback email', 'aceleraflow_hmac',
   'e5200000-0000-4000-8000-0000000000a1', array['e5200000-0000-4000-8000-000000000a12']::uuid[],
   'add_note', '{"text":"stripe","match_fallback_path":"customer_email"}', 'email', 'customer_details.email', 'id', '[]'),
  ('e5200000-0000-4000-8000-0000000e0003', (select v from fx where k = 'ta'), 'Fallback phone', 'aceleraflow_hmac',
   'e5200000-0000-4000-8000-0000000000a1', array['e5200000-0000-4000-8000-000000000a12']::uuid[],
   'add_note', '{"text":"fone","match_prefix":"55","match_fallback_path":"buyer.cell"}', 'phone', 'buyer.phone', 'id', '[]'),
  ('e5200000-0000-4000-8000-0000000e0004', (select v from fx where k = 'ta'), 'Mover', 'aceleraflow_hmac',
   'e5200000-0000-4000-8000-0000000000a1', array['e5200000-0000-4000-8000-000000000a12']::uuid[],
   'move_stage', '{"to_stage_id":"e5200000-0000-4000-8000-000000000a12"}', 'email', 'email', 'id', '[]'),
  ('e5200000-0000-4000-8000-0000000e00b1', (select v from fx where k = 'tb'), 'Regra B', 'aceleraflow_hmac',
   'e5200000-0000-4000-8000-0000000000b1', array['e5200000-0000-4000-8000-000000000b11']::uuid[],
   'add_note', '{"text":"b"}', 'email', 'email', 'id', '[]');

create function pg_temp.rid(p text) returns uuid
language sql as $$ select ('e5200000-0000-4000-8000-0000000e00' || lpad(p, 2, '0'))::uuid $$;
create function pg_temp.rule(p text) returns public.inbound_rules
language sql as $$ select r.* from public.inbound_rules r where r.id = pg_temp.rid(p) $$;
create function pg_temp.p(p_rule text, p_payload jsonb) returns jsonb
language sql as $$ select public.process_inbound_event(pg_temp.rid(p_rule), p_payload) $$;
create function pg_temp.row_of(p_rule text, p_ext text) returns public.inbound_events
language sql as $$ select e.* from public.inbound_events e
  where e.rule_id = pg_temp.rid(p_rule) and e.external_event_id = p_ext $$;
create function pg_temp.notes(p_deal text) returns int
language sql as $$ select count(*)::int from public.activities
  where deal_id = ('e5200000-0000-4000-8000-0000000000d' || p_deal)::uuid and type = 'note' $$;
create function pg_temp.ident(p_rule text, p_payload jsonb) returns text
language sql as $$ select private.inbound_resolve(pg_temp.rule(p_rule), p_payload || '{"id":"x"}') ->> 'identifier' $$;
create function pg_temp.chk(p_match_field text, p_cfg jsonb, p_key text default null) returns void
language sql as $$ select private.assert_inbound_rule_config((select v from fx where k = 'ta'),
  'e5200000-0000-4000-8000-0000000000a1', array['e5200000-0000-4000-8000-000000000a12']::uuid[],
  'add_note', p_cfg, p_match_field, 'email', p_key, 'id', '[]') $$;
create function pg_temp.asaas(p_ext text, p_event text) returns jsonb
language sql as $$ select jsonb_build_object('event', p_event,
  'payment', jsonb_build_object('id', p_ext, 'email', 'ana@x.com')) $$;

select set_config('request.jwt.claims', '{"role":"service_role"}', false);

-- 1-6. Colunas novas e grants por coluna.
select col_not_null('public', 'inbound_rules', 'ignored_count', 'ignored_count not null');
select col_default_is('public', 'inbound_rules', 'ignored_count', '0', 'ignored_count default 0');
select ok(has_column_privilege('authenticated', 'public.inbound_rules', 'ignored_count', 'SELECT')
          and has_column_privilege('authenticated', 'public.inbound_rules', 'last_ignored_at', 'SELECT')
          and has_column_privilege('authenticated', 'public.inbound_rules', 'last_ignored_reason', 'SELECT'),
  'authenticated lê ignored_count, last_ignored_at e last_ignored_reason');
select ok(not has_column_privilege('authenticated', 'public.inbound_rules', 'ignored_count', 'UPDATE')
          and not has_column_privilege('authenticated', 'public.inbound_rules', 'last_ignored_reason', 'UPDATE'),
  'authenticated não escreve as colunas novas');
select ok(not has_column_privilege('anon', 'public.inbound_rules', 'ignored_count', 'SELECT')
          and not has_column_privilege('anon', 'public.inbound_rules', 'last_ignored_at', 'SELECT')
          and not has_column_privilege('anon', 'public.inbound_rules', 'last_ignored_reason', 'SELECT'),
  'anon não lê as colunas novas');
select ok(not has_column_privilege('anon', 'public.inbound_rules', 'max_actions_per_minute', 'SELECT'),
  'anon continua sem ler os limites');

-- 7-12. Grants das funções novas.
select ok(not has_function_privilege('anon', 'public.record_inbound_ignored(uuid, text)', 'execute')
          and not has_function_privilege('authenticated', 'public.record_inbound_ignored(uuid, text)', 'execute'),
  'record_inbound_ignored: anon e authenticated não executam');
select ok(has_function_privilege('service_role', 'public.record_inbound_ignored(uuid, text)', 'execute'),
  'record_inbound_ignored: service_role executa');
select ok(not has_function_privilege('anon', 'public.set_inbound_rule_limits(uuid, integer, integer)', 'execute'),
  'set_inbound_rule_limits: anon não executa');
select ok(has_function_privilege('authenticated', 'public.set_inbound_rule_limits(uuid, integer, integer)', 'execute'),
  'set_inbound_rule_limits: authenticated executa (guarda interna)');
select ok(not has_function_privilege('anon', 'public.inbound_rule_stats_tenant()', 'execute'),
  'inbound_rule_stats_tenant: anon não executa');
select ok(has_function_privilege('authenticated', 'public.inbound_rule_stats_tenant()', 'execute'),
  'inbound_rule_stats_tenant: authenticated executa (guarda interna)');

-- 13-22. Item 1: ignored por condição falsa reprocessa; o resto continua deduplicado.
select is(pg_temp.p('1', pg_temp.asaas('pay1', 'PAYMENT_CREATED')) ->> 'status', 'ignored',
  'Asaas CREATED (condição falsa): ignored');
select is((select e.extracted ->> 'conditions_ok' from pg_temp.row_of('1', 'pay1') e), 'false',
  'extracted grava conditions_ok = false');
select is(pg_temp.p('1', pg_temp.asaas('pay1', 'PAYMENT_CONFIRMED')) ->> 'status', 'processed',
  'CONFIRMED do mesmo payment.id: reprocessa e age');
select is((select row(e.status, e.attempts, e.duplicate_count, e.extracted ->> 'conditions_ok')::text
             from pg_temp.row_of('1', 'pay1') e),
  row('processed', 2, 0, 'true')::text, 'reprocesso: mesma linha, attempts 2, conditions_ok true');
select is(pg_temp.p('1', pg_temp.asaas('pay1', 'PAYMENT_RECEIVED')) ->> 'status', 'duplicate',
  'RECEIVED do mesmo payment.id depois de processed: duplicate');
select is(pg_temp.notes('1'), 1, 'CONFIRMED + RECEIVED: 1 nota só');
select is(pg_temp.p('4', '{"id":"m1","email":"cia@x.com"}') ->> 'status', 'ignored',
  'already_in_stage: ignored com condição verdadeira');
select is(pg_temp.p('4', '{"id":"m1","email":"cia@x.com"}') ->> 'status', 'duplicate',
  'ignored com conditions_ok = true continua duplicate');
select is((select row(e.attempts, e.duplicate_count)::text from pg_temp.row_of('4', 'm1') e),
  row(1, 1)::text, 'ignored com condição verdadeira: attempts 1, duplicate_count 1');
select is(pg_temp.p('1', pg_temp.asaas('pay2', 'PAYMENT_OVERDUE')) ->> 'status', 'ignored',
  'outro payment com condição falsa: ignored');

-- 23-30. Item 6: contador de ignorados.
select is((select ignored_count from public.inbound_rules where id = pg_temp.rid('1')), 0, 'contador nasce 0');
select is(pg_temp.p('1', '{"event":"PAYMENT_RECEIVED","payment":{"email":"ana@x.com"}}'),
  '{"status":"missing_event_id"}'::jsonb, 'sem payment.id: missing_event_id');
select is(pg_temp.p('1', jsonb_build_object('event', 'PAYMENT_RECEIVED', 'payment', jsonb_build_object('id', repeat('x', 201)))),
  '{"status":"missing_event_id"}'::jsonb, 'id acima de 200: missing_event_id');
select is((select row(ignored_count, last_ignored_reason, last_ignored_at)::text
             from public.inbound_rules where id = pg_temp.rid('1')),
  row(2, 'missing_event_id', now())::text, 'missing_event_id conta 2, motivo e instante');
select is((select count(*)::int from public.inbound_events where rule_id = pg_temp.rid('1')), 2,
  'missing_event_id não cria evento');
select lives_ok($$ select public.record_inbound_ignored(pg_temp.rid('1'), 'invalid_json') $$,
  'record_inbound_ignored aceita invalid_json');
select is((select row(ignored_count, last_ignored_reason)::text from public.inbound_rules where id = pg_temp.rid('1')),
  row(3, 'invalid_json')::text, 'record_inbound_ignored conta e grava o motivo');
select throws_ok($$ select public.record_inbound_ignored(pg_temp.rid('1'), 'outro') $$,
  '22023', 'motivo invalido', 'motivo fora da lista fechada recusado');

-- 31-32. Guardas de service_role (fora do grant: claims authenticated como dono do banco).
select set_config('request.jwt.claims', '{"sub":"e5200000-0000-4000-8000-00000000000a","role":"authenticated"}', false);
select throws_ok($$ select public.record_inbound_ignored(pg_temp.rid('1'), 'invalid_json') $$,
  '42501', 'service_role required', 'record_inbound_ignored: guarda interna recusa authenticated');
select is((select ignored_count from public.inbound_rules where id = pg_temp.rid('1')), 3,
  'guarda recusou sem contar');
select set_config('request.jwt.claims', '{"role":"service_role"}', false);

-- 33-44. Item 9: match_fallback_path.
select lives_ok($$ select pg_temp.chk('email', '{"text":"x","match_fallback_path":"customer_email"}') $$,
  'fallback aceito com email');
select lives_ok($$ select pg_temp.chk('phone', '{"text":"x","match_fallback_path":"buyer.cell"}') $$,
  'fallback aceito com phone');
select throws_ok($$ select pg_temp.chk('deal_custom_field', '{"text":"x","match_fallback_path":"a"}', 'pedido') $$,
  '22023', 'caminho alternativo invalido', 'fallback recusado com deal_custom_field');
select throws_ok($$ select pg_temp.chk('email', '{"text":"x","match_fallback_path":"a b"}') $$,
  '22023', 'caminho alternativo invalido', 'fallback com caminho inválido recusado');
select throws_ok($$ select pg_temp.chk('email', '{"text":"x","match_fallback_path":1}') $$,
  '22023', 'caminho alternativo invalido', 'fallback não texto recusado');
select is(pg_temp.ident('2', '{"customer_details":{"email":null},"customer_email":" Ana@X.com "}'), 'ana@x.com',
  'email: principal null usa o fallback normalizado');
select is(pg_temp.ident('2', '{"customer_details":{"email":""},"customer_email":"ana@x.com"}'), 'ana@x.com',
  'email: principal vazio usa o fallback');
select is(pg_temp.ident('2', '{"customer_details":{"email":"bia@x.com"},"customer_email":"ana@x.com"}'), 'bia@x.com',
  'email: principal presente vence o fallback');
select is(pg_temp.ident('2', '{}'), null, 'email: sem os dois, identificador null');
select is(pg_temp.ident('3', '{"buyer":{"cell":"(11) 98888-7777"}}'), '+5511988887777',
  'phone: fallback com prefixo');
select is(pg_temp.ident('3', '{"buyer":{"phone":null,"cell":"+55 11 98888-7777"}}'), '+5511988887777',
  'phone: fallback em E.164 não ganha prefixo de novo');
select is(pg_temp.p('2', '{"id":"cs1","customer_details":{"email":null},"customer_email":"ana@x.com"}') ->> 'status',
  'processed', 'process com fallback: age no negócio da Ana');

-- Eventos de fora da janela/tenant para a estatística (como dono do banco).
insert into public.inbound_events (tenant_id, rule_id, external_event_id, status, received_at) values
  ((select v from fx where k = 'ta'), pg_temp.rid('2'), 'velho', 'processed', now() - interval '25 hours'),
  ((select v from fx where k = 'tb'), pg_temp.rid('b1'), 'b-ev', 'ignored', now());

-- 45-46. Regra nova com fallback pela RPC do admin.
select set_config('request.jwt.claims', '{"sub":"e5200000-0000-4000-8000-00000000000a","role":"authenticated"}', false);
set local role authenticated;
select lives_ok($$ select * from public.create_inbound_rule('Stripe fallback', 'aceleraflow_hmac', null, null,
  'e5200000-0000-4000-8000-0000000000a1', array['e5200000-0000-4000-8000-000000000a12']::uuid[],
  'add_note', '{"text":"pago","match_fallback_path":"data.object.customer_email"}', 'email',
  'data.object.customer_details.email', null, 'id', '[]', 'ignore') $$, 'create_inbound_rule aceita match_fallback_path');
select throws_ok($$ select * from public.create_inbound_rule('Fallback ruim', 'aceleraflow_hmac', null, null,
  'e5200000-0000-4000-8000-0000000000a1', array['e5200000-0000-4000-8000-000000000a12']::uuid[],
  'add_note', '{"text":"pago","match_fallback_path":"a b"}', 'email', 'email', null, 'id', '[]', 'ignore') $$,
  '22023', 'caminho alternativo invalido', 'create_inbound_rule recusa fallback inválido');

-- 47-56. Item 7: set_inbound_rule_limits (admin A).
select lives_ok($$ select public.set_inbound_rule_limits('e5200000-0000-4000-8000-0000000e0001', 60, 1000) $$,
  'admin A edita os limites');
select lives_ok($$ select public.set_inbound_rule_limits('e5200000-0000-4000-8000-0000000e0002', 120, 5000) $$,
  'tetos 120/5000 aceitos');
select lives_ok($$ select public.set_inbound_rule_limits('e5200000-0000-4000-8000-0000000e0003', 1, 1) $$,
  'pisos 1/1 aceitos');
select throws_ok($$ select public.set_inbound_rule_limits('e5200000-0000-4000-8000-0000000e0001', 0, 100) $$,
  '22023', 'limite por minuto invalido', 'por minuto 0 recusado');
select throws_ok($$ select public.set_inbound_rule_limits('e5200000-0000-4000-8000-0000000e0001', 121, 100) $$,
  '22023', 'limite por minuto invalido', 'por minuto 121 recusado (teto da edge)');
select throws_ok($$ select public.set_inbound_rule_limits('e5200000-0000-4000-8000-0000000e0001', null, 100) $$,
  '22023', 'limite por minuto invalido', 'por minuto null recusado');
select throws_ok($$ select public.set_inbound_rule_limits('e5200000-0000-4000-8000-0000000e0001', 10, 0) $$,
  '22023', 'limite diario invalido', 'por dia 0 recusado');
select throws_ok($$ select public.set_inbound_rule_limits('e5200000-0000-4000-8000-0000000e0001', 10, 5001) $$,
  '22023', 'limite diario invalido', 'por dia 5001 recusado');
select throws_ok($$ select public.set_inbound_rule_limits('e5200000-0000-4000-8000-0000000e00b1', 10, 10) $$,
  'P0002', 'regra nao encontrada', 'admin A em regra do tenant B: não encontrada');
select throws_ok($$ select public.set_inbound_rule_limits('e5200000-0000-4000-8000-0000000e00ff', 10, 10) $$,
  'P0002', 'regra nao encontrada', 'regra inexistente: mesma resposta');

-- 57-58. Item 8: estatística do tenant inteiro (admin A).
select is((select count(*)::int from public.inbound_rule_stats_tenant() s
            where s.rule_id = 'e5200000-0000-4000-8000-0000000e00b1'), 0,
  'admin A não vê estatística da regra do tenant B');
select is((select jsonb_object_agg(s.rule_id || ':' || s.status, s.total) from public.inbound_rule_stats_tenant() s),
  jsonb_build_object('e5200000-0000-4000-8000-0000000e0001:ignored', 1,
                     'e5200000-0000-4000-8000-0000000e0001:processed', 1,
                     'e5200000-0000-4000-8000-0000000e0002:processed', 1,
                     'e5200000-0000-4000-8000-0000000e0004:ignored', 1),
  'admin A: contagem por regra e status das últimas 24 h (evento antigo fora)');
reset role;

-- 59-62. Valores gravados e isolamento entre tenants (admin B, agente C, anon).
select is((select row(max_actions_per_minute, max_actions_per_day)::text from public.inbound_rules
            where id = pg_temp.rid('1')), row(60, 1000)::text, 'limites gravados');
select set_config('request.jwt.claims', '{"sub":"e5200000-0000-4000-8000-00000000000b","role":"authenticated"}', false);
set local role authenticated;
select throws_ok($$ select public.set_inbound_rule_limits('e5200000-0000-4000-8000-0000000e0001', 5, 5) $$,
  'P0002', 'regra nao encontrada', 'admin B em regra do tenant A: não encontrada');
select is((select count(*)::int from public.inbound_rule_stats_tenant()), 1,
  'admin B só vê a própria regra');
reset role;
select is((select row(max_actions_per_minute, max_actions_per_day)::text from public.inbound_rules
            where id = pg_temp.rid('1')), row(60, 1000)::text, 'limites de A intactos depois da tentativa de B');

-- 63-66. 42501 sem developer.manage (agente C) e anon.
select set_config('request.jwt.claims', '{"sub":"e5200000-0000-4000-8000-00000000000c","role":"authenticated"}', false);
set local role authenticated;
select throws_ok($$ select public.set_inbound_rule_limits('e5200000-0000-4000-8000-0000000e0001', 5, 5) $$,
  '42501', 'permission denied', 'agente sem developer.manage não edita limites');
select throws_ok($$ select * from public.inbound_rule_stats_tenant() $$,
  '42501', 'permission denied', 'agente sem developer.manage não vê estatística');
reset role;
select set_config('request.jwt.claims', '{"role":"anon"}', false);
set local role anon;
select throws_ok($$ select public.set_inbound_rule_limits('e5200000-0000-4000-8000-0000000e0001', 5, 5) $$,
  '42501', null, 'anon não edita limites');
select throws_ok($$ select * from public.inbound_rule_stats_tenant() $$,
  '42501', null, 'anon não vê estatística');
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', false);

-- 67-68. Funções security definer só com search_path; limites intactos.
select is((select count(*)::int from pg_proc pr
  where pr.oid in ('private.assert_inbound_rule_config(uuid, uuid, uuid[], text, jsonb, text, text, text, text, jsonb)'::regprocedure,
                   'private.inbound_resolve(public.inbound_rules, jsonb)'::regprocedure,
                   'public.process_inbound_event(uuid, jsonb)'::regprocedure,
                   'public.record_inbound_ignored(uuid, text)'::regprocedure,
                   'public.set_inbound_rule_limits(uuid, integer, integer)'::regprocedure,
                   'public.inbound_rule_stats_tenant()'::regprocedure)
    and pr.prosecdef
    and (select count(*) from unnest(pr.proconfig) c where c not like 'search_path=%') = 0), 6,
  'as 6 funções são security definer e só setam search_path');
select is((select row(max_actions_per_minute, max_actions_per_day)::text from public.inbound_rules
            where id = pg_temp.rid('1')), row(60, 1000)::text, 'agente e anon não mudaram os limites');

-- 69-76. not_found reprocessa (nada agiu): evento que chega antes do negócio existir não
-- ocupa a chave de dedupe. Depois de processed, continua duplicate. No fim: a estatística
-- dos testes 57-58 já foi conferida.
select is(pg_temp.p('1', '{"event":"PAYMENT_CONFIRMED","payment":{"id":"pay3","email":"dani@x.com"}}') ->> 'status',
  'not_found', 'CONFIRMED antes do contato existir: not_found');
select is((select row(e.status, e.attempts)::text from pg_temp.row_of('1', 'pay3') e),
  row('not_found', 1)::text, 'not_found gravado, attempts 1');
insert into public.contacts (id, tenant_id, name, email) values
  ('e5200000-0000-4000-8000-0000000000c4', (select v from fx where k = 'ta'), 'Dani', 'dani@x.com');
insert into public.deals (id, tenant_id, board_id, stage_id, contact_id, title, status) values
  ('e5200000-0000-4000-8000-0000000000d4', (select v from fx where k = 'ta'), 'e5200000-0000-4000-8000-0000000000a1',
   'e5200000-0000-4000-8000-000000000a11', 'e5200000-0000-4000-8000-0000000000c4', 'Dani', 'open');
select is(pg_temp.p('1', '{"event":"PAYMENT_RECEIVED","payment":{"id":"pay3","email":"dani@x.com"}}') ->> 'status',
  'processed', 'reenvio do mesmo payment.id depois de criar o negócio: age');
select is((select row(e.status, e.attempts, e.duplicate_count)::text from pg_temp.row_of('1', 'pay3') e),
  row('processed', 2, 0)::text, 'reprocesso de not_found: mesma linha, attempts 2, duplicate_count 0');
select is(pg_temp.notes('4'), 1, 'reprocesso de not_found: 1 nota');
select is(pg_temp.p('1', '{"event":"PAYMENT_RECEIVED","payment":{"id":"pay3","email":"dani@x.com"}}') ->> 'status',
  'duplicate', 'depois de processed: duplicate');
select is((select row(e.attempts, e.duplicate_count)::text from pg_temp.row_of('1', 'pay3') e),
  row(2, 1)::text, 'duplicate: attempts 2, duplicate_count 1');
select is(pg_temp.notes('4'), 1, 'duplicate não cria outra nota');

-- 77. set_inbound_rule_limits com p_id nulo (admin A): mesma resposta de regra inexistente.
select set_config('request.jwt.claims', '{"sub":"e5200000-0000-4000-8000-00000000000a","role":"authenticated"}', false);
set local role authenticated;
select throws_ok($$ select public.set_inbound_rule_limits(null, 10, 10) $$,
  'P0002', 'regra nao encontrada', 'p_id nulo: regra nao encontrada');
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', false);

select * from finish();
rollback;
