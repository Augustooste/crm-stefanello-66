-- v2 Task 11: retenção de 90 dias de inbound_events (public.prune_inbound_events e
-- private.run_inbound_retention, que também limpa rate_limits), job diário no catálogo
-- e public.inbound_rule_stats (últimas 24 h, developer.manage).
-- Rodar: pnpm test:db.
begin;
create extension if not exists pgtap;

select plan(48);

-- Fixture: admin A e admin B (tenants próprios via handle_new_user) e agente C (convite no tenant A).
insert into auth.users (id, email) values
  ('e1100000-0000-4000-8000-00000000000a', 'retention-adm-a@test.local'),
  ('e1100000-0000-4000-8000-00000000000b', 'retention-adm-b@test.local');
insert into public.invites (tenant_id, email, role, token, expires_at)
select tenant_id, 'retention-agente-c@test.local', 'agent', 'retention-agent-token', now() + interval '1 day'
from public.profiles where id = 'e1100000-0000-4000-8000-00000000000a';
insert into auth.users (id, email, raw_user_meta_data) values
  ('e1100000-0000-4000-8000-00000000000c', 'retention-agente-c@test.local',
   '{"invite_token":"retention-agent-token"}');

create temp table fx(k text primary key, v uuid);
insert into fx select 'ta', tenant_id from public.profiles where id = 'e1100000-0000-4000-8000-00000000000a';
insert into fx select 'tb', tenant_id from public.profiles where id = 'e1100000-0000-4000-8000-00000000000b';
grant select on fx to public;

insert into public.boards (id, tenant_id, name) values
  ('e1100000-0000-4000-8000-0000000000a1', (select v from fx where k = 'ta'), 'Funil A'),
  ('e1100000-0000-4000-8000-0000000000b1', (select v from fx where k = 'tb'), 'Funil B');
insert into public.board_stages (id, board_id, name, position, is_won, is_lost) values
  ('e1100000-0000-4000-8000-000000000a11', 'e1100000-0000-4000-8000-0000000000a1', 'Novo', 0, false, false),
  ('e1100000-0000-4000-8000-000000000b11', 'e1100000-0000-4000-8000-0000000000b1', 'Novo', 0, false, false);

-- Regras como dono do banco (validação de criação coberta pela Task 1).
insert into public.inbound_rules (id, tenant_id, name, verification_mode, board_id, allowed_stage_ids,
  action, action_config, match_field, match_path, event_id_path) values
  ('e1100000-0000-4000-8000-0000000e00a1', (select v from fx where k = 'ta'), 'Regra A', 'aceleraflow_hmac',
   'e1100000-0000-4000-8000-0000000000a1', array['e1100000-0000-4000-8000-000000000a11']::uuid[],
   'add_note', '{"text":"pago"}', 'email', 'email', 'id'),
  ('e1100000-0000-4000-8000-0000000e00b1', (select v from fx where k = 'tb'), 'Regra B', 'aceleraflow_hmac',
   'e1100000-0000-4000-8000-0000000000b1', array['e1100000-0000-4000-8000-000000000b11']::uuid[],
   'add_note', '{"text":"pago"}', 'email', 'email', 'id');

-- Eventos com received_at explícito (now() é fixo dentro da transação do teste).
-- Antigos (100 dias): 5 processados + 1 'processing' travado. Recentes: 1 h e 30 dias atrás.
insert into public.inbound_events (tenant_id, rule_id, external_event_id, status, received_at)
select (select v from fx where k = 'ta'), 'e1100000-0000-4000-8000-0000000e00a1', 'old-' || g, 'processed',
       now() - interval '100 days' - make_interval(mins => g)
  from generate_series(1, 5) g;
insert into public.inbound_events (tenant_id, rule_id, external_event_id, status, received_at) values
  ((select v from fx where k = 'ta'), 'e1100000-0000-4000-8000-0000000e00a1', 'old-processing', 'processing',
   now() - interval '100 days'),
  ((select v from fx where k = 'ta'), 'e1100000-0000-4000-8000-0000000e00a1', 'recent-30d', 'processed',
   now() - interval '30 days'),
  ((select v from fx where k = 'ta'), 'e1100000-0000-4000-8000-0000000e00a1', 'recent-processing', 'processing',
   now() - interval '1 minute');

