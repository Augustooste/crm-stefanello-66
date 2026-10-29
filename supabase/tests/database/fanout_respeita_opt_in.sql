begin;
create extension if not exists pgtap;
select plan(22);

-- O opt-in usa clock_timestamp(). Cada publicação desta transação de teste
-- simula uma nova transação de mensagem, posterior à alteração da feature.
alter table public.domain_events alter column created_at set default clock_timestamp();

insert into auth.users(id, email) values
  ('f6170000-0000-4000-8000-000000000001', 'fanout-sem-opt-in@test.invalid'),
  ('f6170000-0000-4000-8000-000000000002', 'fanout-com-opt-in@test.invalid');
insert into public.contacts(id, tenant_id, name)
select ('f6171000-0000-4000-8000-' || right(id::text, 12))::uuid, tenant_id, 'Contato do fan-out'
from public.profiles where id in ('f6170000-0000-4000-8000-000000000001', 'f6170000-0000-4000-8000-000000000002');
insert into public.channels(id, tenant_id, provider_slug, type)
select ('f6172000-0000-4000-8000-' || right(id::text, 12))::uuid, tenant_id, 'simulator', 'simulator'
from public.profiles where id in ('f6170000-0000-4000-8000-000000000001', 'f6170000-0000-4000-8000-000000000002');
insert into public.conversations(id, tenant_id, contact_id, channel_id)
select ('f6173000-0000-4000-8000-' || right(id::text, 12))::uuid, tenant_id,
  ('f6171000-0000-4000-8000-' || right(id::text, 12))::uuid,
  ('f6172000-0000-4000-8000-' || right(id::text, 12))::uuid
from public.profiles where id in ('f6170000-0000-4000-8000-000000000001', 'f6170000-0000-4000-8000-000000000002');
insert into public.tenant_ai_features(tenant_id, feature_key, enabled)
select p.tenant_id, f.feature_key, true
from public.profiles p cross join (values ('pipeline_agent'), ('contact_auto_enrichment')) f(feature_key)
where p.id = 'f6170000-0000-4000-8000-000000000002';

-- O opt-in do tenant B não autoriza mensagens do tenant A, que não tem flags.
insert into public.messages(id, tenant_id, conversation_id, direction, sender, content)
select m.id, p.tenant_id, 'f6173000-0000-4000-8000-000000000001', m.direction, m.sender, 'Mensagem sem opt-in'
from public.profiles p cross join (values
  ('f6174000-0000-4000-8000-000000000001'::uuid, 'in', 'contact'),
  ('f6174000-0000-4000-8000-000000000002'::uuid, 'out', 'agent')
) m(id, direction, sender) where p.id = 'f6170000-0000-4000-8000-000000000001';
select is((select count(*)::int from public.domain_events
  where aggregate_id in ('f6174000-0000-4000-8000-000000000001', 'f6174000-0000-4000-8000-000000000002')),
  2, 'mensagens recebida e enviada publicam eventos mesmo sem opt-in');
select is((select count(*)::int from public.event_deliveries d join public.domain_events e on e.id = d.event_id
  where e.aggregate_id in ('f6174000-0000-4000-8000-000000000001', 'f6174000-0000-4000-8000-000000000002')
    and d.subscriber_id = 'pipeline.agent'), 0, 'sem opt-in não cria entrega de pipeline, mesmo com outro tenant ligado');
select is((select count(*)::int from public.event_deliveries d join public.domain_events e on e.id = d.event_id
  where e.aggregate_id in ('f6174000-0000-4000-8000-000000000001', 'f6174000-0000-4000-8000-000000000002')
    and d.subscriber_id = 'contact.enrichment'), 0, 'sem opt-in não cria entrega de enriquecimento, mesmo com outro tenant ligado');
select results_eq($$
  select d.subscriber_id, d.status, d.max_attempts, count(*)::int
  from public.event_deliveries d join public.domain_events e on e.id = d.event_id
  where e.aggregate_id in ('f6174000-0000-4000-8000-000000000001', 'f6174000-0000-4000-8000-000000000002')
    and d.subscriber_id in ('kernel.observability', 'kernel.projection')
  group by d.subscriber_id, d.status, d.max_attempts order by d.subscriber_id
$$, $$values ('kernel.observability'::text, 'pending'::text, 5, 2), ('kernel.projection', 'pending', 8, 2)$$,
  'sem opt-in preserva assinantes normais, wildcard, estado pendente e tentativas');

