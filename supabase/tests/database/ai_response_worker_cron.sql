begin;
create extension if not exists pgtap;

select plan(10);

select has_function(
  'public',
  'invoke_ai_response_worker',
  array[]::text[],
  'função de dispatch do worker existe'
);

select is(
  (
    select count(*)::integer
    from cron.job
    where jobname = 'ai-response-worker-every-minute'
  ),
  1,
  'existe exatamente um cron do worker'
);

-- Banco novo (remix) nasce com as rotinas pausadas até o bootstrap gravar a
-- URL e a chave no Vault (sync_scheduled_jobs com p_pause_all). O que a
-- migration garante é o catálogo pedir o worker ligado.
select is(
  (
    select default_active
    from private.scheduled_job_catalog()
    where jobname = 'ai-response-worker-every-minute'
  ),
  true,
  'catálogo liga o cron do worker depois do bootstrap'
);

select is(
  (
    select schedule
    from cron.job
    where jobname = 'ai-response-worker-every-minute'
  ),
  '* * * * *',
  'worker roda a cada minuto'
);

select ok(
  position(
    'invoke_ai_response_worker' in (
      select command
      from cron.job
      where jobname = 'ai-response-worker-every-minute'
    )
  ) > 0,
  'cron chama o wrapper versionado'
);

select function_privs_are(
  'public',
  'invoke_ai_response_worker',
  array[]::text[],
  'anon',
  array[]::text[],
  'anon não executa o worker'
);

select function_privs_are(
  'public',
  'invoke_ai_response_worker',
  array[]::text[],
  'authenticated',
  array[]::text[],
  'authenticated não executa o worker'
);

select function_privs_are(
  'public',
  'invoke_ai_response_worker',
  array[]::text[],
  'service_role',
  array['EXECUTE'],
  'service_role pode acionar o worker'
);

select is(
  (
    select default_enabled
    from public.ai_feature_catalog
    where feature_key = 'durable_ai_response_queue'
  ),
  false,
  'fila durável nasce desligada'
);

select is(
  (
    select toggle_authority
    from public.ai_feature_catalog
    where feature_key = 'durable_ai_response_queue'
  ),
  'tenant_admin',
  'admin do tenant ativa a fila durável (catálogo de 20260811001846)'
);

select * from finish();
rollback;
