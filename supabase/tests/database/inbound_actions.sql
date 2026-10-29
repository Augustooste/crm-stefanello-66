-- v2 Task 3: private.inbound_apply_action (mover/ganhar/perder, nota, atividade).
-- Rodar: pnpm test:db.
begin;
create extension if not exists pgtap;

select plan(51);

-- Fixture: admin A e admin B, cada um com tenant próprio (handle_new_user).
insert into auth.users (id, email) values
  ('e3000000-0000-4000-8000-00000000000a', 'actions-adm-a@test.local'),
  ('e3000000-0000-4000-8000-00000000000b', 'actions-adm-b@test.local');

create temp table fx(k text primary key, v uuid);
insert into fx select 'ta', tenant_id from public.profiles where id = 'e3000000-0000-4000-8000-00000000000a';
insert into fx select 'tb', tenant_id from public.profiles where id = 'e3000000-0000-4000-8000-00000000000b';
grant select on fx to public;

-- Tenant A: funil A1 (Novo, Proposta, Pago=is_won, Perdido=is_lost, Ganho2=is_won, Extra) e A2.
-- Tenant B: funil B1.
insert into public.boards (id, tenant_id, name) values
  ('e3000000-0000-4000-8000-0000000000a1', (select v from fx where k = 'ta'), 'Funil A1'),
  ('e3000000-0000-4000-8000-0000000000a2', (select v from fx where k = 'ta'), 'Funil A2'),
  ('e3000000-0000-4000-8000-0000000000b1', (select v from fx where k = 'tb'), 'Funil B1');
insert into public.board_stages (id, board_id, name, position, is_won, is_lost) values
  ('e3000000-0000-4000-8000-000000000a11', 'e3000000-0000-4000-8000-0000000000a1', 'Novo', 0, false, false),
  ('e3000000-0000-4000-8000-000000000a12', 'e3000000-0000-4000-8000-0000000000a1', 'Proposta', 1, false, false),
  ('e3000000-0000-4000-8000-000000000a13', 'e3000000-0000-4000-8000-0000000000a1', 'Pago', 2, true, false),
  ('e3000000-0000-4000-8000-000000000a14', 'e3000000-0000-4000-8000-0000000000a1', 'Perdido', 3, false, true),
  ('e3000000-0000-4000-8000-000000000a15', 'e3000000-0000-4000-8000-0000000000a1', 'Ganho2', 4, true, false),
  ('e3000000-0000-4000-8000-000000000a16', 'e3000000-0000-4000-8000-0000000000a1', 'Extra', 5, false, false),
  ('e3000000-0000-4000-8000-000000000a21', 'e3000000-0000-4000-8000-0000000000a2', 'Outra', 0, false, false),
  ('e3000000-0000-4000-8000-000000000b11', 'e3000000-0000-4000-8000-0000000000b1', 'Etapa B', 0, false, false),
  ('e3000000-0000-4000-8000-000000000b12', 'e3000000-0000-4000-8000-0000000000b1', 'Ganho B', 1, true, false);

insert into public.contacts (id, tenant_id, name, email) values
  ('e3000000-0000-4000-8000-0000000000c1', (select v from fx where k = 'ta'), 'Ana', 'ana@x.com'),
  ('e3000000-0000-4000-8000-0000000000cb', (select v from fx where k = 'tb'), 'Bia', 'bia@x.com');