insert into public.messages(id, tenant_id, conversation_id, direction, sender, content)
select m.id, p.tenant_id, 'f6173000-0000-4000-8000-000000000002', m.direction, m.sender, 'Mensagem com opt-in'
from public.profiles p cross join (values
  ('f6174000-0000-4000-8000-000000000003'::uuid, 'in', 'contact'),
  ('f6174000-0000-4000-8000-000000000004'::uuid, 'out', 'agent')
) m(id, direction, sender) where p.id = 'f6170000-0000-4000-8000-000000000002';
select is((select count(*)::int from public.event_deliveries d join public.domain_events e on e.id = d.event_id
  where e.aggregate_id in ('f6174000-0000-4000-8000-000000000003', 'f6174000-0000-4000-8000-000000000004')
    and d.subscriber_id = 'pipeline.agent' and d.status = 'pending' and d.attempts = 0 and d.tenant_id = e.tenant_id),
  2, 'com opt-in cria pipeline pendente para mensagens recebida e enviada do próprio tenant');
select is((select count(*)::int from public.event_deliveries d join public.domain_events e on e.id = d.event_id
  where e.aggregate_id in ('f6174000-0000-4000-8000-000000000003', 'f6174000-0000-4000-8000-000000000004')
    and d.subscriber_id = 'contact.enrichment' and d.status = 'pending' and d.attempts = 0 and d.tenant_id = e.tenant_id),
  2, 'com opt-in cria enriquecimento pendente para mensagens recebida e enviada do próprio tenant');
select results_eq($$
  select d.subscriber_id, count(*)::int
  from public.event_deliveries d join public.domain_events e on e.id = d.event_id
  where e.aggregate_id in ('f6174000-0000-4000-8000-000000000003', 'f6174000-0000-4000-8000-000000000004')
    and d.subscriber_id in ('kernel.observability', 'kernel.projection')
  group by d.subscriber_id order by d.subscriber_id
$$, $$values ('kernel.observability'::text, 2), ('kernel.projection', 2)$$,
  'com opt-in também preserva os demais assinantes');

update public.tenant_ai_features set enabled = false
where tenant_id = (select tenant_id from public.profiles where id = 'f6170000-0000-4000-8000-000000000002')
  and feature_key in ('pipeline_agent', 'contact_auto_enrichment');
insert into public.messages(id, tenant_id, conversation_id, direction, sender, content)
select m.id, p.tenant_id, 'f6173000-0000-4000-8000-000000000002', m.direction, m.sender, 'Mensagem após desligar'
from public.profiles p cross join (values
  ('f6174000-0000-4000-8000-000000000005'::uuid, 'in', 'contact'),
  ('f6174000-0000-4000-8000-000000000006'::uuid, 'out', 'agent')
) m(id, direction, sender) where p.id = 'f6170000-0000-4000-8000-000000000002';
select is((select count(*)::int from public.event_deliveries d join public.domain_events e on e.id = d.event_id
  where e.aggregate_id in ('f6174000-0000-4000-8000-000000000005', 'f6174000-0000-4000-8000-000000000006')
    and d.subscriber_id = 'pipeline.agent'), 0, 'desligar pipeline interrompe a criação de entregas');
select is((select count(*)::int from public.event_deliveries d join public.domain_events e on e.id = d.event_id
  where e.aggregate_id in ('f6174000-0000-4000-8000-000000000005', 'f6174000-0000-4000-8000-000000000006')
    and d.subscriber_id = 'contact.enrichment'), 0, 'desligar enriquecimento interrompe a criação de entregas');
select results_eq($$
  select d.subscriber_id, count(*)::int
  from public.event_deliveries d join public.domain_events e on e.id = d.event_id
  where e.aggregate_id in ('f6174000-0000-4000-8000-000000000005', 'f6174000-0000-4000-8000-000000000006')
    and d.subscriber_id in ('kernel.observability', 'kernel.projection')
  group by d.subscriber_id order by d.subscriber_id
$$, $$values ('kernel.observability'::text, 2), ('kernel.projection', 2)$$,
  'desligar as features não interrompe os demais assinantes');
