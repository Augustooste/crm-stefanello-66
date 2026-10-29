-- v2 Task 4: public.process_inbound_event e public.get_inbound_rule_auth.
-- Rodar: pnpm test:db.
begin;
create extension if not exists pgtap;

select plan(78);

-- Fixture: admin A com tenant próprio (handle_new_user).
insert into auth.users (id, email) values
  ('e4000000-0000-4000-8000-00000000000a', 'process-adm-a@test.local');
create temp table fx(k text primary key, v uuid);
insert into fx select 'ta', tenant_id from public.profiles where id = 'e4000000-0000-4000-8000-00000000000a';
grant select on fx to public;

insert into public.boards (id, tenant_id, name) values
  ('e4000000-0000-4000-8000-0000000000a1', (select v from fx where k = 'ta'), 'Funil A1');
insert into public.board_stages (id, board_id, name, position, is_won, is_lost) values
  ('e4000000-0000-4000-8000-000000000a11', 'e4000000-0000-4000-8000-0000000000a1', 'Novo', 0, false, false),
  ('e4000000-0000-4000-8000-000000000a12', 'e4000000-0000-4000-8000-0000000000a1', 'Proposta', 1, false, false),
  ('e4000000-0000-4000-8000-000000000a13', 'e4000000-0000-4000-8000-0000000000a1', 'Pago', 2, true, false);

insert into public.contacts (id, tenant_id, name, email) values
  ('e4000000-0000-4000-8000-0000000000c1', (select v from fx where k = 'ta'), 'Ana', 'ana@x.com'),
  ('e4000000-0000-4000-8000-0000000000c2', (select v from fx where k = 'ta'), 'Bia', 'bia@x.com'),
  ('e4000000-0000-4000-8000-0000000000c3', (select v from fx where k = 'ta'), 'Caio', 'fechado@x.com'),
  ('e4000000-0000-4000-8000-0000000000c4', (select v from fx where k = 'ta'), 'Dora', 'dupla@x.com'),
  ('e4000000-0000-4000-8000-0000000000c5', (select v from fx where k = 'ta'), 'Edu', 'ja@x.com');

-- d1 recebe notas; d2 é o alvo do conflito; d3 já ganho; d4/d5 ambíguos; d6 já na etapa destino.
insert into public.deals (id, tenant_id, board_id, stage_id, contact_id, title, status) values
  ('e4000000-0000-4000-8000-0000000000d1', (select v from fx where k = 'ta'), 'e4000000-0000-4000-8000-0000000000a1',
   'e4000000-0000-4000-8000-000000000a11', 'e4000000-0000-4000-8000-0000000000c1', 'Notas', 'open'),
  ('e4000000-0000-4000-8000-0000000000d2', (select v from fx where k = 'ta'), 'e4000000-0000-4000-8000-0000000000a1',
   'e4000000-0000-4000-8000-000000000a11', 'e4000000-0000-4000-8000-0000000000c2', 'Mover', 'open'),
  ('e4000000-0000-4000-8000-0000000000d3', (select v from fx where k = 'ta'), 'e4000000-0000-4000-8000-0000000000a1',
   'e4000000-0000-4000-8000-000000000a13', 'e4000000-0000-4000-8000-0000000000c3', 'Ganho', 'won'),
  ('e4000000-0000-4000-8000-0000000000d4', (select v from fx where k = 'ta'), 'e4000000-0000-4000-8000-0000000000a1',
   'e4000000-0000-4000-8000-000000000a11', 'e4000000-0000-4000-8000-0000000000c4', 'Dupla 1', 'open'),
  ('e4000000-0000-4000-8000-0000000000d5', (select v from fx where k = 'ta'), 'e4000000-0000-4000-8000-0000000000a1',
   'e4000000-0000-4000-8000-000000000a11', 'e4000000-0000-4000-8000-0000000000c4', 'Dupla 2', 'open'),
  ('e4000000-0000-4000-8000-0000000000d6', (select v from fx where k = 'ta'), 'e4000000-0000-4000-8000-0000000000a1',
   'e4000000-0000-4000-8000-000000000a12', 'e4000000-0000-4000-8000-0000000000c5', 'Ja na etapa', 'open');