-- d1 ganha, d2 perde, d3 conflito de etapa, d4 nota/atividade, d5 move, d6 etapa apagada,
-- d7 etapa que muda de tipo, d8 de outro funil do tenant A, db do tenant B.
insert into public.deals (id, tenant_id, board_id, stage_id, contact_id, title, status) values
  ('e3000000-0000-4000-8000-0000000000d1', (select v from fx where k = 'ta'), 'e3000000-0000-4000-8000-0000000000a1',
   'e3000000-0000-4000-8000-000000000a11', 'e3000000-0000-4000-8000-0000000000c1', 'Ganhar', 'open'),
  ('e3000000-0000-4000-8000-0000000000d2', (select v from fx where k = 'ta'), 'e3000000-0000-4000-8000-0000000000a1',
   'e3000000-0000-4000-8000-000000000a11', 'e3000000-0000-4000-8000-0000000000c1', 'Perder', 'open'),
  ('e3000000-0000-4000-8000-0000000000d3', (select v from fx where k = 'ta'), 'e3000000-0000-4000-8000-0000000000a1',
   'e3000000-0000-4000-8000-000000000a12', 'e3000000-0000-4000-8000-0000000000c1', 'Ja mudou', 'open'),
  ('e3000000-0000-4000-8000-0000000000d4', (select v from fx where k = 'ta'), 'e3000000-0000-4000-8000-0000000000a1',
   'e3000000-0000-4000-8000-000000000a11', 'e3000000-0000-4000-8000-0000000000c1', 'Nota', 'open'),
  ('e3000000-0000-4000-8000-0000000000d5', (select v from fx where k = 'ta'), 'e3000000-0000-4000-8000-0000000000a1',
   'e3000000-0000-4000-8000-000000000a11', 'e3000000-0000-4000-8000-0000000000c1', 'Mover', 'open'),
  ('e3000000-0000-4000-8000-0000000000d6', (select v from fx where k = 'ta'), 'e3000000-0000-4000-8000-0000000000a1',
   'e3000000-0000-4000-8000-000000000a11', 'e3000000-0000-4000-8000-0000000000c1', 'Etapa apagada', 'open'),
  ('e3000000-0000-4000-8000-0000000000d7', (select v from fx where k = 'ta'), 'e3000000-0000-4000-8000-0000000000a1',
   'e3000000-0000-4000-8000-000000000a11', 'e3000000-0000-4000-8000-0000000000c1', 'Tipo mudou', 'open'),
  ('e3000000-0000-4000-8000-0000000000d8', (select v from fx where k = 'ta'), 'e3000000-0000-4000-8000-0000000000a2',
   'e3000000-0000-4000-8000-000000000a21', 'e3000000-0000-4000-8000-0000000000c1', 'Outro funil', 'open'),
  ('e3000000-0000-4000-8000-0000000000db', (select v from fx where k = 'tb'), 'e3000000-0000-4000-8000-0000000000b1',
   'e3000000-0000-4000-8000-000000000b11', 'e3000000-0000-4000-8000-0000000000cb', 'Negocio B', 'open');

-- Regras como dono do banco (validação de criação coberta pela Task 1).
insert into public.inbound_rules (id, tenant_id, name, verification_mode, board_id, allowed_stage_ids,
  action, action_config, match_field, match_path, event_id_path) values
  ('e3000000-0000-4000-8000-0000000e00a1', (select v from fx where k = 'ta'), 'Ganho', 'aceleraflow_hmac',
   'e3000000-0000-4000-8000-0000000000a1',
   array['e3000000-0000-4000-8000-000000000a13','e3000000-0000-4000-8000-000000000a14']::uuid[],
   'mark_won', '{"to_stage_id":"e3000000-0000-4000-8000-000000000a13"}', 'email', 'email', 'id'),
  ('e3000000-0000-4000-8000-0000000e00a2', (select v from fx where k = 'ta'), 'Perda', 'aceleraflow_hmac',
   'e3000000-0000-4000-8000-0000000000a1', array['e3000000-0000-4000-8000-000000000a14']::uuid[],
   'mark_lost', '{"to_stage_id":"e3000000-0000-4000-8000-000000000a14","reason_text":"x"}', 'email', 'email', 'id'),
  ('e3000000-0000-4000-8000-0000000e00a3', (select v from fx where k = 'ta'), 'Nota', 'aceleraflow_hmac',
   'e3000000-0000-4000-8000-0000000000a1', array['e3000000-0000-4000-8000-000000000a12']::uuid[],
   'add_note', '{"text":"x"}', 'email', 'email', 'id'),
  ('e3000000-0000-4000-8000-0000000e00a4', (select v from fx where k = 'ta'), 'Tarefa', 'aceleraflow_hmac',
   'e3000000-0000-4000-8000-0000000000a1', array['e3000000-0000-4000-8000-000000000a12']::uuid[],
   'create_activity', '{"title":"x","due_in_hours":48}', 'email', 'email', 'id'),
  ('e3000000-0000-4000-8000-0000000e00a5', (select v from fx where k = 'ta'), 'Mover', 'aceleraflow_hmac',
   'e3000000-0000-4000-8000-0000000000a1', array['e3000000-0000-4000-8000-000000000a16']::uuid[],
   'move_stage', '{"to_stage_id":"e3000000-0000-4000-8000-000000000a16"}', 'email', 'email', 'id'),
  ('e3000000-0000-4000-8000-0000000e00a6', (select v from fx where k = 'ta'), 'Ganho2', 'aceleraflow_hmac',
   'e3000000-0000-4000-8000-0000000000a1', array['e3000000-0000-4000-8000-000000000a15']::uuid[],
   'mark_won', '{"to_stage_id":"e3000000-0000-4000-8000-000000000a15"}', 'email', 'email', 'id');