-- ---------------------------------------------------------------------------
-- Estrutura e privilégios
-- ---------------------------------------------------------------------------

-- 1-4
select has_function('public', 'prune_inbound_events', array['timestamp with time zone', 'integer'],
  'poda de eventos existe');
select has_function('private', 'run_inbound_retention', array['integer', 'interval'], 'rotina de retenção existe');
select has_function('public', 'inbound_rule_stats', array['uuid'], 'estatística da regra existe');
select has_index('public', 'inbound_events', 'inbound_events_received_at_idx', array['received_at'],
  'índice por received_at atende a poda sem tenant');

-- 5-10: grants explícitos (remix não herda REVOKE).
select ok(not has_function_privilege('anon', 'public.prune_inbound_events(timestamptz, integer)', 'execute'),
  'anon não executa a poda');
select ok(not has_function_privilege('authenticated', 'public.prune_inbound_events(timestamptz, integer)', 'execute'),
  'authenticated não executa a poda');
select ok(not has_function_privilege('anon', 'private.run_inbound_retention(integer, interval)', 'execute')
          and not has_function_privilege('authenticated', 'private.run_inbound_retention(integer, interval)', 'execute'),
  'anon e authenticated não executam a rotina de retenção');
select ok(has_function_privilege('service_role', 'public.prune_inbound_events(timestamptz, integer)', 'execute')
          and has_function_privilege('service_role', 'private.run_inbound_retention(integer, interval)', 'execute'),
  'service_role executa poda e rotina');
select ok(not has_function_privilege('anon', 'public.inbound_rule_stats(uuid)', 'execute'),
  'anon não executa a estatística');
select ok(has_function_privilege('authenticated', 'public.inbound_rule_stats(uuid)', 'execute'),
  'authenticated executa a estatística (guarda por developer.manage dentro)');

-- 11: nenhuma função nova com SET além de search_path (GUC no cabeçalho aborta o remix).
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    cross join lateral unnest(coalesce(p.proconfig, '{}')) c
   where (n.nspname, p.proname) in (('public', 'prune_inbound_events'), ('private', 'run_inbound_retention'),
                                    ('public', 'inbound_rule_stats'), ('private', 'ensure_inbound_retention_cron'),
                                    ('private', 'inbound_retention_caller_ok'))
     and c not like 'search_path=%'),
  0, 'funções novas só fixam search_path');

-- ---------------------------------------------------------------------------
-- Guarda dentro da função (independente do grant)
-- ---------------------------------------------------------------------------

-- 12-14. Como dono do banco, com claims de authenticated/anon: a guarda recusa.
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok($$ select public.prune_inbound_events(now(), 10) $$, '42501', null,
  'poda recusa authenticated mesmo com EXECUTE (guarda interna)');
select throws_ok($$ select private.run_inbound_retention() $$, '42501', null,
  'rotina recusa authenticated mesmo com EXECUTE (guarda interna)');
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok($$ select public.prune_inbound_events(now(), 10) $$, '42501', null,
  'poda recusa anon (guarda interna)');
select set_config('request.jwt.claims', '', true);

-- 15a-15d. Regra da guarda, com papel e session_user explícitos (o postgres do Supabase
-- não pode trocar session_user; o caminho real pela conexão authenticator foi provado
-- fora do pgTAP, ver task-11-report.md).
select is(private.inbound_retention_caller_ok(null, 'authenticator'), false,
  'claims sem role vindas da API (session_user authenticator) são recusadas');
select is(private.inbound_retention_caller_ok(null, 'postgres'), true,
  'conexão direta sem claims (pg_cron como postgres) passa');
select is(private.inbound_retention_caller_ok('service_role', 'authenticator'), true,
  'service_role pela API passa');
select is(private.inbound_retention_caller_ok('anon', 'postgres'), false,
  'papel diferente de service_role é recusado mesmo em conexão direta');

-- 15. Pelo grant: authenticated de verdade não chega a rodar.
set local role authenticated;
select throws_ok($$ select public.prune_inbound_events(now(), 10) $$, '42501', null,
  'authenticated sem EXECUTE não poda');
reset role;