-- Regras como dono do banco (validação de criação coberta pela Task 1). Uma por cenário de
-- limite: a do dia pausa e cada uma consome a própria cota.
insert into public.inbound_rules (id, tenant_id, name, verification_mode, board_id, allowed_stage_ids,
  action, action_config, match_field, match_path, event_id_path, not_found_mode,
  max_actions_per_minute, max_actions_per_day, active) values
  ('e4000000-0000-4000-8000-0000000e0001', (select v from fx where k = 'ta'), 'Dedupe', 'aceleraflow_hmac',
   'e4000000-0000-4000-8000-0000000000a1', array['e4000000-0000-4000-8000-000000000a12']::uuid[],
   'add_note', '{"text":"pago"}', 'email', 'email', 'id', 'ignore', 30, 500, true),
  ('e4000000-0000-4000-8000-0000000e0002', (select v from fx where k = 'ta'), 'Minuto', 'aceleraflow_hmac',
   'e4000000-0000-4000-8000-0000000000a1', array['e4000000-0000-4000-8000-000000000a12']::uuid[],
   'add_note', '{"text":"pago"}', 'email', 'email', 'id', 'ignore', 30, 500, true),
  ('e4000000-0000-4000-8000-0000000e0003', (select v from fx where k = 'ta'), 'Dia', 'aceleraflow_hmac',
   'e4000000-0000-4000-8000-0000000000a1', array['e4000000-0000-4000-8000-000000000a12']::uuid[],
   'add_note', '{"text":"pago"}', 'email', 'email', 'id', 'ignore', 30, 3, true),
  ('e4000000-0000-4000-8000-0000000e0004', (select v from fx where k = 'ta'), 'Inativa', 'aceleraflow_hmac',
   'e4000000-0000-4000-8000-0000000000a1', array['e4000000-0000-4000-8000-000000000a12']::uuid[],
   'add_note', '{"text":"pago"}', 'email', 'email', 'id', 'ignore', 30, 500, false),
  ('e4000000-0000-4000-8000-0000000e0005', (select v from fx where k = 'ta'), 'Mover', 'aceleraflow_hmac',
   'e4000000-0000-4000-8000-0000000000a1', array['e4000000-0000-4000-8000-000000000a12']::uuid[],
   'move_stage', '{"to_stage_id":"e4000000-0000-4000-8000-000000000a12"}', 'email', 'email', 'id', 'ignore', 30, 500, true),
  ('e4000000-0000-4000-8000-0000000e0006', (select v from fx where k = 'ta'), 'Grande', 'aceleraflow_hmac',
   'e4000000-0000-4000-8000-0000000000a1', array['e4000000-0000-4000-8000-000000000a12']::uuid[],
   'add_note', '{"text":"{{big}}"}', 'email', 'email', 'id', 'record', 30, 500, true);
insert into public.inbound_rules (id, tenant_id, name, verification_mode, board_id, allowed_stage_ids,
  action, action_config, match_field, match_path, event_id_path, conditions) values
  ('e4000000-0000-4000-8000-0000000e0007', (select v from fx where k = 'ta'), 'Condicao', 'aceleraflow_hmac',
   'e4000000-0000-4000-8000-0000000000a1', array['e4000000-0000-4000-8000-000000000a12']::uuid[],
   'add_note', '{"text":"pago"}', 'email', 'email', 'id', '[{"path":"type","equals":"pago"}]');

-- Segredos de teste no vault para a regra Dedupe (atual e anterior). Valores fictícios.
update public.inbound_rules
   set vault_secret_id = vault.create_secret('segredo-de-teste-atual', 'inbound_rule:t4:atual', 't4'),
       previous_vault_secret_id = vault.create_secret('segredo-de-teste-antigo', 'inbound_rule:t4:antigo', 't4'),
       previous_secret_expires_at = now() + interval '1 hour'
 where id = 'e4000000-0000-4000-8000-0000000e0001';