-- Plano no formato de inbound_resolve (Task 2).
create function pg_temp.pl(p_deal uuid, p_from uuid, p_target uuid,
  p_reason text default null, p_note text default null) returns jsonb
language sql as $$
  select jsonb_build_object('external_event_id', 'evt', 'conditions_ok', true, 'identifier', 'ana@x.com',
    'outcome', 'act', 'deal_id', p_deal, 'deal_title', 't', 'from_stage_id', p_from,
    'target_stage_id', p_target, 'reason', p_reason, 'note_text', p_note)
$$;
create function pg_temp.app(p_rule uuid, p_plan jsonb) returns text
language sql as $$
  select private.inbound_apply_action(r, p_plan, 'e3000000-0000-4000-8000-0000000ee001'::uuid)
  from public.inbound_rules r where r.id = p_rule
$$;
create function pg_temp.ctx() returns text
language sql as $$ select coalesce(current_setting('app.deal_stage_transition_context', true), '') $$;

-- Retrato dos campos de autonomia da IA antes de qualquer ação.
create temp table ai_before as
select id, last_ai_transition_at, ai_transition_count_24h, automation_mode, ai_transition_window_started_at,
       automation_last_evidence_hash
from public.deals where tenant_id in (select v from fx);

select set_config('request.jwt.claims', '{"role":"service_role"}', false);

-- 1-12. mark_won.
select is(pg_temp.app('e3000000-0000-4000-8000-0000000e00a1',
  pg_temp.pl('e3000000-0000-4000-8000-0000000000d1', 'e3000000-0000-4000-8000-000000000a11',
             'e3000000-0000-4000-8000-000000000a13')), 'moved', 'mark_won: moved');
select is((select status from public.deals where id = 'e3000000-0000-4000-8000-0000000000d1'), 'won',
  'mark_won: status won');
select isnt((select closed_at from public.deals where id = 'e3000000-0000-4000-8000-0000000000d1'), null,
  'mark_won: closed_at preenchido');
select is((select count(*)::int from public.deal_stage_history where deal_id = 'e3000000-0000-4000-8000-0000000000d1'),
  1, 'mark_won: 1 linha de histórico');
select is((select row(actor_type, decision, trigger_event, changed_by_automation, to_stage_id)::text
  from public.deal_stage_history where deal_id = 'e3000000-0000-4000-8000-0000000000d1'),
  row('integration', 'inbound_rule', 'inbound_rule:e3000000-0000-4000-8000-0000000e00a1', true,
      'e3000000-0000-4000-8000-000000000a13'::uuid)::text,
  'mark_won: histórico com ator integration, decision e trigger_event da regra');
select is((select evidence from public.deal_stage_history where deal_id = 'e3000000-0000-4000-8000-0000000000d1'),
  '{"rule_id":"e3000000-0000-4000-8000-0000000e00a1","inbound_event_id":"e3000000-0000-4000-8000-0000000ee001"}'::jsonb,
  'mark_won: evidence com inbound_event_id e rule_id');
select is((select count(*)::int from public.domain_events where event_type = 'deal.won'
  and aggregate_id = 'e3000000-0000-4000-8000-0000000000d1'), 1, 'mark_won: 1 deal.won');
select is((select count(*)::int from public.domain_events where event_type = 'deal.stage_changed'
  and aggregate_id = 'e3000000-0000-4000-8000-0000000000d1'), 1, 'mark_won: 1 deal.stage_changed');