-- 16-17. Parâmetros inválidos.
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok($$ select public.prune_inbound_events(null, 10) $$, '22023', null, 'p_before nulo é recusado');
select throws_ok($$ select public.prune_inbound_events(now(), 0) $$, '22023', null, 'p_limit menor que 1 é recusado');

-- ---------------------------------------------------------------------------
-- Poda
-- ---------------------------------------------------------------------------

-- 18-20. Respeita p_limit e apaga os mais antigos primeiro.
select is(public.prune_inbound_events(now() - interval '90 days', 2), 2, 'poda devolve o número apagado (limite 2)');
select is((select count(*)::int from public.inbound_events where external_event_id like 'old-%'), 4,
  'limite 2 apagou só 2 dos 6 antigos');
select ok(not exists (select 1 from public.inbound_events where external_event_id in ('old-5', 'old-4')),
  'apaga primeiro os mais antigos (ordem por received_at)');

-- 21-23. Segunda passada leva o resto dos antigos, inclusive 'processing' de 100 dias (travado).
select is(public.prune_inbound_events(now() - interval '90 days', 100), 4, 'segunda passada apaga os 4 antigos restantes');
select is((select count(*)::int from public.inbound_events where external_event_id like 'old-%'), 0,
  'nenhum evento com mais de 90 dias sobra');
select is((select count(*)::int from public.inbound_events where external_event_id like 'recent-%'), 2,
  'eventos recentes ficam');

-- 24. Nada mais a apagar: devolve 0.
select is(public.prune_inbound_events(now() - interval '90 days', 100), 0, 'sem candidatos devolve 0');

-- 25-26. Corte no futuro: apaga o recente processado, nunca o 'processing' recente (em voo).
select is(public.prune_inbound_events(now() + interval '1 day', 100), 1,
  'corte no futuro apaga só o que não está em processamento');
select ok(exists (select 1 from public.inbound_events where external_event_id = 'recent-processing'),
  'processing recente nunca é apagado');

-- ---------------------------------------------------------------------------
-- Rotina diária: poda 90 dias em lotes + rate_limit_cleanup
-- ---------------------------------------------------------------------------

insert into public.inbound_events (tenant_id, rule_id, external_event_id, status, received_at)
select (select v from fx where k = 'ta'), 'e1100000-0000-4000-8000-0000000e00a1', 'job-old-' || g, 'failed',
       now() - interval '91 days'
  from generate_series(1, 3) g;
insert into public.inbound_events (tenant_id, rule_id, external_event_id, status, received_at) values
  ((select v from fx where k = 'ta'), 'e1100000-0000-4000-8000-0000000e00a1', 'job-89d', 'processed',
   now() - interval '89 days');
insert into public.rate_limits (identifier, endpoint, created_at) values
  ('t11:velho', 'inbound', now() - interval '2 hours'),
  ('t11:novo', 'inbound', now() - interval '5 minutes');

-- Orçamento de tempo: lote de 1 com orçamento zero para depois do primeiro lote e
-- devolve o já apagado; parâmetros fora da faixa são recusados.
select is(private.run_inbound_retention(1, interval '0 seconds') - 'rate_limits_deleted',
  '{"inbound_events_deleted": 1, "batches": 1}'::jsonb,
  'orçamento de tempo estourado para o laço e devolve o já apagado');
select throws_ok($$ select private.run_inbound_retention(1, interval '1 hour') $$, '22023', null,
  'orçamento acima do teto é recusado');
-- 27-31 (a chamada padrão leva os 2 antigos que sobraram)
select is((private.run_inbound_retention() ->> 'inbound_events_deleted')::int, 2,
  'rotina apaga os eventos com mais de 90 dias');
select ok(exists (select 1 from public.inbound_events where external_event_id = 'job-89d'),
  'rotina guarda evento de 89 dias');
select ok(not exists (select 1 from public.rate_limits where identifier = 't11:velho'),
  'rotina chama rate_limit_cleanup: linha com mais de 1 h some');
select ok(exists (select 1 from public.rate_limits where identifier = 't11:novo'),
  'linha recente de rate_limits fica');
-- Chamada pelo pg_cron: conexão direta como postgres, sem claims.
reset role;
select set_config('request.jwt.claims', '', true);
select lives_ok($$ select private.run_inbound_retention() $$, 'rotina roda sem claims (contexto do pg_cron)');