-- Gatilhos de teste (dropados no fim): erro com sqlstate escolhido por GUC ao criar
-- atividade, e UPDATE de negócio pulado (força o conflict do apply).
create function public.t4_fail_activity() returns trigger language plpgsql as $$
declare v_code text := nullif(current_setting('t4.fail_code', true), '');
begin
  if v_code is not null then raise exception 'falha forcada t4' using errcode = v_code; end if;
  return new;
end $$;
create trigger zz_t4_fail_activity before insert on public.activities
  for each row execute function public.t4_fail_activity();
create function public.t4_skip_deal_update() returns trigger language plpgsql as $$
begin
  if current_setting('t4.skip_deal', true) = 'on' then return null; end if;
  return new;
end $$;
create trigger zz_t4_skip_deal_update before update on public.deals
  for each row execute function public.t4_skip_deal_update();

create function pg_temp.ev(p_id text, p_email text default 'ana@x.com') returns jsonb
language sql as $$ select jsonb_build_object('id', p_id, 'email', p_email) $$;
create function pg_temp.p(p_rule text, p_payload jsonb) returns jsonb
language sql as $$ select public.process_inbound_event(('e4000000-0000-4000-8000-0000000e000' || p_rule)::uuid, p_payload) $$;
create function pg_temp.row_of(p_rule text, p_ext text) returns public.inbound_events
language sql as $$ select e.* from public.inbound_events e
  where e.rule_id = ('e4000000-0000-4000-8000-0000000e000' || p_rule)::uuid and e.external_event_id = p_ext $$;
create function pg_temp.notes() returns int
language sql as $$ select count(*)::int from public.activities
  where deal_id = 'e4000000-0000-4000-8000-0000000000d1' and type = 'note' $$;

select set_config('request.jwt.claims', '{"role":"service_role"}', false);

-- Mesmo evento 2 vezes: 1 ação, a 2ª é duplicate.
select is(pg_temp.p('1', pg_temp.ev('e1') || '{"token":"segredo-de-teste-atual"}') ->> 'status',
  'processed', 'evento novo: processed');
select is(pg_temp.notes(), 1, 'evento novo: 1 nota');
select is((select row(e.action_taken, e.attempts, e.deal_id, e.processed_at is not null)::text from pg_temp.row_of('1', 'e1') e),
  row('note_added', 1, 'e4000000-0000-4000-8000-0000000000d1'::uuid, true)::text,
  'evento novo: action_taken, attempts 1, deal_id e processed_at');
select is(pg_temp.p('1', pg_temp.ev('e1')),
  jsonb_build_object('status', 'duplicate', 'inbound_event_id', (select id from pg_temp.row_of('1', 'e1'))),
  'mesmo evento: duplicate com o mesmo inbound_event_id');
select is(pg_temp.notes(), 1, 'mesmo evento: continua 1 nota');
select is((select attempts from pg_temp.row_of('1', 'e1')), 1, 'duplicate não conta tentativa');

-- Segredo e resposta: extracted só com valores extraídos; resposta sem dados do negócio.
select ok((select position('segredo-de-teste' in coalesce(extracted::text, '')) = 0 from pg_temp.row_of('1', 'e1')),
  'extracted não contém o segredo enviado no corpo');
select is((select extracted from pg_temp.row_of('1', 'e1')),
  '{"identifier":"ana@x.com","conditions_ok":true,"note_text":"pago"}'::jsonb, 'extracted = só valores extraídos');
select is((select array_agg(k order by k) from jsonb_object_keys(pg_temp.p('1', pg_temp.ev('e1'))) k),
  array['inbound_event_id', 'status'], 'resposta só tem status e inbound_event_id');

-- Falha transitória propaga: nada gravado, a edge responde 503.
select set_config('t4.fail_code', '40P01', false);
select throws_ok($$select pg_temp.p('1', pg_temp.ev('e2'))$$, '40P01', null, 'deadlock propaga (não vira failed)');
select set_config('t4.fail_code', '55P03', false);
select throws_ok($$select pg_temp.p('1', pg_temp.ev('e2'))$$, '55P03', null, 'lock_not_available propaga');
select set_config('t4.fail_code', '', false);
select is(pg_temp.p('1', pg_temp.ev('e2')) ->> 'status', 'processed', 'reenvio após falha transitória: processed');
select is((select attempts from pg_temp.row_of('1', 'e2')), 1, 'falha transitória não deixou linha: attempts 1');

