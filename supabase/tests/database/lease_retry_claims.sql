-- Claims recuperáveis do webhook e da IA.
-- Roda no shadow DB local: pnpm test:db.
begin;
create extension if not exists pgtap;

select plan(33);

insert into public.tenants (id, name)
values ('72720000-0000-0000-0000-000000000001', 'Lease Claims Test');

insert into public.channels (id, tenant_id, type, provider_slug, status)
values (
  '72720000-0000-0000-0000-000000000002',
  '72720000-0000-0000-0000-000000000001',
  'whatsapp',
  'zapi',
  'connected'
);

insert into public.contacts (id, tenant_id, name, phone)
values (
  '72720000-0000-0000-0000-000000000003',
  '72720000-0000-0000-0000-000000000001',
  'Contato Lease',
  '+5511999999999'
);

insert into public.conversations (id, tenant_id, contact_id, channel_id)
values (
  '72720000-0000-0000-0000-000000000004',
  '72720000-0000-0000-0000-000000000001',
  '72720000-0000-0000-0000-000000000003',
  '72720000-0000-0000-0000-000000000002'
);

insert into public.messages (id, tenant_id, conversation_id, direction, sender, content, external_id)
values (
  '72720000-0000-0000-0000-000000000005',
  '72720000-0000-0000-0000-000000000001',
  '72720000-0000-0000-0000-000000000004',
  'in',
  'contact',
  'teste de lease',
  'lease-message-1'
);

select has_column('public', 'messaging_webhook_events', 'status', 'evento tem status');
select has_column(
  'public',
  'messaging_webhook_events',
  'lease_expires_at',
  'evento tem lease_expires_at'
);
select has_function(
  'public',
  'claim_messaging_webhook_event',
  array['uuid', 'uuid', 'text', 'text', 'jsonb'],
  'claim de webhook existe'
);

create temp table webhook_claim_1 as
select * from public.claim_messaging_webhook_event(
  '72720000-0000-0000-0000-000000000001',
  '72720000-0000-0000-0000-000000000002',
  'zapi',
  'lease-webhook-1',
  '{"message":"primeira"}'::jsonb
);

select is((select claim_state from webhook_claim_1), 'claimed', 'primeira entrega reivindica');
select is((select attempt from webhook_claim_1), 1, 'primeira entrega é attempt 1');

create temp table webhook_claim_busy as
select * from public.claim_messaging_webhook_event(
  '72720000-0000-0000-0000-000000000001',
  '72720000-0000-0000-0000-000000000002',
  'zapi',
  'lease-webhook-1',
  '{"message":"concorrente"}'::jsonb
);

select is((select claim_state from webhook_claim_busy), 'busy', 'concorrente não duplica');
select is(
  (select count(*)::int from public.messaging_webhook_events where external_event_id = 'lease-webhook-1'),
  1,
  'concorrência mantém uma linha'
);

update public.messaging_webhook_events
set status = 'failed', lease_expires_at = now(), error = 'blip de banco'
where external_event_id = 'lease-webhook-1';

create temp table webhook_claim_retry as
select * from public.claim_messaging_webhook_event(
  '72720000-0000-0000-0000-000000000001',
  '72720000-0000-0000-0000-000000000002',
  'zapi',
  'lease-webhook-1',
  '{"message":"retry"}'::jsonb
);

select is((select claim_state from webhook_claim_retry), 'reclaimed', 'falha permite reentrega');
select is((select attempt from webhook_claim_retry), 2, 'reentrega incrementa attempt');

update public.messaging_webhook_events
set status = 'completed', processed = true, processed_at = now(), lease_expires_at = null
where external_event_id = 'lease-webhook-1';

select is(
  (
    select claim_state
    from public.claim_messaging_webhook_event(
      '72720000-0000-0000-0000-000000000001',
      '72720000-0000-0000-0000-000000000002',
      'zapi',
      'lease-webhook-1',
      '{"message":"duplicada"}'::jsonb
    )
  ),
  'completed',
  'sucesso concluído permanece deduplicado'
);
select is(
  (select count(*)::int from public.messaging_webhook_events where external_event_id = 'lease-webhook-1'),
  1,
  'sucesso duplicado não cria segunda linha'
);

