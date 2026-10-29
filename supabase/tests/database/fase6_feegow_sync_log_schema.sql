-- Fase 6 (Sub-feature 2) — feegow_sync_log: schema + RLS + catálogo. Roda
-- contra o shadow DB local (supabase test db --local; pnpm test:db), que
-- reaplica todas as migrations do zero -- não toca a DB real do Lovable.
begin;
create extension if not exists pgtap;

select plan(22);

-- =============================================================================
-- 1. Tabela + colunas + índice + RLS habilitada (nunca FORCE)
-- =============================================================================
select has_table('public', 'feegow_sync_log', 'tabela feegow_sync_log existe');
select has_column('public', 'feegow_sync_log', 'tenant_id', 'feegow_sync_log.tenant_id existe');
select has_column('public', 'feegow_sync_log', 'run_at', 'feegow_sync_log.run_at existe');
select has_column('public', 'feegow_sync_log', 'status', 'feegow_sync_log.status existe');
select has_column('public', 'feegow_sync_log', 'synced_count', 'feegow_sync_log.synced_count existe');
select has_column('public', 'feegow_sync_log', 'error_detail', 'feegow_sync_log.error_detail existe');

select has_index(
  'public', 'feegow_sync_log', 'feegow_sync_log_tenant_idx',
  'índice (tenant_id, run_at desc) existe'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.feegow_sync_log'::regclass),
  'RLS habilitada em feegow_sync_log'
);
select ok(
  not (select relforcerowsecurity from pg_class where oid = 'public.feegow_sync_log'::regclass),
  'RLS NÃO forçada em feegow_sync_log (convenção real do projeto)'
);

-- =============================================================================
-- 2. Check constraint: status só aceita success/partial/error
-- =============================================================================
insert into auth.users (id, email) values
  ('77777777-7777-7777-7777-777777777777', 'admin-a-feegow@test.local'),
  ('88888888-8888-8888-8888-888888888888', 'admin-b-feegow@test.local');

select throws_ok(
  $$insert into public.feegow_sync_log (tenant_id, status)
    select tenant_id, 'status_invalido'
    from public.profiles where id = '77777777-7777-7777-7777-777777777777'$$,
  '23514',
  NULL,
  'status fora de (success, partial, error) é rejeitado pelo check constraint'
);

-- =============================================================================
-- 3. Catálogo `integrations`: entrada feegow com required_secrets corretos
-- =============================================================================
select is(
  (select count(*)::int from public.integrations where slug = 'feegow'),
  1,
  'catálogo tem exatamente 1 entrada feegow'
);
select is(
  (select category from public.integrations where slug = 'feegow'),
  'saude',
  'feegow está na categoria saude (catálogo recategorizado em 20260811001846)'
);
select is(
  (select available from public.integrations where slug = 'feegow'),
  true,
  'feegow está available=true no catálogo'
);
select is(
  (select array(select jsonb_array_elements(required_secrets) ->> 'key')
    from public.integrations where slug = 'feegow'),
  array['clinic_id', 'access_token'],
  'feegow pede clinic_id + access_token (nessa ordem) em required_secrets'
);

-- =============================================================================
-- 4. RPC feegow_upsert_appointments: existe + upsert idempotente DE VERDADE
-- contra o índice parcial appointments_external_dedupe (tenant_id,
-- external_source, external_ref) where external_ref is not null --
-- comportamento verificado empiricamente nesta sessão (psql direto,
-- transação isolada): um ON CONFLICT com lista de colunas nua NÃO combina
-- com um índice parcial (42P10) a menos que o predicado WHERE seja repetido
-- no próprio ON CONFLICT -- o que o parâmetro on_conflict do PostgREST não
-- consegue expressar. Por isso a RPC (SQL puro), não .upsert() direto via
-- REST. Rodar esta chamada 2x com o MESMO external_ref é o teste real de
-- idempotência -- se a RPC estivesse quebrada (sem o predicado), a 2a
-- chamada já lançaria 42P10 e todo o script abortaria aqui.
-- =============================================================================
select has_function(
  'public', 'feegow_upsert_appointments', array['jsonb'],
  'RPC feegow_upsert_appointments(jsonb) existe'
);