-- Erro de dado vira failed (202) e o reenvio processa com attempts = 2.
select set_config('t4.fail_code', '22023', false);
select is(pg_temp.p('1', pg_temp.ev('e3')) ->> 'status', 'failed', 'erro de dado: failed');
select is((select row(e.status, e.error_code, e.attempts, e.action_taken)::text from pg_temp.row_of('1', 'e3') e),
  row('failed', '22023', 1, null::text)::text, 'failed com error_code = sqlstate, sem mensagem crua');
select is(pg_temp.notes(), 2, 'failed não criou nota (savepoint desfez)');
select set_config('t4.fail_code', '', false);
select is(pg_temp.p('1', pg_temp.ev('e3')) ->> 'status', 'processed', 'failed reprocessado: processed');
select is((select row(e.status, e.error_code, e.attempts, e.action_taken)::text from pg_temp.row_of('1', 'e3') e),
  row('processed', null::text, 2, 'note_added')::text, 'reprocessado: attempts 2, error_code limpo');
select is(pg_temp.notes(), 3, 'reprocessado: exatamente 1 nota nova');
select is(pg_temp.p('1', pg_temp.ev('e3')) ->> 'status', 'duplicate', 'processed não reaplica');

-- 22P02 (uuid/inteiro malformado) também é erro de dado.
select set_config('t4.fail_code', '22P02', false);
select is(pg_temp.p('1', pg_temp.ev('e4')) ->> 'status', 'failed', '22P02: failed');
select is((select error_code from pg_temp.row_of('1', 'e4')), '22P02', '22P02 gravado em error_code');
select set_config('t4.fail_code', '', false);

-- Resultados sem ação.
select is(pg_temp.p('1', pg_temp.ev('e5', 'ninguem@x.com')) ->> 'status', 'not_found', 'not_found');
select ok(not ((select extracted from pg_temp.row_of('1', 'e5')) ? 'identifier'),
  'not_found no modo ignore não guarda o identificador');
select is(pg_temp.p('1', pg_temp.ev('e6', 'fechado@x.com')) ->> 'status', 'ignored', 'negócio fechado: ignored');
select is((select row(e.error_code, e.deal_id)::text from pg_temp.row_of('1', 'e6') e),
  row('deal_not_open', 'e4000000-0000-4000-8000-0000000000d3'::uuid)::text, 'negócio fechado: error_code deal_not_open');
select is(pg_temp.p('1', '{"email":"ana@x.com"}'), '{"status":"missing_event_id"}'::jsonb, 'sem id do evento: missing_event_id');
select is((select count(*)::int from public.inbound_events where rule_id = 'e4000000-0000-4000-8000-0000000e0001'),
  6, 'missing_event_id não grava linha (6 eventos da regra)');

-- Ambíguo, condição falsa e já na etapa.
select is(pg_temp.p('1', pg_temp.ev('e7', 'dupla@x.com')) ->> 'status', 'ambiguous', 'ambíguo: ambiguous');
select is((select row(e.status, e.deal_id)::text from pg_temp.row_of('1', 'e7') e), row('ambiguous', null::uuid)::text,
  'ambíguo: gravado ambiguous, sem deal_id');
select is(pg_temp.p('7', pg_temp.ev('k1') || '{"type":"outro"}') ->> 'status', 'ignored', 'condição falsa: ignored');
select is(pg_temp.p('5', pg_temp.ev('j1', 'ja@x.com')) ->> 'status', 'ignored', 'já na etapa: ignored');
select is((select error_code from pg_temp.row_of('5', 'j1')), 'already_in_stage', 'já na etapa: error_code already_in_stage');