select is(pg_temp.ctx(), '', 'mark_won: contexto vazio depois da função');
select throws_ok(
  $$update public.deals set stage_id = 'e3000000-0000-4000-8000-000000000a12'
    where id = 'e3000000-0000-4000-8000-0000000000d5'$$,
  '42501', null, 'mark_won: guard volta a valer na mesma transação');
select is((select lost_reason from public.deals where id = 'e3000000-0000-4000-8000-0000000000d1'), null,
  'mark_won: lost_reason null');
select is((select count(*)::int from public.deal_stage_transition_commands
  where deal_id = 'e3000000-0000-4000-8000-0000000000d1'), 0, 'mark_won: nenhum transition command');

-- 13-16. mark_lost.
select is(pg_temp.app('e3000000-0000-4000-8000-0000000e00a2',
  pg_temp.pl('e3000000-0000-4000-8000-0000000000d2', 'e3000000-0000-4000-8000-000000000a11',
             'e3000000-0000-4000-8000-000000000a14', 'Preço alto')), 'moved', 'mark_lost: moved');
select is((select row(status, lost_reason)::text from public.deals where id = 'e3000000-0000-4000-8000-0000000000d2'),
  row('lost', 'Preço alto')::text, 'mark_lost: status lost e lost_reason gravado');
select is((select reason from public.deal_stage_history where deal_id = 'e3000000-0000-4000-8000-0000000000d2'),
  'Preço alto', 'mark_lost: motivo no histórico');
select throws_ok(
  $$select pg_temp.app('e3000000-0000-4000-8000-0000000e00a2',
    pg_temp.pl('e3000000-0000-4000-8000-0000000000d5', 'e3000000-0000-4000-8000-000000000a11',
               'e3000000-0000-4000-8000-000000000a14', '  '))$$,
  '22023', 'motivo de perda obrigatorio', 'mark_lost: motivo vazio = 22023');

-- 17-20. move_stage.
select is(pg_temp.app('e3000000-0000-4000-8000-0000000e00a5',
  pg_temp.pl('e3000000-0000-4000-8000-0000000000d5', 'e3000000-0000-4000-8000-000000000a11',
             'e3000000-0000-4000-8000-000000000a16')), 'moved', 'move_stage: moved');
select is((select row(stage_id, status)::text from public.deals where id = 'e3000000-0000-4000-8000-0000000000d5'),
  row('e3000000-0000-4000-8000-000000000a16'::uuid, 'open')::text, 'move_stage: etapa nova, status open');
select is(pg_temp.ctx(), '', 'move_stage: contexto vazio');
select is((select count(*)::int from public.domain_events where event_type in ('deal.won', 'deal.lost')
  and aggregate_id = 'e3000000-0000-4000-8000-0000000000d5'), 0, 'move_stage: sem deal.won/lost');

-- 21-26. Conflito: negócio mudou de etapa entre resolve e apply.
select is(pg_temp.app('e3000000-0000-4000-8000-0000000e00a1',
  pg_temp.pl('e3000000-0000-4000-8000-0000000000d3', 'e3000000-0000-4000-8000-000000000a11',
             'e3000000-0000-4000-8000-000000000a13')), 'conflict', 'from_stage_id velho: conflict');
select is((select row(stage_id, status)::text from public.deals where id = 'e3000000-0000-4000-8000-0000000000d3'),
  row('e3000000-0000-4000-8000-000000000a12'::uuid, 'open')::text, 'conflict: negócio intacto');
select is((select count(*)::int from public.deal_stage_history where deal_id = 'e3000000-0000-4000-8000-0000000000d3'),
  0, 'conflict: nenhum histórico novo');
select is(pg_temp.ctx(), '', 'conflict: contexto vazio');
select throws_ok(
  $$update public.deals set stage_id = 'e3000000-0000-4000-8000-000000000a11'
    where id = 'e3000000-0000-4000-8000-0000000000d3'$$,
  '42501', null, 'conflict: guard volta a valer');
select is((select count(*)::int from public.domain_events
  where aggregate_id = 'e3000000-0000-4000-8000-0000000000d3'), 0, 'conflict: nenhum domain_event');

