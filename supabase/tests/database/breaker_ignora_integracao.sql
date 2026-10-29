-- Task 3b (achado I1): o circuit breaker da IA ignora movimentos de regra de
-- entrada (actor_type = 'integration') e as reversões que apontam para eles.
-- Limiar real: boards.automation_reversal_threshold (default 0.250, compara com
-- ">") e mínimo de 5 movimentos automáticos (transition_deal_stage).
begin;
create extension if not exists pgtap;
select plan(13);

insert into auth.users (id, email)
values ('a3b00000-0000-0000-0000-000000000001', 'breaker-integracao@test.local');

insert into public.boards (id, tenant_id, name, is_default)
select 'b3b00000-0000-0000-0000-000000000001', tenant_id, 'Breaker', true
from public.profiles where id = 'a3b00000-0000-0000-0000-000000000001';

insert into public.board_stages (id, board_id, name, position)
values
  ('c3b00000-0000-0000-0000-000000000001', 'b3b00000-0000-0000-0000-000000000001', 'Novo', 0),
  ('c3b00000-0000-0000-0000-000000000002', 'b3b00000-0000-0000-0000-000000000001', 'Qualificado', 1);

-- d...01 recebe o histórico semeado; d...02 é a sonda que chama o comando.
insert into public.deals (id, tenant_id, board_id, stage_id, title, status)
select v.id, p.tenant_id, 'b3b00000-0000-0000-0000-000000000001',
       'c3b00000-0000-0000-0000-000000000001', v.title, 'open'
from public.profiles p
cross join (values
  ('d3b00000-0000-0000-0000-000000000001'::uuid, 'Histórico'),
  ('d3b00000-0000-0000-0000-000000000002'::uuid, 'Sonda')
) as v(id, title)
where p.id = 'a3b00000-0000-0000-0000-000000000001';

-- Semeia n linhas de histórico do ator dado, com created_at decrescente a
-- partir de now() - p_offset. Devolve os ids em ordem do mais novo.
create function pg_temp.seed(p_actor text, p_n integer, p_offset interval)
returns setof uuid language sql as $$
  insert into public.deal_stage_history (
    deal_id, tenant_id, from_stage_id, to_stage_id,
    changed_by_automation, actor_type, created_at
  )
  select 'd3b00000-0000-0000-0000-000000000001', d.tenant_id,
         'c3b00000-0000-0000-0000-000000000001',
         'c3b00000-0000-0000-0000-000000000002',
         p_actor <> 'human', p_actor,
         now() - p_offset - make_interval(secs => g)
  from public.deals d, generate_series(1, p_n) g
  where d.id = 'd3b00000-0000-0000-0000-000000000001'
  returning id
$$;

-- Humano reverte as linhas dadas (reversão = actor human, não automação).
create function pg_temp.revert(p_ids uuid[], p_offset interval)
returns void language sql as $$
  insert into public.deal_stage_history (
    deal_id, tenant_id, from_stage_id, to_stage_id,
    changed_by_automation, actor_type, reversal_of_history_id, created_at
  )
  select 'd3b00000-0000-0000-0000-000000000001', d.tenant_id,
         'c3b00000-0000-0000-0000-000000000002',
         'c3b00000-0000-0000-0000-000000000001',
         false, 'human', r.id, now() - p_offset
  from public.deals d, unnest(p_ids) r(id)
  where d.id = 'd3b00000-0000-0000-0000-000000000001'
$$;

-- Chama o comando como IA na sonda e devolve o reason (null = não bloqueou).
-- Rearma a sonda antes, porque o breaker a pausa quando dispara.
create function pg_temp.probe(p_key text)
returns text language plpgsql as $$
declare v_result jsonb;
begin
  update public.deals
  set automation_mode = 'inherit', automation_lock_reason = null
  where id = 'd3b00000-0000-0000-0000-000000000002';
  perform set_config('request.jwt.claims',
    json_build_object('role', 'service_role')::text, true);
  set local role service_role;
  v_result := public.transition_deal_stage(
    'd3b00000-0000-0000-0000-000000000002',
    'c3b00000-0000-0000-0000-000000000001',
    'c3b00000-0000-0000-0000-000000000002',
    'ai', null, 'Sonda do breaker',
    jsonb_build_object('signals', '{}'::jsonb, 'probe', p_key),
    0.95, p_key
  );
  reset role;
  return coalesce(v_result ->> 'reason', v_result ->> 'status');
end $$;

create function pg_temp.reset_history()
returns void language sql as $$
  delete from public.deal_stage_history
  where deal_id = 'd3b00000-0000-0000-0000-000000000001'
$$;

select is(
  (select automation_reversal_threshold from public.boards
   where id = 'b3b00000-0000-0000-0000-000000000001'),
  0.250::numeric(4,3),
  'fixture usa o limiar default de 25%'
);