-- conflict do apply vira ignored + conflict (não reprocessável).
select set_config('t4.skip_deal', 'on', false);
select is(pg_temp.p('5', pg_temp.ev('c1', 'bia@x.com')) ->> 'status', 'ignored', 'conflict: ignored');
select set_config('t4.skip_deal', '', false);
select is((select row(e.status, e.error_code, e.action_taken)::text from pg_temp.row_of('5', 'c1') e),
  row('ignored', 'conflict', null::text)::text, 'conflict: error_code conflict, sem action_taken');
select is(pg_temp.p('5', pg_temp.ev('c1', 'bia@x.com')) ->> 'status', 'duplicate', 'conflict não reprocessa');
select is((select stage_id from public.deals where id = 'e4000000-0000-4000-8000-0000000000d2'),
  'e4000000-0000-4000-8000-000000000a11'::uuid, 'conflict: negócio não se moveu');

-- Limite por minuto: 31 eventos distintos com limite 30.
create temp table mins as
select g, r, r ->> 'status' as st
  from generate_series(1, 31) g, lateral (select pg_temp.p('2', pg_temp.ev('m' || g)) as r) x;
select is((select count(*)::int from mins where st = 'processed'), 30, 'minuto: 30 processed');
select is((select g from mins where st = 'rate_limited'), 31, 'minuto: o 31º é rate_limited');
select is((select array_agg(k order by k) from mins, jsonb_object_keys(r) k where g = 31),
  array['inbound_event_id', 'reason', 'retry_after_seconds', 'status'],
  'minuto: resposta só com status, inbound_event_id, reason e retry_after_seconds');
select ok((select r ->> 'reason' = 'minute_limit' and jsonb_typeof(r -> 'retry_after_seconds') = 'number'
                  and (r ->> 'retry_after_seconds')::int between 1 and 60 from mins where g = 31),
  'minuto: reason minute_limit e retry_after_seconds inteiro entre 1 e 60');
select is((select row(e.status, e.error_code)::text from pg_temp.row_of('2', 'm31') e),
  row('rate_limited', 'minute_limit')::text, 'minuto: error_code minute_limit');
select is((select active from public.inbound_rules where id = 'e4000000-0000-4000-8000-0000000e0002'), true,
  'minuto: regra segue ativa');
-- Janela passa: recua só as linhas do limite por minuto desta regra.
update public.rate_limits set created_at = now() - interval '2 minutes'
 where identifier = 'inbound-actions-min:e4000000-0000-4000-8000-0000000e0002';
select is(pg_temp.p('2', pg_temp.ev('m31')) ->> 'status', 'processed', 'minuto: reenvio depois da janela processa');
select is((select attempts from pg_temp.row_of('2', 'm31')), 2, 'minuto: reenvio com attempts 2');

-- Limite diário 3: o 4º é rate_limited e a regra pausa com daily_limit.
-- Ações de mais de 24 h atrás não contam (contagem vem de inbound_events, não de rate_limits).
insert into public.inbound_events (tenant_id, rule_id, external_event_id, status, processed_at)
select (select v from fx where k = 'ta'), 'e4000000-0000-4000-8000-0000000e0003', 'velho' || g, 'processed',
       now() - interval '25 hours'
from generate_series(1, 5) g;
select is(pg_temp.p('3', pg_temp.ev('d1')) ->> 'status', 'processed', 'dia: 1º processed');
select is(pg_temp.p('3', pg_temp.ev('d2')) ->> 'status', 'processed', 'dia: 2º processed');
select is(pg_temp.p('3', pg_temp.ev('d3')) ->> 'status', 'processed', 'dia: 3º processed');
select is(pg_temp.p('3', pg_temp.ev('d4')) - 'inbound_event_id',
  '{"status":"rate_limited","reason":"daily_limit"}'::jsonb, 'dia: 4º rate_limited com reason daily_limit, sem mais chaves');
select is((select row(active, disabled_reason)::text from public.inbound_rules where id = 'e4000000-0000-4000-8000-0000000e0003'),
  row(false, 'daily_limit')::text, 'dia: regra pausada com disabled_reason daily_limit');