select has_column('public', 'ai_processing_log', 'status', 'claim IA tem status');
select has_column('public', 'ai_processing_log', 'lease_token', 'claim IA tem token');
select has_column('public', 'ai_processing_log', 'lease_expires_at', 'claim IA tem expiração');
select has_column('public', 'ai_processing_log', 'attempts', 'claim IA conta tentativas');
select has_function(
  'public',
  'claim_ai_processing_message',
  array['uuid', 'uuid', 'uuid', 'integer'],
  'RPC de claim IA existe'
);
select has_function(
  'public',
  'finish_ai_processing_message',
  array['uuid', 'uuid', 'text', 'text'],
  'RPC token-safe de conclusão/liberação existe'
);

create temp table ai_claim_1 as
select * from public.claim_ai_processing_message(
  '72720000-0000-0000-0000-000000000005',
  '72720000-0000-0000-0000-000000000004',
  '72720000-0000-0000-0000-000000000001',
  180
);

select ok((select claimed from ai_claim_1), 'primeira IA reivindica');

create temp table ai_claim_busy as
select * from public.claim_ai_processing_message(
  '72720000-0000-0000-0000-000000000005',
  '72720000-0000-0000-0000-000000000004',
  '72720000-0000-0000-0000-000000000001',
  180
);

select isnt((select claimed from ai_claim_busy), true, 'claim concorrente da IA é bloqueada');
select ok(
  public.finish_ai_processing_message(
    '72720000-0000-0000-0000-000000000005',
    (select lease_token from ai_claim_1),
    'failed',
    'falha transitória'
  ),
  'dono da lease libera como failed'
);

create temp table ai_claim_retry as
select * from public.claim_ai_processing_message(
  '72720000-0000-0000-0000-000000000005',
  '72720000-0000-0000-0000-000000000004',
  '72720000-0000-0000-0000-000000000001',
  180
);

select ok((select claimed from ai_claim_retry), 'IA recupera claim failed');
select is((select attempt from ai_claim_retry), 2, 'retry da IA incrementa attempt');
select isnt(
  (select lease_token from ai_claim_retry),
  (select lease_token from ai_claim_1),
  'retry recebe novo token'
);
select isnt(
  public.finish_ai_processing_message(
    '72720000-0000-0000-0000-000000000005',
    (select lease_token from ai_claim_1),
    'failed',
    'stale'
  ),
  true,
  'dono antigo não invalida lease nova'
);
select ok(
  public.finish_ai_processing_message(
    '72720000-0000-0000-0000-000000000005',
    (select lease_token from ai_claim_retry),
    'completed',
    null
  ),
  'dono atual conclui'
);
select isnt(
  (
    select claimed
    from public.claim_ai_processing_message(
      '72720000-0000-0000-0000-000000000005',
      '72720000-0000-0000-0000-000000000004',
      '72720000-0000-0000-0000-000000000001',
      180
    )
  ),
  true,
  'claim concluída não reabre'
);
select is(
  (select count(*)::int from public.ai_processing_log where message_id = '72720000-0000-0000-0000-000000000005'),
  1,
  'concorrência mantém uma linha de processamento'
);

select has_function(
  'public',
  'enqueue_ai_response_job',
  array['uuid', 'uuid'],
  'RPC de enqueue durável da IA existe'
);

create temp table ai_job_1 as
select * from public.enqueue_ai_response_job(
  '72720000-0000-0000-0000-000000000001',
  '72720000-0000-0000-0000-000000000005'
);

select ok((select should_dispatch from ai_job_1), 'primeiro enqueue pede dispatch');
select is(
  (
    select count(*)::int
    from public.job_queue
    where job_type = 'ai_respond'
      and payload ->> 'message_id' = '72720000-0000-0000-0000-000000000005'
  ),
  1,
  'primeiro enqueue cria um job'
);
select ok(
  (
    select should_dispatch
    from public.enqueue_ai_response_job(
      '72720000-0000-0000-0000-000000000001',
      '72720000-0000-0000-0000-000000000005'
    )
  ),
  'job ainda pending pode ser retomado'
);
select is(
  (
    select count(*)::int
    from public.job_queue
    where job_type = 'ai_respond'
      and payload ->> 'message_id' = '72720000-0000-0000-0000-000000000005'
  ),
  1,
  'reenqueue pending não duplica job'
);
update public.job_queue set status = 'success'
where id = (select job_id from ai_job_1);
select isnt(
  (
    select should_dispatch
    from public.enqueue_ai_response_job(
      '72720000-0000-0000-0000-000000000001',
      '72720000-0000-0000-0000-000000000005'
    )
  ),
  true,
  'job concluído não é disparado outra vez'
);

select * from finish();
rollback;

