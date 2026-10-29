-- Fase 3 HITL — existência/estrutura do schema (rodar: pnpm test:db).
-- Roda contra o shadow DB local (supabase test db --local), que reaplica
-- todas as migrations do zero -- não toca a DB real do Lovable.
begin;
create extension if not exists pgtap;

select plan(31);

-- 1. Tabelas novas + RLS habilitada (nunca FORCE -- convenção real do
--    projeto, não o texto do PRD).
select has_table('public', 'ai_pending_stage_advances', 'tabela ai_pending_stage_advances existe');
select has_table('public', 'hitl_decisions', 'tabela hitl_decisions existe');
select has_table('public', 'hitl_audit_log', 'tabela hitl_audit_log existe');
select has_table('public', 'hitl_handoff_sla_events', 'tabela hitl_handoff_sla_events existe');
select has_table('public', 'messaging_templates', 'tabela messaging_templates existe');
select has_table('public', 'ai_feature_catalog', 'tabela ai_feature_catalog existe');
select has_table('public', 'tenant_ai_features', 'tabela tenant_ai_features existe');

select ok(
  (select relrowsecurity from pg_class where oid = 'public.ai_pending_stage_advances'::regclass),
  'RLS habilitada em ai_pending_stage_advances'
);
select ok(
  not (select relforcerowsecurity from pg_class where oid = 'public.ai_pending_stage_advances'::regclass),
  'RLS NÃO forçada em ai_pending_stage_advances (convenção real do projeto)'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.hitl_decisions'::regclass),
  'RLS habilitada em hitl_decisions'
);

-- 2. Sem policy de UPDATE para authenticated em ai_pending_stage_advances/
--    hitl_decisions (fix de review: UPDATE direto pulava a RPC/auditoria).
select is(
  (select count(*)::int from pg_policies
    where tablename = 'ai_pending_stage_advances' and cmd = 'UPDATE' and 'authenticated' = any(roles)),
  0,
  'nenhuma policy de UPDATE para authenticated em ai_pending_stage_advances'
);
select is(
  (select count(*)::int from pg_policies
    where tablename = 'hitl_decisions' and cmd = 'UPDATE' and 'authenticated' = any(roles)),
  0,
  'nenhuma policy de UPDATE para authenticated em hitl_decisions'
);

-- 3. Índices parciais de idempotência (risco #1 do PRD: insert não-idempotente).
select has_index('public', 'ai_pending_stage_advances', 'idx_pending_advances_one_per_deal', 'unique index: 1 pendência por deal');
select has_index('public', 'hitl_decisions', 'idx_hitl_decisions_one_pending_per_activity', 'unique index: 1 pendência por (activity_id, type)');
select has_index('public', 'hitl_handoff_sla_events', 'idx_sla_events_open_per_conversation', 'unique index: 1 evento SLA aberto por conversa');

-- 4. Colunas de extensão.
select has_column('public', 'ai_settings', 'hitl_auto_threshold', 'ai_settings.hitl_auto_threshold existe');
select has_column('public', 'ai_settings', 'hitl_reject_threshold', 'ai_settings.hitl_reject_threshold existe');
select has_column('public', 'conversations', 'awaiting_human_since', 'conversations.awaiting_human_since existe');
select has_column('public', 'conversations', 'handoff_activity_id', 'conversations.handoff_activity_id existe');

-- 5. Funções (todas SECURITY DEFINER com search_path fixo -- risco #5 do PRD).
select has_function('public', 'resolve_pending_stage_advance', 'resolve_pending_stage_advance existe');
select has_function('public', 'resolve_hitl_decision', 'resolve_hitl_decision existe');
select has_function('public', 'expire_old_pending_advances', 'expire_old_pending_advances existe');
select has_function('public', 'create_template_draft', 'create_template_draft existe');
select has_function('public', 'approve_template_version', 'approve_template_version existe');
select has_function('public', 'open_handoff_sla_event', 'open_handoff_sla_event existe');
select has_function('public', 'close_handoff_sla_event', 'close_handoff_sla_event existe');

-- Query agregada cobre as 7 funções de uma vez (evita repetir 14 blocos
-- quase idênticos); string_agg lista QUAL função falhou, não só um count --
-- assinaturas conferidas contra os `revoke`/`grant` de cada função nas
-- migrations 20260710120000_fase3_hitl_decision_queue_schema.sql e
-- 20260710160000_fase4_template_draft_kind.sql (create_template_draft
-- estendida com p_kind/p_provider_template_name).
select is(
  (
    with target_functions(signature) as (
      values
        ('public.resolve_pending_stage_advance(uuid, text, text, jsonb)'),
        ('public.resolve_hitl_decision(uuid, text, text, timestamptz, jsonb)'),
        ('public.expire_old_pending_advances()'),
        ('public.create_template_draft(uuid, text, text, jsonb, text[], text, text, text)'),
        ('public.approve_template_version(uuid)'),
        ('public.open_handoff_sla_event()'),
        ('public.close_handoff_sla_event()')
    )
    select coalesce(string_agg(tf.signature, ', '), '')
    from target_functions tf
    join pg_proc p on p.oid = tf.signature::regprocedure
    where not p.prosecdef
  ),
  '',
  'todas as 7 funções HITL são SECURITY DEFINER (lista = funções reprovadas)'
);
select is(
  (
    with target_functions(signature) as (
      values
        ('public.resolve_pending_stage_advance(uuid, text, text, jsonb)'),
        ('public.resolve_hitl_decision(uuid, text, text, timestamptz, jsonb)'),
        ('public.expire_old_pending_advances()'),
        ('public.create_template_draft(uuid, text, text, jsonb, text[], text, text, text)'),
        ('public.approve_template_version(uuid)'),
        ('public.open_handoff_sla_event()'),
        ('public.close_handoff_sla_event()')
    )
    select coalesce(string_agg(tf.signature, ', '), '')
    from target_functions tf
    join pg_proc p on p.oid = tf.signature::regprocedure
    where p.proconfig is null
       or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')
  ),
  '',
  'todas as 7 funções HITL têm search_path fixo (lista = funções reprovadas)'
);

-- 6. Triggers (handoff durável).
select has_trigger('public', 'conversations', 'trg_conversations_open_handoff', 'trigger de abertura de handoff existe');
select has_trigger('public', 'messages', 'trg_messages_close_handoff', 'trigger de fechamento de handoff existe');

-- 7. Seed do catálogo de feature-flags (banda de confiança nasce dormente).
select is(
  (select default_enabled from public.ai_feature_catalog where feature_key = 'hitl_stage_advance_banding'),
  false,
  'feature hitl_stage_advance_banding nasce com default_enabled=false (dormente)'
);

select * from finish();
rollback;