select is((select error_code from pg_temp.row_of('3', 'd4')), 'daily_limit', 'dia: error_code daily_limit');

-- Regra inativa ou inexistente: inactive sem linha nova.
select is(pg_temp.p('4', pg_temp.ev('i1')), '{"status":"inactive"}'::jsonb, 'regra inativa: inactive');
select is(pg_temp.p('3', pg_temp.ev('d5')), '{"status":"inactive"}'::jsonb, 'regra pausada pelo limite: inactive');
select is(public.process_inbound_event(gen_random_uuid(), pg_temp.ev('x1')), '{"status":"inactive"}'::jsonb,
  'regra inexistente: mesma resposta inactive');
select is((select count(*)::int from public.inbound_events
  where external_event_id in ('i1', 'd5', 'x1')), 0, 'inactive não grava linha');

-- Reativar não repausa no próximo evento: o diário conta a partir da reativação.
select set_config('request.jwt.claims',
  '{"sub":"e4000000-0000-4000-8000-00000000000a","role":"authenticated"}', false);
select lives_ok($$select public.set_inbound_rule_active('e4000000-0000-4000-8000-0000000e0003', true)$$,
  'reativação pelo admin');
select set_config('request.jwt.claims', '{"role":"service_role"}', false);
select is((select row(active, disabled_reason, reactivated_at = now())::text from public.inbound_rules
  where id = 'e4000000-0000-4000-8000-0000000e0003'), row(true, null::text, true)::text,
  'reativação: active, disabled_reason null e reactivated_at = now()');
-- Na transação now() é fixo: recua o histórico para separar antes e depois da reativação.
update public.inbound_events set processed_at = now() - interval '2 hours'
 where rule_id = 'e4000000-0000-4000-8000-0000000e0003' and external_event_id in ('d1', 'd2', 'd3');
update public.inbound_rules set reactivated_at = now() - interval '1 hour'
 where id = 'e4000000-0000-4000-8000-0000000e0003';
select is(pg_temp.p('3', pg_temp.ev('d4')) ->> 'status', 'processed', 'reativada: o evento barrado processa no reenvio');
select is(pg_temp.p('3', pg_temp.ev('r2')) ->> 'status', 'processed', 'reativada: 2ª ação depois da reativação');
select is(pg_temp.p('3', pg_temp.ev('r3')) ->> 'status', 'processed', 'reativada: 3ª ação depois da reativação');
select is(pg_temp.p('3', pg_temp.ev('r4')) ->> 'reason', 'daily_limit', 'reativada: repausa só ao estourar de novo');
select is((select active from public.inbound_rules where id = 'e4000000-0000-4000-8000-0000000e0003'), false,
  'reativada: pausada de novo');
select set_config('request.jwt.claims',
  '{"sub":"e4000000-0000-4000-8000-00000000000a","role":"authenticated"}', false);
select lives_ok($$select public.set_inbound_rule_active('e4000000-0000-4000-8000-0000000e0003', false)$$,
  'pausa manual pelo admin');
select set_config('request.jwt.claims', '{"role":"service_role"}', false);
select is((select row(disabled_reason, reactivated_at is not null)::text from public.inbound_rules
  where id = 'e4000000-0000-4000-8000-0000000e0003'), row('manual', true)::text,
  'pausa manual mantém reactivated_at');
select ok(has_column_privilege('authenticated', 'public.inbound_rules', 'reactivated_at', 'SELECT')
  and not has_column_privilege('anon', 'public.inbound_rules', 'reactivated_at', 'SELECT')
  and not has_column_privilege('authenticated', 'public.inbound_rules', 'vault_secret_id', 'SELECT')
  and not has_column_privilege('authenticated', 'public.inbound_rules', 'previous_vault_secret_id', 'SELECT'),
  'reactivated_at legível por authenticated, nada para anon, ids do vault seguem fechados');

-- extracted no pior caso (500 caracteres de controle, 6 bytes cada no jsonb) cabe em 4 KB.
select is(pg_temp.p('6', jsonb_build_object('id', 'g1', 'email', repeat(chr(1), 500), 'big', repeat(chr(2), 500))) ->> 'status',
  'not_found', 'extracted grande: evento gravado sem exceção');
