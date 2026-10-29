-- Guarda-corpo de EXECUTE nas RPCs chamadas pelo frontend.
--
-- Motivo: em 2026-07-31 o /app quebrou logo após o login com
-- "42501 permission denied for function get_my_capabilities" — a chamada
-- chegou ao banco como `anon` (sem token). Este teste trava as duas pontas:
-- `authenticated` PRECISA executar; `anon` NÃO pode.
begin;
select plan(18);

create or replace function pg_temp.fn_oid(p_signature text)
returns oid language sql stable as $$
  select p_signature::regprocedure::oid;
$$;

-- authenticated pode executar todas as RPCs que o app chama logado.
select ok(
  has_function_privilege('authenticated', pg_temp.fn_oid(sig), 'EXECUTE'),
  format('authenticated tem EXECUTE em %s', sig)
)
from unnest(array[
  'public.get_my_capabilities()',
  'public.get_my_permissions()',
  'public.list_my_workspaces()',
  'public.has_capability(text)',
  'public.evaluate_capability(text, text)',
  'public.log_client_error(text, text, text, text, jsonb, text)',
  'public.switch_active_workspace(uuid)',
  'public.get_pipeline_automation_metrics(uuid, timestamptz)',
  'public.find_duplicate_contacts()'
]) as sig;

-- anon não pode executar nenhuma delas (superfície pública fica fora daqui).
select ok(
  not has_function_privilege('anon', pg_temp.fn_oid(sig), 'EXECUTE'),
  format('anon NÃO tem EXECUTE em %s', sig)
)
from unnest(array[
  'public.get_my_capabilities()',
  'public.get_my_permissions()',
  'public.list_my_workspaces()',
  'public.has_capability(text)',
  'public.evaluate_capability(text, text)',
  'public.log_client_error(text, text, text, text, jsonb, text)',
  'public.switch_active_workspace(uuid)',
  'public.get_pipeline_automation_metrics(uuid, timestamptz)',
  'public.find_duplicate_contacts()'
]) as sig;

select * from finish();
rollback;
