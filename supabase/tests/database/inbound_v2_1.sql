-- v2.1 Task A (20261022100000_inbound_v2_1.sql): condição `in`, rastro do reenvio
-- duplicado (duplicate_count/last_duplicate_at) e nota de regra já concluída.
-- Rodar: pnpm test:db.
begin;
create extension if not exists pgtap;
select plan(57);

-- Fixture: admin A com tenant próprio (handle_new_user).
insert into auth.users (id, email) values ('e5100000-0000-4000-8000-00000000000a', 'v21a-adm-a@test.local');
create temp table fx(k text primary key, v uuid);
insert into fx select 'ta', tenant_id from public.profiles where id = 'e5100000-0000-4000-8000-00000000000a';
grant select on fx to public;

insert into public.boards (id, tenant_id, name) values
  ('e5100000-0000-4000-8000-0000000000a1', (select v from fx where k = 'ta'), 'Funil V21');
insert into public.board_stages (id, board_id, name, position, is_won, is_lost) values
  ('e5100000-0000-4000-8000-000000000a11', 'e5100000-0000-4000-8000-0000000000a1', 'Novo', 0, false, false),
  ('e5100000-0000-4000-8000-000000000a12', 'e5100000-0000-4000-8000-0000000000a1', 'Proposta', 1, false, false);
insert into public.contacts (id, tenant_id, name, email) values
  ('e5100000-0000-4000-8000-0000000000c1', (select v from fx where k = 'ta'), 'Ana', 'ana@x.com'),
  ('e5100000-0000-4000-8000-0000000000c2', (select v from fx where k = 'ta'), 'Bia', 'bia@x.com');
insert into public.deals (id, tenant_id, board_id, stage_id, contact_id, title, status) values
  ('e5100000-0000-4000-8000-0000000000d1', (select v from fx where k = 'ta'), 'e5100000-0000-4000-8000-0000000000a1',
   'e5100000-0000-4000-8000-000000000a11', 'e5100000-0000-4000-8000-0000000000c1', 'Notas', 'open'),
  ('e5100000-0000-4000-8000-0000000000d2', (select v from fx where k = 'ta'), 'e5100000-0000-4000-8000-0000000000a1',
   'e5100000-0000-4000-8000-000000000a11', 'e5100000-0000-4000-8000-0000000000c2', 'Tarefas', 'open');

-- Regras gravadas direto (o validador é testado à parte, abaixo).
--   1 in (Asaas)        2 equals (regressão)   3 create_activity   4 in + transform lower
--   5 in + equals (E)
insert into public.inbound_rules (id, tenant_id, name, verification_mode, board_id, allowed_stage_ids,
  action, action_config, match_field, match_path, event_id_path, conditions) values
  ('e5100000-0000-4000-8000-0000000e0001', (select v from fx where k = 'ta'), 'In', 'aceleraflow_hmac',
   'e5100000-0000-4000-8000-0000000000a1', array['e5100000-0000-4000-8000-000000000a12']::uuid[],
   'add_note', '{"text":"pago {{status}}"}', 'email', 'email', 'id',
   '[{"path":"status","in":["CONFIRMED","RECEIVED"]}]'),
  ('e5100000-0000-4000-8000-0000000e0002', (select v from fx where k = 'ta'), 'Equals', 'aceleraflow_hmac',
   'e5100000-0000-4000-8000-0000000000a1', array['e5100000-0000-4000-8000-000000000a12']::uuid[],
   'add_note', '{"text":"pago"}', 'email', 'email', 'id', '[{"path":"status","equals":"PAID"}]'),
  ('e5100000-0000-4000-8000-0000000e0003', (select v from fx where k = 'ta'), 'Tarefa', 'aceleraflow_hmac',
   'e5100000-0000-4000-8000-0000000000a1', array['e5100000-0000-4000-8000-000000000a12']::uuid[],
   'create_activity', '{"title":"cobrar"}', 'email', 'email', 'id', '[]'),
  ('e5100000-0000-4000-8000-0000000e0004', (select v from fx where k = 'ta'), 'InLower', 'aceleraflow_hmac',
   'e5100000-0000-4000-8000-0000000000a1', array['e5100000-0000-4000-8000-000000000a12']::uuid[],
   'add_note', '{"text":"pago"}', 'email', 'email', 'id',
   '[{"path":"s","in":["paid","5"],"transform":"lower"}]'),
  ('e5100000-0000-4000-8000-0000000e0005', (select v from fx where k = 'ta'), 'InEquals', 'aceleraflow_hmac',
   'e5100000-0000-4000-8000-0000000000a1', array['e5100000-0000-4000-8000-000000000a12']::uuid[],
   'add_note', '{"text":"pago"}', 'email', 'email', 'id',
   '[{"path":"status","in":["CONFIRMED","RECEIVED"]},{"path":"kind","equals":"pix"}]');

