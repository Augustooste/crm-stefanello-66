-- v2 revisão final I1: guarda interna de public.check_and_record_rate_limit para chaves inbound-*.
-- Rodar: pnpm test:db.
begin;
create extension if not exists pgtap;

select plan(17);

-- Estado real dos grants: só service_role executa (anon e authenticated não).
select ok(not has_function_privilege('anon', 'public.check_and_record_rate_limit(text,integer,integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.check_and_record_rate_limit(text,integer,integer)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.check_and_record_rate_limit(text,integer,integer)', 'EXECUTE'),
  'grants: só service_role executa');
select is((select row(p.prosecdef, coalesce(p.proconfig, '{}'))::text from pg_proc p
  where p.oid = 'public.check_and_record_rate_limit(text,integer,integer)'::regprocedure),
  row(true, '{search_path=public}'::text[])::text, 'SECURITY DEFINER e nenhum SET além de search_path');

-- Sem o grant (estado de hoje), authenticated nem chega à função.
select set_config('request.jwt.claims', '{"role":"authenticated"}', false);
set local role authenticated;
select throws_ok($$select public.check_and_record_rate_limit('webhook-test:x', 10, 60)$$,
  '42501', null, 'sem grant: authenticated recebe 42501 do privilégio');
reset role;

-- Remix sem REVOKE: anon e authenticated com EXECUTE. A guarda é que segura inbound-*.
grant execute on function public.check_and_record_rate_limit(text, int, int) to anon, authenticated;

select set_config('request.jwt.claims', '{"role":"anon"}', false);
set local role anon;
select throws_ok($$select public.check_and_record_rate_limit('inbound-req:x', 0, 60)$$,
  '42501', 'service_role required', 'anon com grant: inbound-req recusada');
select throws_ok($$select public.check_and_record_rate_limit('inbound-actions-min:x', 0, 60)$$,
  '42501', 'service_role required', 'anon com grant: inbound-actions-min recusada');
reset role;

select set_config('request.jwt.claims', '{"sub":"e5000000-0000-4000-8000-00000000000a","role":"authenticated"}', false);
set local role authenticated;
select throws_ok($$select public.check_and_record_rate_limit('inbound-req:x', 0, 60)$$,
  '42501', 'service_role required', 'authenticated com grant: inbound-req recusada');
select throws_ok($$select public.check_and_record_rate_limit('inbound-actions-min:x', 0, 60)$$,
  '42501', 'service_role required', 'authenticated com grant: inbound-actions-min recusada');
-- Demais chaves seguem como antes da guarda.
select is(public.check_and_record_rate_limit('webhook-test:x', 10, 60),
  '{"allowed": true, "retryAfterSeconds": 0}'::jsonb, 'authenticated com grant: webhook-test segue liberada');
select is(public.check_and_record_rate_limit('public-api:x', 10, 60),
  '{"allowed": true, "retryAfterSeconds": 0}'::jsonb, 'authenticated com grant: public-api segue liberada');
reset role;

select is((select count(*)::int from public.rate_limits where identifier like 'inbound-%'), 0,
  'chamadas recusadas não gravam linha em rate_limits');

-- Sem claims (postgres puro, pg_cron): auth.role() null. Ruling: inbound-* recusada, o resto passa.
select set_config('request.jwt.claims', '{}', false);
select throws_ok($$select public.check_and_record_rate_limit('inbound-req:x', 1, 60)$$,
  '42501', 'service_role required', 'sem claims: inbound-req recusada');
select is(public.check_and_record_rate_limit('webhook-test:y', 10, 60) ->> 'allowed', 'true',
  'sem claims: webhook-test segue liberada');

revoke execute on function public.check_and_record_rate_limit(text, int, int) from anon, authenticated;

-- service_role (caminho da edge inbound-webhook): passa e o limite continua valendo.
select set_config('request.jwt.claims', '{"role":"service_role"}', false);
set local role service_role;
select is(public.check_and_record_rate_limit('inbound-req:x', 1, 60),
  '{"allowed": true, "retryAfterSeconds": 0}'::jsonb, 'service_role: inbound-req liberada');
select is(public.check_and_record_rate_limit('inbound-req:x', 1, 60) ->> 'allowed', 'false',
  'service_role: inbound-req barrada acima do limite');
select ok((public.check_and_record_rate_limit('inbound-req:x', 1, 60) ->> 'retryAfterSeconds')::int between 1 and 60,
  'service_role: retryAfterSeconds dentro da janela');
select is(public.check_and_record_rate_limit('inbound-actions-min:x', 30, 60) ->> 'allowed', 'true',
  'service_role: inbound-actions-min liberada');
reset role;

-- postgres com claims de service_role (como process_inbound_event em inbound_process.sql): passa.
select is(public.check_and_record_rate_limit('inbound-actions-min:y', 30, 60) ->> 'allowed', 'true',
  'postgres com claims service_role: inbound-actions-min liberada');

select * from finish();
rollback;
