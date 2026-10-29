begin;
create extension if not exists pgtap;
select plan(9);

select is(
  (select count(*)::integer from cron.job where jobname = 'webhook-delivery-worker'),
  1,
  'existe exatamente um cron do worker de webhooks'
);

select is(
  (select schedule from cron.job where jobname = 'webhook-delivery-worker'),
  '* * * * *',
  'worker de webhooks roda a cada minuto'
);

select is(
  (select command from cron.job where jobname = 'webhook-delivery-worker'),
  'select private.invoke_edge_function(''webhook-delivery-worker'', ''{}''::jsonb, 120000);',
  'comando chama a edge function webhook-delivery-worker pelo invocador do Vault'
);

select ok(
  (select command !~* '(bearer|eyJ|sk_|sk-|apikey|service_role|https?://)'
   from cron.job where jobname = 'webhook-delivery-worker'),
  'comando do cron não contém literal de chave, token ou URL'
);

select is(
  (select default_active from private.scheduled_job_catalog() where jobname = 'webhook-delivery-worker'),
  true,
  'catálogo de rotinas lista o worker ligado'
);

-- Rodar a migration de novo (função de agendamento) não duplica o job.
select private.ensure_webhook_delivery_worker_cron();
select private.ensure_webhook_delivery_worker_cron();
select is(
  (select count(*)::integer from cron.job where jobname = 'webhook-delivery-worker'),
  1,
  'reagendar duas vezes não duplica o job'
);

select is(
  (select count(*)::integer from private.scheduled_job_catalog()),
  17,
  'catálogo preserva as 15 rotinas anteriores, o worker e a retenção de entrada'
);

-- Job pausado por operador continua pausado depois de reaplicar a migration.
select cron.alter_job(jobid, active := false) from cron.job where jobname = 'webhook-delivery-worker';
select private.ensure_webhook_delivery_worker_cron();
select is(
  (select active from cron.job where jobname = 'webhook-delivery-worker'),
  false,
  'reaplicar não reativa job pausado'
);
select is(
  (select count(*)::integer from cron.job where jobname = 'webhook-delivery-worker'),
  1,
  'job pausado continua único após reaplicar'
);

select * from finish();
rollback;