select is((select count(*)::int from public.event_deliveries d join public.domain_events e on e.id = d.event_id
  where e.aggregate_id in ('f6174000-0000-4000-8000-000000000003', 'f6174000-0000-4000-8000-000000000004')
    and d.subscriber_id in ('pipeline.agent', 'contact.enrichment') and d.status = 'pending' and d.attempts = 0),
  4, 'desligar não apaga nem modifica entregas pendentes já criadas');

-- Cada assinante exige a própria feature, sem compartilhar opt-in entre tenants.
insert into public.tenant_ai_features(tenant_id, feature_key, enabled)
select tenant_id, 'pipeline_agent', true from public.profiles where id = 'f6170000-0000-4000-8000-000000000001';
update public.tenant_ai_features set enabled = true
where tenant_id = (select tenant_id from public.profiles where id = 'f6170000-0000-4000-8000-000000000002')
  and feature_key = 'contact_auto_enrichment';
insert into public.messages(id, tenant_id, conversation_id, direction, sender, content)
select 'f6174000-0000-4000-8000-000000000007', tenant_id, 'f6173000-0000-4000-8000-000000000001', 'in', 'contact', 'Só pipeline'
from public.profiles where id = 'f6170000-0000-4000-8000-000000000001';
insert into public.messages(id, tenant_id, conversation_id, direction, sender, content)
select 'f6174000-0000-4000-8000-000000000008', tenant_id, 'f6173000-0000-4000-8000-000000000002', 'out', 'agent', 'Só enriquecimento'
from public.profiles where id = 'f6170000-0000-4000-8000-000000000002';
select results_eq($$
  select d.subscriber_id from public.event_deliveries d join public.domain_events e on e.id = d.event_id
  where e.aggregate_id = 'f6174000-0000-4000-8000-000000000007'
    and d.subscriber_id in ('pipeline.agent', 'contact.enrichment') order by d.subscriber_id
$$, $$values ('pipeline.agent'::text)$$, 'pipeline ligado não autoriza enriquecimento ausente, mesmo ligado no outro tenant');
select results_eq($$
  select d.subscriber_id from public.event_deliveries d join public.domain_events e on e.id = d.event_id
  where e.aggregate_id = 'f6174000-0000-4000-8000-000000000008'
    and d.subscriber_id in ('pipeline.agent', 'contact.enrichment') order by d.subscriber_id
$$, $$values ('contact.enrichment'::text)$$, 'enriquecimento ligado não autoriza pipeline desligado, mesmo ligado no outro tenant');

-- O corte usa created_at do evento, não occurred_at nem o horário do INSERT.
insert into public.domain_events(id, tenant_id, event_type, aggregate_type, aggregate_id, idempotency_key, created_at, occurred_at)
select ('f6175000-0000-4000-8000-' || right(p.id::text, 12))::uuid, p.tenant_id,
  'message.received', 'message', gen_random_uuid(), 'fanout:anterior:' || p.id,
  f.enabled_at - interval '1 microsecond', clock_timestamp()
from public.profiles p join public.tenant_ai_features f on f.tenant_id = p.tenant_id and f.enabled
where (p.id = 'f6170000-0000-4000-8000-000000000001' and f.feature_key = 'pipeline_agent')
   or (p.id = 'f6170000-0000-4000-8000-000000000002' and f.feature_key = 'contact_auto_enrichment');
select is((select count(*)::int from public.event_deliveries
  where event_id = 'f6175000-0000-4000-8000-000000000001' and subscriber_id = 'pipeline.agent'),
  0, 'evento anterior a enabled_at não cria pipeline, mesmo publicado depois');
select is((select count(*)::int from public.event_deliveries
  where event_id = 'f6175000-0000-4000-8000-000000000002' and subscriber_id = 'contact.enrichment'),
  0, 'evento anterior a enabled_at não cria enriquecimento, mesmo publicado depois');