-- Gatilho de teste (dropado no fim): erro com sqlstate escolhido por GUC ao criar atividade.
create function public.t21a_fail_activity() returns trigger language plpgsql as $$
declare v_code text := nullif(current_setting('t21a.fail_code', true), '');
begin
  if v_code is not null then raise exception 'falha forcada t21a' using errcode = v_code; end if;
  return new;
end $$;
create trigger zz_t21a_fail_activity before insert on public.activities
  for each row execute function public.t21a_fail_activity();

create function pg_temp.rule(p text) returns public.inbound_rules
language sql as $$ select r.* from public.inbound_rules r where r.id = ('e5100000-0000-4000-8000-0000000e000' || p)::uuid $$;
create function pg_temp.ok(p_rule text, p_payload jsonb) returns boolean
language sql as $$ select (private.inbound_resolve(pg_temp.rule(p_rule), p_payload || '{"id":"x","email":"ana@x.com"}') ->> 'conditions_ok')::boolean $$;
create function pg_temp.p(p_rule text, p_payload jsonb) returns jsonb
language sql as $$ select public.process_inbound_event(('e5100000-0000-4000-8000-0000000e000' || p_rule)::uuid, p_payload) $$;
create function pg_temp.row_of(p_rule text, p_ext text) returns public.inbound_events
language sql as $$ select e.* from public.inbound_events e
  where e.rule_id = ('e5100000-0000-4000-8000-0000000e000' || p_rule)::uuid and e.external_event_id = p_ext $$;
create function pg_temp.notes() returns int
language sql as $$ select count(*)::int from public.activities
  where deal_id = 'e5100000-0000-4000-8000-0000000000d1' and type = 'note' $$;
create function pg_temp.chk(p_conditions jsonb) returns void
language sql as $$ select private.assert_inbound_rule_config((select v from fx where k = 'ta'),
  'e5100000-0000-4000-8000-0000000000a1', array['e5100000-0000-4000-8000-000000000a12']::uuid[],
  'add_note', '{"text":"x"}', 'email', 'email', null, 'id', p_conditions) $$;

select set_config('request.jwt.claims', '{"role":"service_role"}', false);

-- 1-4. Colunas novas e grants por coluna.
select col_not_null('public', 'inbound_events', 'duplicate_count', 'duplicate_count not null');
select col_default_is('public', 'inbound_events', 'duplicate_count', '0', 'duplicate_count default 0');
select ok(has_column_privilege('authenticated', 'public.inbound_events', 'duplicate_count', 'SELECT')
          and has_column_privilege('authenticated', 'public.inbound_events', 'last_duplicate_at', 'SELECT'),
  'authenticated lê duplicate_count e last_duplicate_at');
select ok(not has_column_privilege('anon', 'public.inbound_events', 'duplicate_count', 'SELECT')
          and not has_column_privilege('anon', 'public.inbound_events', 'last_duplicate_at', 'SELECT')
          and not has_column_privilege('authenticated', 'public.inbound_events', 'duplicate_count', 'UPDATE'),
  'anon não lê as colunas novas; authenticated não escreve');