select public.feegow_upsert_appointments(
  jsonb_build_array(jsonb_build_object(
    'tenant_id', (select tenant_id from public.profiles where id = '77777777-7777-7777-7777-777777777777'),
    'external_source', 'feegow',
    'external_ref', 'feegow-appt-1',
    'title', 'Consulta',
    'date', '2026-07-15',
    'time_start', '14:30:00',
    'time_end', null,
    'modality', 'presencial',
    'status', 'scheduled',
    'notes', null
  ))
);

select is(
  (select count(*)::int from public.appointments where external_source = 'feegow' and external_ref = 'feegow-appt-1'),
  1,
  '1a chamada da RPC cria 1 linha em appointments (external_ref=feegow-appt-1)'
);
select is(
  (select status from public.appointments where external_source = 'feegow' and external_ref = 'feegow-appt-1'),
  'scheduled',
  '1a chamada grava status=scheduled'
);

-- 2a chamada, MESMO external_ref, status diferente -- deve fazer UPDATE
-- (via ON CONFLICT ... DO UPDATE), não criar linha nova nem lançar 42P10.
select public.feegow_upsert_appointments(
  jsonb_build_array(jsonb_build_object(
    'tenant_id', (select tenant_id from public.profiles where id = '77777777-7777-7777-7777-777777777777'),
    'external_source', 'feegow',
    'external_ref', 'feegow-appt-1',
    'title', 'Consulta',
    'date', '2026-07-15',
    'time_start', '14:30:00',
    'time_end', null,
    'modality', 'presencial',
    'status', 'confirmed',
    'notes', null
  ))
);

select is(
  (select count(*)::int from public.appointments where external_source = 'feegow' and external_ref = 'feegow-appt-1'),
  1,
  '2a chamada com o MESMO external_ref não duplica -- continua 1 linha (idempotência real, não só mock)'
);
select is(
  (select status from public.appointments where external_source = 'feegow' and external_ref = 'feegow-appt-1'),
  'confirmed',
  '2a chamada atualiza status para confirmed (DO UPDATE executou de verdade)'
);

-- =============================================================================
-- 5. RLS comportamental: GRANT explícito funciona (não "permission denied")
-- e isolamento por tenant -- mesma verificação empírica de
-- 20260712130000_fase6_agenda_appointments.sql (o bug real que motivou o
-- GRANT explícito nesta migration só aparece rodando a query DE VERDADE sob
-- `set local role authenticated`, não inspecionando metadados de pg_policies).
insert into public.feegow_sync_log (tenant_id, status, synced_count)
select tenant_id, 'success', 5
from public.profiles where id = '77777777-7777-7777-7777-777777777777';

insert into public.feegow_sync_log (tenant_id, status, synced_count, error_detail)
select tenant_id, 'error', 0, 'timeout ao chamar a Feegow'
from public.profiles where id = '88888888-8888-8888-8888-888888888888';

select set_config(
  'request.jwt.claims',
  json_build_object('sub', '77777777-7777-7777-7777-777777777777', 'role', 'authenticated')::text,
  false
);
set local role authenticated;

-- Se o GRANT explícito estivesse faltando, esta query lançaria "permission
-- denied for table feegow_sync_log" (erro não capturado, teste inteiro
-- aborta) -- ela só chega a avaliar o resultado porque o GRANT funciona.
select is(
  (select count(*)::int from public.feegow_sync_log),
  1,
  'admin A vê só 1 feegow_sync_log (o próprio, não o do tenant B) -- prova GRANT + RLS juntos'
);

-- Não há GRANT de INSERT para authenticated (só service_role escreve) --
-- authenticated é bloqueado a nível de privilégio de tabela, antes mesmo de
-- chegar em qualquer policy de INSERT (que também não existe).
select throws_ok(
  $$insert into public.feegow_sync_log (tenant_id, status)
    select tenant_id, 'success' from public.profiles
    where id = '77777777-7777-7777-7777-777777777777'$$,
  '42501',
  NULL,
  'authenticated não consegue INSERT em feegow_sync_log (sem GRANT de insert, só service_role escreve)'
);

-- authenticated também não pode executar a RPC direto (revoke all from
-- public/anon/authenticated na migration) -- só service_role, via
-- feegow-sync/runner.ts.
select throws_ok(
  $$select public.feegow_upsert_appointments('[]'::jsonb)$$,
  '42501',
  NULL,
  'authenticated não consegue executar feegow_upsert_appointments (só service_role)'
);

reset role;

select * from finish();
rollback;
