begin;
create extension if not exists pgtap;

select plan(17);

-- Estrutura ------------------------------------------------------------------

select has_function(
  'private',
  'scheduled_job_catalog',
  array[]::text[],
  'catálogo de rotinas existe'
);

select has_function(
  'private',
  'invoke_edge_function',
  array['text', 'jsonb', 'integer'],
  'invocador genérico de Edge Function existe'
);

select has_function(
  'private',
  'sync_scheduled_jobs',
  array['boolean'],
  'reconciliador existe'
);

select has_function(
  'public',
  'activate_scheduled_jobs',
  array[]::text[],
  'porta de entrada do wizard existe'
);

-- Conteúdo do catálogo -------------------------------------------------------

create temp table expected_scheduled_jobs(jobname text primary key);
insert into expected_scheduled_jobs(jobname) values
  ('ai-response-worker-every-minute'),
  ('contact-enrichment-dispatcher'),
  ('domain-event-dispatcher-every-minute'),
  ('evolution-watchdog'),
  ('hitl-overdue-activity-analyzer'),
  ('hitl-sla-monitor'),
  ('hitl-stagnant-deal-analyzer'),
  ('inbound-events-retention'),
  ('messaging-channels-reconcile'),
  ('nurture-auto-enroll-scanner'),
  ('nurture-runner'),
  ('pipeline-agent'),
  ('security-drift-sentinel'),
  ('template-schedule-runner'),
  ('voice-call-poller'),
  ('webhook-delivery-worker'),
  ('weekly-digest-generator');

select results_eq(
  $$select jobname from private.scheduled_job_catalog() order by jobname$$,
  $$select jobname from expected_scheduled_jobs order by jobname$$,
  'catálogo preserva as 16 rotinas e inclui inbound-events-retention'
);

select is(
  (
    select default_active
    from private.scheduled_job_catalog()
    where jobname = 'template-schedule-runner'
  ),
  true,
  'runner de campanhas nasce ligado desde que a tela Campanhas saiu do "Em breve"'
);

select is(
  (
    select default_active
    from private.scheduled_job_catalog()
    where jobname = 'pipeline-agent'
  ),
  false,
  'Kanban autônomo nasce desligado até o backlog represado ser tratado'
);

select is(
  (
    select count(*)::integer
    from private.scheduled_job_catalog()
    where sql_command like '%http%'
  ),
  0,
  'nenhum comando do catálogo carrega URL: a URL vem do Vault'
);

select is(
  (
    select count(*)::integer
    from private.scheduled_job_catalog()
    where jobname !~ '^[a-z][a-z0-9-]*$'
  ),
  0,
  'todo jobname é slug válido'
);

-- Comportamento --------------------------------------------------------------

select throws_ok(
  $$select private.invoke_edge_function('nurture runner; drop table x')$$,
  '22023',
  null,
  'nome fora do formato de slug é recusado antes de virar URL'
);

select lives_ok(
  $$select private.sync_scheduled_jobs()$$,
  'reconciliação roda mesmo sem Vault configurado'
);

select results_eq(
  $$select j.jobname from cron.job j
    join private.scheduled_job_catalog() c on c.jobname = j.jobname order by j.jobname$$,
  $$select jobname from expected_scheduled_jobs order by jobname$$,
  'reconciliação registra exatamente as 17 rotinas esperadas em cron.job'
);

select is(
  (
    select active
    from cron.job
    where jobname = 'pipeline-agent'
  ),
  false,
  'reconciliação respeita o default_active do catálogo'
);

select lives_ok(
  $$select private.sync_scheduled_jobs(true)$$,
  'reconciliação aceita a pausa em bloco'
);

select is(
  (
    select count(*)::integer
    from cron.job j
    join private.scheduled_job_catalog() c on c.jobname = j.jobname
    where j.active
  ),
  0,
  'p_pause_all desliga todas as rotinas sem apagar nenhuma'
);

select results_eq(
  $$select j.jobname from cron.job j
    join private.scheduled_job_catalog() c on c.jobname = j.jobname order by j.jobname$$,
  $$select jobname from expected_scheduled_jobs order by jobname$$,
  'pausa preserva exatamente as 17 rotinas esperadas'
);

-- Privilégios ----------------------------------------------------------------

select function_privs_are(
  'public',
  'activate_scheduled_jobs',
  array[]::text[],
  'anon',
  array[]::text[],
  'anônimo não liga rotina nenhuma'
);

select * from finish();
rollback;