-- 27-30. Tenant B atingido por plano adulterado da regra do tenant A.
select is(pg_temp.app('e3000000-0000-4000-8000-0000000e00a1',
  pg_temp.pl('e3000000-0000-4000-8000-0000000000db', 'e3000000-0000-4000-8000-000000000b11',
             'e3000000-0000-4000-8000-000000000a13')), 'conflict', 'negócio de outro tenant: conflict');
select is((select row(stage_id, status)::text from public.deals where id = 'e3000000-0000-4000-8000-0000000000db'),
  row('e3000000-0000-4000-8000-000000000b11'::uuid, 'open')::text, 'tenant B: negócio intacto');
select is((select count(*)::int from public.deal_stage_history where tenant_id = (select v from fx where k = 'tb')),
  0, 'tenant B: nenhum histórico');
select is(pg_temp.app('e3000000-0000-4000-8000-0000000e00a3',
  pg_temp.pl('e3000000-0000-4000-8000-0000000000db', null, null, null, 'nota')), 'conflict',
  'nota em negócio de outro tenant: conflict');
select is((select count(*)::int from public.activities where tenant_id = (select v from fx where k = 'tb')),
  0, 'tenant B: nenhuma atividade');
select is(pg_temp.app('e3000000-0000-4000-8000-0000000e00a5',
  pg_temp.pl('e3000000-0000-4000-8000-0000000000d8', 'e3000000-0000-4000-8000-000000000a21',
             'e3000000-0000-4000-8000-000000000a16')), 'conflict', 'negócio de outro funil do tenant: conflict');

-- 33-36. Plano adulterado: 22023.
select throws_ok(
  $$select pg_temp.app('e3000000-0000-4000-8000-0000000e00a5',
    pg_temp.pl('e3000000-0000-4000-8000-0000000000d4', 'e3000000-0000-4000-8000-000000000a11',
               'e3000000-0000-4000-8000-000000000a12'))$$,
  '22023', 'etapa destino fora da regra', 'destino fora de allowed_stage_ids: 22023');
select throws_ok(
  $$select pg_temp.app('e3000000-0000-4000-8000-0000000e00a1',
    pg_temp.pl('e3000000-0000-4000-8000-0000000000d4', 'e3000000-0000-4000-8000-000000000a11',
               'e3000000-0000-4000-8000-000000000a14'))$$,
  '22023', 'etapa destino fora da regra', 'destino permitido mas diferente do to_stage_id da regra: 22023');
select throws_ok(
  $$select pg_temp.app('e3000000-0000-4000-8000-0000000e00a1',
    pg_temp.pl('e3000000-0000-4000-8000-0000000000d4', 'e3000000-0000-4000-8000-000000000a11',
               'e3000000-0000-4000-8000-000000000a13') || '{"outcome":"ambiguous"}')$$,
  '22023', 'plano sem acao', 'outcome diferente de act: 22023');
select is((select stage_id from public.deals where id = 'e3000000-0000-4000-8000-0000000000d4'),
  'e3000000-0000-4000-8000-000000000a11'::uuid, 'plano adulterado: negócio intacto');

-- 37-40. Etapa destino apagada / com tipo trocado depois do resolve: conflict.
delete from public.board_stages where id = 'e3000000-0000-4000-8000-000000000a15';
select is(pg_temp.app('e3000000-0000-4000-8000-0000000e00a6',
  pg_temp.pl('e3000000-0000-4000-8000-0000000000d6', 'e3000000-0000-4000-8000-000000000a11',
             'e3000000-0000-4000-8000-000000000a15')), 'conflict', 'etapa destino apagada: conflict');
select is((select stage_id from public.deals where id = 'e3000000-0000-4000-8000-0000000000d6'),
  'e3000000-0000-4000-8000-000000000a11'::uuid, 'etapa apagada: negócio intacto');
update public.board_stages set is_won = false where id = 'e3000000-0000-4000-8000-000000000a13';
select is(pg_temp.app('e3000000-0000-4000-8000-0000000e00a1',
  pg_temp.pl('e3000000-0000-4000-8000-0000000000d7', 'e3000000-0000-4000-8000-000000000a11',
             'e3000000-0000-4000-8000-000000000a13')), 'conflict', 'destino deixou de ser is_won: conflict');
update public.board_stages set is_won = true where id = 'e3000000-0000-4000-8000-000000000a13';
select is(pg_temp.ctx(), '', 'conflict de etapa: contexto vazio');