-- (1) 10 movimentos da IA, 4 revertidos por humano = 40% > 25%.
create temp table ai_ids as
  select s.id from pg_temp.seed('ai', 10, interval '2 hours') as s(id);
select pg_temp.revert(
  (select array_agg(id) from (select id from ai_ids limit 4) s),
  interval '1 hour'
);

select is(pg_temp.probe('s1-base'), 'reversal_circuit_breaker',
  '10 movimentos da IA com 4 revertidos disparam o breaker');

-- 50 movimentos de regra de entrada mais novos: antes do fix o denominador
-- virava 60 (4/60 = 6,7%) e o breaker ficava quieto.
select pg_temp.seed('integration', 50, interval '1 minute');
select is(pg_temp.probe('s1-50'), 'reversal_circuit_breaker',
  '50 linhas integration não diluem a taxa');

-- +150 (200 integration mais novas): antes do fix a janela de 200 ficava só
-- com integration e a IA saía da conta.
select pg_temp.seed('integration', 150, interval '30 seconds');
select is(pg_temp.probe('s1-200'), 'reversal_circuit_breaker',
  '200 linhas integration não lotam a janela do breaker');

-- (2) 10 movimentos da IA, 2 revertidos = 20% (não dispara). Humano reverte
-- um movimento integration: antes do fix 3/11 = 27% pausava a IA.
select pg_temp.reset_history();
truncate ai_ids;
insert into ai_ids select s.id from pg_temp.seed('ai', 10, interval '2 hours') as s(id);
select pg_temp.revert(
  (select array_agg(id) from (select id from ai_ids limit 2) s),
  interval '1 hour'
);
select is(pg_temp.probe('s2-base'), 'autonomy_not_enabled',
  '20% de reversão fica abaixo do limiar');

select pg_temp.revert(
  array(select pg_temp.seed('integration', 1, interval '50 minutes')),
  interval '40 minutes'
);
select is(pg_temp.probe('s2-int-undo'), 'autonomy_not_enabled',
  'desfazer movimento integration não soma no numerador do breaker');

-- (3) Reversão de movimento da IA continua contando: 3/10 = 30%.
select pg_temp.revert(
  (select array_agg(id) from (select id from ai_ids offset 2 limit 1) s),
  interval '30 minutes'
);
select is(pg_temp.probe('s3-ai-undo'), 'reversal_circuit_breaker',
  'reversão de movimento da IA continua contando');

-- (4) Demais atores automáticos seguem contando como antes.
select pg_temp.reset_history();
create temp table wf_ids as
  select s.id from pg_temp.seed('workflow', 10, interval '2 hours') as s(id);
select pg_temp.revert(
  (select array_agg(id) from (select id from wf_ids limit 4) s),
  interval '1 hour'
);
select is(pg_temp.probe('s4-workflow'), 'reversal_circuit_breaker',
  'movimentos workflow revertidos seguem disparando o breaker');

select pg_temp.reset_history();
create temp table sys_ids as
  select s.id from pg_temp.seed('system', 10, interval '2 hours') as s(id);
select pg_temp.revert(
  (select array_agg(id) from (select id from sys_ids limit 4) s),
  interval '1 hour'
);
select is(pg_temp.probe('s4-system'), 'reversal_circuit_breaker',
  'movimentos system revertidos seguem disparando o breaker');

-- Linhas legadas sem actor_type (null) continuam na conta.
select pg_temp.reset_history();
create temp table legacy_ids as
  select s.id from pg_temp.seed('ai', 10, interval '2 hours') as s(id);
update public.deal_stage_history set actor_type = null
where id in (select id from legacy_ids);
select pg_temp.revert(
  (select array_agg(id) from (select id from legacy_ids limit 4) s),
  interval '1 hour'
);
select is(pg_temp.probe('s4-legacy'), 'reversal_circuit_breaker',
  'histórico legado sem actor_type segue contando');

-- Remix não herda REVOKE: a migration reaplica os grants explicitamente.
select is(
  has_function_privilege('anon', 'public.transition_deal_stage(uuid,uuid,uuid,text,uuid,text,jsonb,numeric,text,text,jsonb,jsonb,text,uuid,uuid)', 'execute'),
  false, 'anon não executa transition_deal_stage');
select is(
  has_function_privilege('authenticated', 'public.transition_deal_stage(uuid,uuid,uuid,text,uuid,text,jsonb,numeric,text,text,jsonb,jsonb,text,uuid,uuid)', 'execute'),
  true, 'authenticated executa transition_deal_stage');
select is(
  has_function_privilege('service_role', 'public.transition_deal_stage(uuid,uuid,uuid,text,uuid,text,jsonb,numeric,text,text,jsonb,jsonb,text,uuid,uuid)', 'execute'),
  true, 'service_role executa transition_deal_stage');

select * from finish();
rollback;
