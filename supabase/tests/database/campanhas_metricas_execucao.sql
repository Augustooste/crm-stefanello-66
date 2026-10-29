-- Métricas por execução de campanha (20260926100000): colunas + check do tipo.
begin;
create extension if not exists pgtap;

select plan(5);

select has_column('public', 'template_schedule_executions', 'provider_slug', 'provider_slug existe');
select has_column('public', 'template_schedule_executions', 'message_kind', 'message_kind existe');
select has_column('public', 'template_schedule_executions', 'external_id', 'external_id existe');

select ok(
  exists (
    select 1 from pg_constraint
    where conname = 'template_schedule_executions_message_kind_check'
  ),
  'message_kind só aceita freeform/provider_template'
);

-- Nenhuma policy nova de escrita para authenticated: só o runner grava.
select is(
  (select count(*)::int from pg_policies
    where tablename = 'template_schedule_executions'
      and cmd in ('INSERT', 'UPDATE', 'DELETE')
      and 'authenticated' = any(roles)),
  0,
  'execuções continuam graváveis só pelo service_role'
);

select * from finish();
rollback;