-- 5-14. Avaliação de `in` no resolve.
select is(pg_temp.ok('1', '{"status":"CONFIRMED"}'), true, 'in: casa o 1º item');
select is(pg_temp.ok('1', '{"status":"RECEIVED"}'), true, 'in: casa o 2º item');
select is(pg_temp.ok('1', '{"status":"OVERDUE"}'), false, 'in: valor fora da lista não casa');
select is(pg_temp.ok('1', '{}'), false, 'in: caminho ausente não casa');
select is(pg_temp.ok('1', '{"status":null}'), false, 'in: valor JSON null não casa');
select is(pg_temp.ok('1', '{"status":"confirmed"}'), false, 'in: comparação sensível a maiúsculas sem transform');
select is(pg_temp.ok('4', '{"s":" PAID"}'), false, 'in + lower: lower não apara espaço (igual ao equals)');
select is(pg_temp.ok('4', '{"s":"PAID"}'), true, 'in + transform lower casa');
select is(pg_temp.ok('4', '{"s":5}'), true, 'in: número no corpo casa com o texto "5"');
select is(private.inbound_resolve(pg_temp.rule('1'), '{"id":"x","email":"ana@x.com","status":"OVERDUE"}') ->> 'outcome',
  'ignored', 'in que não casa: outcome ignored');

-- 15-18. Regressão do equals e combinação in + equals (E).
select is(pg_temp.ok('2', '{"status":"PAID"}'), true, 'equals: continua casando');
select is(pg_temp.ok('2', '{"status":"CONFIRMED"}'), false, 'equals: continua recusando');
select is(pg_temp.ok('5', '{"status":"RECEIVED","kind":"pix"}'), true, 'in + equals: as duas verdadeiras');
select is(pg_temp.ok('5', '{"status":"RECEIVED","kind":"boleto"}'), false, 'in + equals: equals falso derruba');

-- 19-33. Validação das condições (assert_inbound_rule_config).
select lives_ok($$ select pg_temp.chk('[{"path":"status","in":["CONFIRMED","RECEIVED"]}]') $$, 'in válido aceito');
select lives_ok($$ select pg_temp.chk('[{"path":"status","equals":"PAID","transform":"trim"}]') $$, 'equals continua aceito');
select lives_ok($$ select pg_temp.chk(jsonb_build_array(jsonb_build_object('path', 'a',
  'in', (select jsonb_agg(i::text) from generate_series(1, 10) i)))) $$, 'in com 10 itens aceito');
select lives_ok($$ select pg_temp.chk(jsonb_build_array(jsonb_build_object('path', 'a', 'in', jsonb_build_array(repeat('x', 200))))) $$,
  'item com 200 caracteres aceito');
select throws_ok($$ select pg_temp.chk('[{"path":"a","equals":"1","in":["1"]}]') $$,
  '22023', 'condicao invalida: use exatamente um de equals ou in', 'equals e in juntos recusados');
select throws_ok($$ select pg_temp.chk('[{"path":"a"}]') $$,
  '22023', 'condicao invalida: use exatamente um de equals ou in', 'sem equals nem in recusado');
select throws_ok($$ select pg_temp.chk('[{"path":"a","in":"CONFIRMED"}]') $$,
  '22023', 'condicao invalida: in deve ser lista de 1 a 10 textos nao vazios (ate 200 caracteres cada)', 'in texto (não lista) recusado');
select throws_ok($$ select pg_temp.chk('[{"path":"a","in":null}]') $$,
  '22023', 'condicao invalida: in deve ser lista de 1 a 10 textos nao vazios (ate 200 caracteres cada)', 'in null recusado');
select throws_ok($$ select pg_temp.chk('[{"path":"a","in":[]}]') $$,
  '22023', 'condicao invalida: in deve ser lista de 1 a 10 textos nao vazios (ate 200 caracteres cada)', 'in vazio recusado');
