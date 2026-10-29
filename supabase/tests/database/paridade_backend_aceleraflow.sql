-- Paridade com o backend do AceleraFlow original.
--
-- Fixa como asserção o baseline levantado na comparação de 2026-08-11 e
-- restaurado no mesmo dia: tabelas de eventos/projeções, planos e consumo,
-- direitos e marketplace; gatilhos de publicação de evento; assinaturas do
-- despachante (incluindo pipeline.agent); modelos de nicho com seus plugins.
--
-- Serve de trava: se um remix futuro nascer sem alguma dessas peças, o teste
-- aponta exatamente qual.

begin;
create extension if not exists pgtap;

select plan(11);

-- ---------------------------------------------------------------------------
-- 1. As 16 tabelas restauradas.
-- ---------------------------------------------------------------------------
select is(
  (
    select coalesce(string_agg(t, ', ' order by t), '')
    from unnest(array[
      'domain_event_projections',
      'plan_catalog', 'plan_capabilities', 'subscriptions', 'subscription_items',
      'usage_events', 'usage_aggregates',
      'tenant_plugin_installations', 'tenant_capability_quotas',
      'entitlement_audit_log', 'capability_shadow_evaluations', 'billing_webhook_events',
      'marketplace_engine_catalog', 'marketplace_engine_capabilities',
      'marketplace_engine_dependencies', 'tenant_marketplace_installations'
    ]) as t
    where to_regclass('public.' || t) is null
  ),
  '',
  'as 16 tabelas de eventos/planos/direitos/marketplace existem'
);

-- ---------------------------------------------------------------------------
-- 2. Gatilhos de publicação de evento, cada um na tabela certa. Sem eles o
--    outbox nunca recebe nada e a IA/projeções ficam mudas — sem erro visível.
-- ---------------------------------------------------------------------------
select is(
  (
    select coalesce(string_agg(esperado, ', ' order by esperado), '')
    from unnest(array[
      'contacts:contacts_publish_created_event',
      'contacts:contacts_publish_pipeline_updated_event',
      'contact_merge_log:contact_merge_log_publish_event',
      'deal_stage_history:deal_stage_history_publish_event',
      'messages:messages_publish_domain_event',
      'activities:activities_publish_completed_event',
      'appointments:appointments_publish_pipeline_event',
      'lead_form_submissions:lead_form_submissions_publish_pipeline_event',
      'tenant_integrations:tenant_integrations_publish_connected_event',
      'domain_events:domain_events_create_deliveries'
    ]) as esperado
    where not exists (
      select 1
      from pg_trigger tg
      join pg_class c on c.oid = tg.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and not tg.tgisinternal
        and c.relname = split_part(esperado, ':', 1)
        and tg.tgname = split_part(esperado, ':', 2)
    )
  ),
  '',
  'todos os gatilhos de publicação de evento existem nas tabelas certas'
);

-- ---------------------------------------------------------------------------
-- 3. Assinaturas ativas, incluindo o enriquecimento opt-in da ficha.
-- ---------------------------------------------------------------------------
select is(
  (select array_agg(subscriber_id order by subscriber_id) from public.domain_event_subscriptions where active),
  array['billing.audit', 'contact.enrichment', 'kernel.observability', 'kernel.projection', 'pipeline.agent', 'webhook.outbound'],
  'assinaturas ativas preservam o conjunto original e incluem contact.enrichment e webhook.outbound'
);

select is(
  (select event_types from public.domain_event_subscriptions where subscriber_id = 'contact.enrichment'),
  array['message.received', 'message.sent'],
  'enriquecimento recebe somente eventos de mensagens recebidas e enviadas'
);

select ok(
  exists (
    select 1 from public.domain_event_subscriptions
    where subscriber_id = 'pipeline.agent'
      and active
      and event_types @> array['message.received', 'deal.stagnant', 'contact.updated']
  ),
  'assinatura pipeline.agent está ativa e cobre os eventos do agente de pipeline'
);

select ok(
  exists (
    select 1 from public.domain_event_subscriptions
    where subscriber_id = 'kernel.projection'
      and active
      and event_types @> array['contact.created', 'deal.stage_changed']
  ),
  'assinatura kernel.projection está ativa e cobre contato/negócio'
);

select ok(
  exists (
    select 1 from public.domain_event_subscriptions
    where subscriber_id = 'kernel.observability' and active and event_types @> array['*']
  ),
  'assinatura kernel.observability está ativa e escuta tudo'
);

-- ---------------------------------------------------------------------------
-- 4. Modelos de nicho: os 12 slugs e o conjunto de plugins de cada um.
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from public.niche_templates),
  12,
  'os 12 modelos de nicho existem'
);

select is(
  (
    select coalesce(string_agg(slug, ', ' order by slug), '')
    from (
      values
        ('academia-studio', '["agenda", "catalogo"]'::jsonb),
        ('agencia-marketing', '["meta-ads", "catalogo"]'::jsonb),
        ('buffet-eventos', '["agenda", "catalogo"]'::jsonb),
        ('clinica-medica', '["agenda"]'::jsonb),
        ('clinica-odontologica', '["agenda", "catalogo"]'::jsonb),
        ('ecommerce', '["meta-ads", "catalogo"]'::jsonb),
        ('escola-cursos', '["agenda", "catalogo"]'::jsonb),
        ('expansao-franquias', '["agenda", "catalogo"]'::jsonb),
        ('generico', '["companies", "catalogo"]'::jsonb),
        ('industria-encomenda', '["companies", "catalogo"]'::jsonb),
        ('servicos-b2b', '["companies", "catalogo"]'::jsonb),
        ('varejo-loja', '["meta-ads", "catalogo"]'::jsonb)
      ) as esperado(slug, plugins)
    where not exists (
      select 1 from public.niche_templates nt
      where nt.slug = esperado.slug
        and nt.plugins @> esperado.plugins
        and esperado.plugins @> nt.plugins
    )
  ),
  '',
  'cada modelo de nicho tem exatamente o conjunto de plugins do baseline'
);

-- ---------------------------------------------------------------------------
-- 5. Catálogos: capacidades e integrações. Contagem mínima, não exata — nicho
--    novo é evolução esperada; catálogo ENCOLHER é o sintoma de remix vazio.
-- ---------------------------------------------------------------------------
select cmp_ok(
  (select count(*)::int from public.capability_catalog), '>=', 20,
  'catálogo de capacidades tem ao menos as 20 chaves do baseline'
);

select cmp_ok(
  (select count(*)::int from public.permissions), '>=', 28,
  'catálogo de permissões tem ao menos as 28 chaves do baseline'
);

select * from finish();
rollback;