-- ---------------------------------------------------------------------------
-- Catálogo e cron
-- ---------------------------------------------------------------------------

-- 32-36
select is(
  (select schedule from private.scheduled_job_catalog() where jobname = 'inbound-events-retention'),
  '41 6 * * *', 'retenção roda uma vez por dia, 06:41 UTC (madrugada no Brasil)');
select is(
  (select sql_command from private.scheduled_job_catalog() where jobname = 'inbound-events-retention'),
  'select private.run_inbound_retention();', 'catálogo chama a rotina SQL, sem HTTP');
select is(
  (select default_active from private.scheduled_job_catalog() where jobname = 'inbound-events-retention'),
  true, 'retenção nasce ligada no catálogo');
select is(
  (select count(*)::int from private.scheduled_job_catalog() c
    where c.jobname <> 'inbound-events-retention'
      and split_part(c.schedule, ' ', 1) ~ '(^|,)41(,|$)'),
  0, 'minuto 41 não é usado por outro job do catálogo');
select is(
  (select command from cron.job where jobname = 'inbound-events-retention'),
  (select sql_command from private.scheduled_job_catalog() where jobname = 'inbound-events-retention'),
  'cron.job tem o comando do catálogo (sync não reagenda)');

-- 37-38. Reaplicar não duplica nem reativa job pausado.
select cron.alter_job(jobid, active := false) from cron.job where jobname = 'inbound-events-retention';
select private.ensure_inbound_retention_cron();
select private.ensure_inbound_retention_cron();
select is((select count(*)::int from cron.job where jobname = 'inbound-events-retention'), 1,
  'reaplicar não duplica o job');
select is((select active from cron.job where jobname = 'inbound-events-retention'), false,
  'reaplicar não reativa job pausado');
select cron.alter_job(jobid, schedule := '0 5 * * *') from cron.job where jobname = 'inbound-events-retention';
select private.ensure_inbound_retention_cron();
select is((select schedule from cron.job where jobname = 'inbound-events-retention'), '0 5 * * *',
  'reaplicar não sobrescreve schedule do operador');

-- ---------------------------------------------------------------------------
-- Estatística da regra (últimas 24 h, só do tenant, developer.manage)
-- ---------------------------------------------------------------------------

insert into public.inbound_events (tenant_id, rule_id, external_event_id, status, received_at) values
  ((select v from fx where k = 'ta'), 'e1100000-0000-4000-8000-0000000e00a1', 's-1', 'processed', now() - interval '1 hour'),
  ((select v from fx where k = 'ta'), 'e1100000-0000-4000-8000-0000000e00a1', 's-2', 'processed', now() - interval '23 hours'),
  ((select v from fx where k = 'ta'), 'e1100000-0000-4000-8000-0000000e00a1', 's-3', 'failed', now() - interval '2 hours'),
  ((select v from fx where k = 'ta'), 'e1100000-0000-4000-8000-0000000e00a1', 's-old', 'processed', now() - interval '25 hours'),
  ((select v from fx where k = 'tb'), 'e1100000-0000-4000-8000-0000000e00b1', 's-b', 'processed', now() - interval '1 hour');

select set_config('request.jwt.claims', '{"sub":"e1100000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
set local role authenticated;
-- 39. Só 24 h e só a regra (recent-processing de 1 min conta como processing).
select results_eq(
  $$ select status, total from public.inbound_rule_stats('e1100000-0000-4000-8000-0000000e00a1') order by status $$,
  $$ values ('failed'::text, 1), ('processed'::text, 2), ('processing'::text, 1) $$,
  'stats contam só as últimas 24 h da regra, por status');
-- 40. Regra de outro tenant.
select throws_ok($$ select * from public.inbound_rule_stats('e1100000-0000-4000-8000-0000000e00b1') $$,
  'P0002', null, 'regra de outro tenant: não encontrada');
-- 41. Sem developer.manage.
select set_config('request.jwt.claims', '{"sub":"e1100000-0000-4000-8000-00000000000c","role":"authenticated"}', true);
select throws_ok($$ select * from public.inbound_rule_stats('e1100000-0000-4000-8000-0000000e00a1') $$,
  '42501', null, 'agente sem developer.manage não vê estatística');
reset role;

select * from finish();
rollback;