select throws_ok($$ select pg_temp.chk(jsonb_build_array(jsonb_build_object('path', 'a',
  'in', (select jsonb_agg(i::text) from generate_series(1, 11) i)))) $$,
  '22023', 'condicao invalida: in deve ser lista de 1 a 10 textos nao vazios (ate 200 caracteres cada)', 'in com 11 itens recusado');
select throws_ok($$ select pg_temp.chk('[{"path":"a","in":["ok",1]}]') $$,
  '22023', 'condicao invalida: in deve ser lista de 1 a 10 textos nao vazios (ate 200 caracteres cada)', 'item número recusado');
select throws_ok($$ select pg_temp.chk('[{"path":"a","in":["ok","  "]}]') $$,
  '22023', 'condicao invalida: in deve ser lista de 1 a 10 textos nao vazios (ate 200 caracteres cada)', 'item só espaço recusado');
select throws_ok($$ select pg_temp.chk(jsonb_build_array(jsonb_build_object('path', 'a', 'in', jsonb_build_array(repeat('x', 201))))) $$,
  '22023', 'condicao invalida: in deve ser lista de 1 a 10 textos nao vazios (ate 200 caracteres cada)', 'item com 201 caracteres recusado');
select throws_ok($$ select pg_temp.chk('[{"path":"a","in":["1"],"foo":"x"}]') $$,
  '22023', 'condicoes invalidas', 'chave desconhecida recusada');
select throws_ok($$ select pg_temp.chk('[{"path":"a b","in":["1"]}]') $$,
  '22023', 'caminho invalido', 'in com caminho inválido recusado');

-- 34-35. RPC do admin grava regra com `in` (caminho authenticated + developer.manage).
select set_config('request.jwt.claims', '{"sub":"e5100000-0000-4000-8000-00000000000a","role":"authenticated"}', false);
set local role authenticated;
select lives_ok($$ select * from public.create_inbound_rule('Asaas pago', 'header_token', 'asaas-access-token',
  'token-de-teste-123', 'e5100000-0000-4000-8000-0000000000a1', array['e5100000-0000-4000-8000-000000000a12']::uuid[],
  'add_note', '{"text":"pago"}', 'email', 'customer.email', null, 'id',
  '[{"path":"event","in":["PAYMENT_CONFIRMED","PAYMENT_RECEIVED"]}]', 'ignore') $$, 'create_inbound_rule aceita in');
select is((select conditions from public.inbound_rules where name = 'Asaas pago'),
  '[{"path":"event","in":["PAYMENT_CONFIRMED","PAYMENT_RECEIVED"]}]'::jsonb, 'conditions com in gravadas como enviadas');
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', false);

-- 36-46. Rastro do reenvio duplicado e nota concluída.
select is(pg_temp.p('1', '{"id":"e1","email":"ana@x.com","status":"RECEIVED"}') ->> 'status', 'processed',
  'in no process: evento casa e processa');
select is((select row(e.duplicate_count, e.last_duplicate_at)::text from pg_temp.row_of('1', 'e1') e),
  row(0, null::timestamptz)::text, 'evento novo: duplicate_count 0 e last_duplicate_at null');
select is((select row(type, title, due_at, completed_at)::text from public.activities
  where deal_id = 'e5100000-0000-4000-8000-0000000000d1' and type = 'note'),
  row('note', 'pago RECEIVED', now(), now())::text, 'add_note: nota nasce concluída (due_at e completed_at = agora)');
select is(pg_temp.p('1', '{"id":"e1","email":"ana@x.com","status":"RECEIVED"}'),
  jsonb_build_object('status', 'duplicate', 'inbound_event_id', (select id from pg_temp.row_of('1', 'e1'))),
  'reenvio: duplicate com o mesmo contrato');
select is((select row(e.duplicate_count, e.last_duplicate_at, e.status, e.attempts)::text from pg_temp.row_of('1', 'e1') e),
  row(1, now(), 'processed', 1)::text, 'reenvio: duplicate_count 1, last_duplicate_at, status e attempts intactos');