select ok((select octet_length(extracted::text) <= 4096 and extracted ? 'identifier' from pg_temp.row_of('6', 'g1')),
  'extracted grande: até 4 KB, identificador guardado no modo record');

-- get_inbound_rule_auth.
select is((select row(a.tenant_id, a.active, a.verification_mode, a.current_secret, a.previous_secret)::text
  from public.get_inbound_rule_auth('e4000000-0000-4000-8000-0000000e0001') a),
  row((select v from fx where k = 'ta'), true, 'aceleraflow_hmac', 'segredo-de-teste-atual',
      'segredo-de-teste-antigo')::text, 'auth: segredo atual e anterior dentro do prazo');
update public.inbound_rules set previous_secret_expires_at = now() - interval '1 second'
 where id = 'e4000000-0000-4000-8000-0000000e0001';
select is((select previous_secret from public.get_inbound_rule_auth('e4000000-0000-4000-8000-0000000e0001')), null,
  'auth: anterior expirado sai null');
select is((select count(*)::int from public.get_inbound_rule_auth(gen_random_uuid())), 0, 'auth: regra inexistente = 0 linhas');
select is((select active from public.get_inbound_rule_auth('e4000000-0000-4000-8000-0000000e0004')), false,
  'auth: devolve active para a edge decidir 401');
update public.inbound_rules set active = false, previous_secret_expires_at = now() + interval '1 hour'
 where id = 'e4000000-0000-4000-8000-0000000e0001';
select is((select row(a.tenant_id, a.active, a.verification_mode, a.current_secret, a.previous_secret)::text
  from public.get_inbound_rule_auth('e4000000-0000-4000-8000-0000000e0001') a),
  row((select v from fx where k = 'ta'), false, 'aceleraflow_hmac', null::text, null::text)::text,
  'auth: regra inativa devolve segredos null e mantém as demais colunas');
update public.inbound_rules set active = true where id = 'e4000000-0000-4000-8000-0000000e0001';

-- Guardas internas (o remix não herda REVOKE) e grants.
select set_config('request.jwt.claims',
  '{"sub":"e4000000-0000-4000-8000-00000000000a","role":"authenticated"}', false);
-- E-mail sem negócio: não chega ao apply (que tem guarda própria com a mesma mensagem).
select throws_ok($$select public.process_inbound_event('e4000000-0000-4000-8000-0000000e0001', '{"id":"z1","email":"ninguem@x.com"}')$$,
  '42501', 'service_role required', 'process_inbound_event: guarda interna 42501 para authenticated');
select throws_ok($$select * from public.get_inbound_rule_auth('e4000000-0000-4000-8000-0000000e0001')$$,
  '42501', 'service_role required', 'get_inbound_rule_auth: guarda interna 42501 para authenticated');
set local role authenticated;
select throws_ok($$select public.process_inbound_event('e4000000-0000-4000-8000-0000000e0001', '{}')$$,
  '42501', null, 'process_inbound_event: authenticated sem EXECUTE');
reset role;
select ok(not has_function_privilege('authenticated', 'public.process_inbound_event(uuid,jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.process_inbound_event(uuid,jsonb)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.get_inbound_rule_auth(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.get_inbound_rule_auth(uuid)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.process_inbound_event(uuid,jsonb)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.get_inbound_rule_auth(uuid)', 'EXECUTE'),
  'só service_role executa as duas funções');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('process_inbound_event', 'get_inbound_rule_auth')
    and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c not like 'search_path=%')), 0,
  'nenhum SET além de search_path');

-- Os gatilhos de teste saem.
drop trigger zz_t4_fail_activity on public.activities;
drop trigger zz_t4_skip_deal_update on public.deals;
drop function public.t4_fail_activity();
drop function public.t4_skip_deal_update();
select is((select count(*)::int from pg_trigger where tgname like 'zz_t4_%'), 0, 'gatilhos de teste removidos');

select * from finish();
rollback;