-- 41-46. add_note e create_activity.
select is(pg_temp.app('e3000000-0000-4000-8000-0000000e00a3',
  pg_temp.pl('e3000000-0000-4000-8000-0000000000d4', null, null, null, 'Pago 129.90 por Ana')), 'note_added',
  'add_note: note_added');
-- v2.1 (20261022100000): a nota nasce concluída (due_at = completed_at = agora).
select is((select row(type, deal_id, contact_id, title, due_at, completed_at)::text from public.activities
  where deal_id = 'e3000000-0000-4000-8000-0000000000d4' and type = 'note'),
  row('note', 'e3000000-0000-4000-8000-0000000000d4'::uuid, 'e3000000-0000-4000-8000-0000000000c1'::uuid,
      'Pago 129.90 por Ana', now(), now())::text,
  'add_note: nota com deal_id e contact_id do negócio, já concluída');
select is((select tenant_id from public.activities where deal_id = 'e3000000-0000-4000-8000-0000000000d4' and type = 'note'),
  (select v from fx where k = 'ta'), 'add_note: tenant da regra');
select is(pg_temp.app('e3000000-0000-4000-8000-0000000e00a4',
  pg_temp.pl('e3000000-0000-4000-8000-0000000000d4', null, null, null, repeat('t', 600))), 'activity_created',
  'create_activity: activity_created');
select is((select row(type, char_length(title), due_at)::text from public.activities
  where deal_id = 'e3000000-0000-4000-8000-0000000000d4' and type = 'task'),
  row('task', 500, now() + interval '48 hours')::text,
  'create_activity: tarefa, título cortado em 500, due_at = agora + due_in_hours');
select throws_ok(
  $$select pg_temp.app('e3000000-0000-4000-8000-0000000e00a3',
    pg_temp.pl('e3000000-0000-4000-8000-0000000000d4', null, null, null, '  '))$$,
  '22023', 'texto da nota/atividade vazio', 'add_note: texto vazio = 22023');

-- 47. Nenhum campo de autonomia da IA mudou em negócio algum.
select is((select count(*)::int from public.deals d join ai_before b using (id)
  where (d.last_ai_transition_at, d.ai_transition_count_24h, d.automation_mode,
         d.ai_transition_window_started_at, d.automation_last_evidence_hash)
     is distinct from (b.last_ai_transition_at, b.ai_transition_count_24h, b.automation_mode,
         b.ai_transition_window_started_at, b.automation_last_evidence_hash)), 0,
  'campos de autonomia da IA iguais antes e depois');
select is((select count(*)::int from public.deal_stage_transition_commands
  where tenant_id in (select v from fx)), 0, 'nenhuma linha em deal_stage_transition_commands');

-- 49-51. Guarda e grants.
select set_config('request.jwt.claims',
  '{"sub":"e3000000-0000-4000-8000-00000000000a","role":"authenticated"}', false);
select throws_ok(
  $$select pg_temp.app('e3000000-0000-4000-8000-0000000e00a3',
    pg_temp.pl('e3000000-0000-4000-8000-0000000000d4', null, null, null, 'x'))$$,
  '42501', 'service_role required', 'guarda interna: authenticated mesmo com EXECUTE = 42501');
set local role authenticated;
select throws_ok(
  $$select private.inbound_apply_action(null::public.inbound_rules, '{}'::jsonb, null::uuid)$$,
  '42501', null, 'authenticated sem EXECUTE: 42501');
reset role;
select ok(
  not has_function_privilege('anon', 'private.inbound_apply_action(public.inbound_rules,jsonb,uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.inbound_apply_action(public.inbound_rules,jsonb,uuid)', 'EXECUTE')
  and has_function_privilege('service_role', 'private.inbound_apply_action(public.inbound_rules,jsonb,uuid)', 'EXECUTE')
  and (select count(*) from pg_proc p, unnest(p.proconfig) c
       where p.oid = 'private.inbound_apply_action(public.inbound_rules,jsonb,uuid)'::regprocedure
         and c not like 'search_path=%') = 0,
  'grants: só service_role executa; nenhum SET além de search_path');

select * from finish();
rollback;