select is(pg_temp.p('1', '{"id":"e1","email":"ana@x.com","status":"RECEIVED"}') ->> 'status', 'duplicate', '2º reenvio: duplicate');
select is((select duplicate_count from pg_temp.row_of('1', 'e1')), 2, '2º reenvio: duplicate_count 2');
select is(pg_temp.notes(), 1, 'reenvios não criam nota');
-- Evento ignorado (in não casa): desde a v2.2 (20261023100000) reprocessa em vez de virar
-- duplicate (condição falsa não ocupa a chave de dedupe); continua ignored, sem nota.
select is(pg_temp.p('1', '{"id":"e3","email":"ana@x.com","status":"OVERDUE"}') ->> 'status', 'ignored', 'in não casa: ignored');
select is(pg_temp.p('1', '{"id":"e3","email":"ana@x.com","status":"OVERDUE"}') ->> 'status', 'ignored', 'ignored por condição reenviado: reprocessa (v2.2)');
select is((select row(e.duplicate_count, e.status, e.attempts)::text from pg_temp.row_of('1', 'e3') e),
  row(0, 'ignored', 2)::text, 'ignored por condição reenviado: attempts 2, duplicate_count 0, status ignored');

-- 47-52. failed continua reprocessável e não conta como duplicado.
select set_config('t21a.fail_code', '22P02', false);
select is(pg_temp.p('1', '{"id":"e2","email":"ana@x.com","status":"CONFIRMED"}') ->> 'status', 'failed', 'erro de dado: failed');
select set_config('t21a.fail_code', '', false);
select is(pg_temp.p('1', '{"id":"e2","email":"ana@x.com","status":"CONFIRMED"}') ->> 'status', 'processed',
  'failed reenviado: reprocessa');
select is((select row(e.attempts, e.duplicate_count, e.status)::text from pg_temp.row_of('1', 'e2') e),
  row(2, 0, 'processed')::text, 'reprocesso: attempts 2, duplicate_count 0');
select is(pg_temp.notes(), 2, 'reprocesso criou a nota');
select is(pg_temp.p('1', '{"id":"e2","email":"ana@x.com","status":"CONFIRMED"}') ->> 'status', 'duplicate',
  'depois de processed: duplicate');
select is((select row(e.attempts, e.duplicate_count)::text from pg_temp.row_of('1', 'e2') e),
  row(2, 1)::text, 'duplicate depois do reprocesso: attempts 2, duplicate_count 1');

-- 53-55. create_activity continua pendente.
select is(pg_temp.p('3', '{"id":"t1","email":"bia@x.com"}') ->> 'status', 'processed', 'create_activity: processed');
select is((select row(type, due_at, completed_at)::text from public.activities
  where deal_id = 'e5100000-0000-4000-8000-0000000000d2'),
  row('task', now() + interval '24 hours', null::timestamptz)::text, 'create_activity: tarefa pendente com prazo');
select is(pg_temp.p('2', '{"id":"q1","email":"ana@x.com","status":"PAID"}') ->> 'status', 'processed',
  'equals no process: continua processando');

-- 56-57. Funções sem SET além de search_path; limpeza.
select is((select count(*)::int from pg_proc pr
  where pr.oid in ('private.assert_inbound_rule_config(uuid, uuid, uuid[], text, jsonb, text, text, text, text, jsonb)'::regprocedure,
                   'private.inbound_resolve(public.inbound_rules, jsonb)'::regprocedure,
                   'private.inbound_apply_action(public.inbound_rules, jsonb, uuid)'::regprocedure,
                   'public.process_inbound_event(uuid, jsonb)'::regprocedure)
    and pr.prosecdef
    and (select count(*) from unnest(pr.proconfig) c where c not like 'search_path=%') = 0), 4,
  'as 4 funções são security definer e só setam search_path');
drop trigger zz_t21a_fail_activity on public.activities;
drop function public.t21a_fail_activity();
select is((select count(*)::int from pg_trigger where tgname like 'zz_t21a_%'), 0, 'gatilho de teste removido');

select * from finish();
rollback;