select results_eq($$
  select subscriber_id, count(*)::int from public.event_deliveries
  where event_id in ('f6175000-0000-4000-8000-000000000001', 'f6175000-0000-4000-8000-000000000002')
    and subscriber_id in ('kernel.observability', 'kernel.projection')
  group by subscriber_id order by subscriber_id
$$, $$values ('kernel.observability'::text, 2), ('kernel.projection', 2)$$,
  'o corte temporal não altera as entregas dos demais assinantes');
insert into public.domain_events(id, tenant_id, event_type, aggregate_type, aggregate_id, idempotency_key, created_at, occurred_at)
select ('f6176000-0000-4000-8000-' || right(p.id::text, 12))::uuid, p.tenant_id,
  'message.sent', 'message', gen_random_uuid(), 'fanout:limite:' || p.id,
  f.enabled_at, f.enabled_at - interval '1 day'
from public.profiles p join public.tenant_ai_features f on f.tenant_id = p.tenant_id and f.enabled
where (p.id = 'f6170000-0000-4000-8000-000000000001' and f.feature_key = 'pipeline_agent')
   or (p.id = 'f6170000-0000-4000-8000-000000000002' and f.feature_key = 'contact_auto_enrichment');
select is((select count(*)::int from public.event_deliveries
  where event_id = 'f6176000-0000-4000-8000-000000000001' and subscriber_id = 'pipeline.agent'),
  1, 'created_at igual a enabled_at inclui pipeline, independentemente de occurred_at');
select is((select count(*)::int from public.event_deliveries
  where event_id = 'f6176000-0000-4000-8000-000000000002' and subscriber_id = 'contact.enrichment'),
  1, 'created_at igual a enabled_at inclui enriquecimento, independentemente de occurred_at');

insert into public.domain_events(id, tenant_id, event_type, aggregate_type, aggregate_id, idempotency_key)
values ('f6177000-0000-4000-8000-000000000001', null, 'message.received', 'message', gen_random_uuid(), 'fanout:sem-tenant');
select is((select count(*)::int from public.event_deliveries
  where event_id = 'f6177000-0000-4000-8000-000000000001' and subscriber_id in ('pipeline.agent', 'contact.enrichment')),
  0, 'evento sem tenant não herda opt-in de nenhum workspace');
select results_eq($$
  select subscriber_id from public.event_deliveries
  where event_id = 'f6177000-0000-4000-8000-000000000001'
    and subscriber_id in ('kernel.observability', 'kernel.projection') order by subscriber_id
$$, $$values ('kernel.observability'::text), ('kernel.projection')$$,
  'evento sem tenant preserva os demais assinantes');
insert into public.domain_events(id, tenant_id, event_type, aggregate_type, aggregate_id, idempotency_key)
select 'f6177000-0000-4000-8000-000000000002', tenant_id, 'fanout.nao_assinado', 'message', gen_random_uuid(), 'fanout:nao-assinado'
from public.profiles where id = 'f6170000-0000-4000-8000-000000000001';
select results_eq($$
  select subscriber_id from public.event_deliveries
  where event_id = 'f6177000-0000-4000-8000-000000000002' order by subscriber_id
$$, $$values ('kernel.observability'::text)$$, 'opt-in não ignora tipos assinados e wildcard continua funcionando');

update public.domain_event_subscriptions set active = false where subscriber_id in ('pipeline.agent', 'contact.enrichment');
insert into public.messages(id, tenant_id, conversation_id, direction, sender, content)
select ('f6178000-0000-4000-8000-' || right(id::text, 12))::uuid, tenant_id,
  ('f6173000-0000-4000-8000-' || right(id::text, 12))::uuid, 'in', 'contact', 'Assinatura inativa'
from public.profiles where id in ('f6170000-0000-4000-8000-000000000001', 'f6170000-0000-4000-8000-000000000002');
select is((select count(*)::int from public.event_deliveries d join public.domain_events e on e.id = d.event_id
  where e.aggregate_id in ('f6178000-0000-4000-8000-000000000001', 'f6178000-0000-4000-8000-000000000002')
    and d.subscriber_id in ('pipeline.agent', 'contact.enrichment')), 0, 'opt-in não reativa assinaturas inativas');

select * from finish();
rollback;
