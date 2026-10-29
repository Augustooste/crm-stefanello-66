begin;
create extension if not exists pgtap;
select plan(20);

insert into auth.users (id, email)
values ('a1000000-0000-0000-0000-000000000001', 'pipeline-admin@test.local');

insert into public.boards (id, tenant_id, name, is_default)
select
  'b1000000-0000-0000-0000-000000000001',
  tenant_id,
  'Pipeline autônomo',
  true
from public.profiles
where id = 'a1000000-0000-0000-0000-000000000001';

insert into public.board_stages (id, board_id, name, position)
values
  ('c1000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001', 'Novo', 0),
  ('c1000000-0000-0000-0000-000000000002', 'b1000000-0000-0000-0000-000000000001', 'Qualificado', 1),
  ('c1000000-0000-0000-0000-000000000003', 'b1000000-0000-0000-0000-000000000001', 'Reunião', 2),
  ('c1000000-0000-0000-0000-000000000004', 'b1000000-0000-0000-0000-000000000001', 'Proposta', 3),
  ('c1000000-0000-0000-0000-000000000005', 'b1000000-0000-0000-0000-000000000001', 'Fechamento', 4);

insert into public.deals (
  id, tenant_id, board_id, stage_id, title, status
)
select
  'd1000000-0000-0000-0000-000000000001',
  tenant_id,
  'b1000000-0000-0000-0000-000000000001',
  'c1000000-0000-0000-0000-000000000001',
  'Negócio sob política',
  'open'
from public.profiles
where id = 'a1000000-0000-0000-0000-000000000001';

set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', 'a1000000-0000-0000-0000-000000000001',
    'role', 'authenticated'
  )::text,
  true
);

select throws_ok(
  $$update public.deals
      set stage_id = 'c1000000-0000-0000-0000-000000000002'
      where id = 'd1000000-0000-0000-0000-000000000001'$$,
  '42501',
  'Deal stage changes must use transition_deal_stage()',
  'update direto de stage_id é bloqueado'
);

select is(
  (
    public.transition_deal_stage(
      'd1000000-0000-0000-0000-000000000001',
      'c1000000-0000-0000-0000-000000000001',
      'c1000000-0000-0000-0000-000000000002',
      'human',
      null,
      'Qualificação confirmada pelo operador',
      '{"source":"pgtap"}',
      null,
      'human-move-1'
    ) ->> 'status'
  ),
  'accepted',
  'movimento humano usa o comando único'
);

select is(
  (
    select stage_id
    from public.deals
    where id = 'd1000000-0000-0000-0000-000000000001'
  ),
  'c1000000-0000-0000-0000-000000000002'::uuid,
  'RPC move o negócio atomicamente'
);

select ok(
  exists (
    select 1
    from public.deal_stage_history
    where deal_id = 'd1000000-0000-0000-0000-000000000001'
      and actor_type = 'human'
      and reason = 'Qualificação confirmada pelo operador'
      and idempotency_key = 'human-move-1'
  ),
  'histórico guarda ator, motivo e idempotência'
);

select is(
  (
    public.transition_deal_stage(
      'd1000000-0000-0000-0000-000000000001',
      'c1000000-0000-0000-0000-000000000001',
      'c1000000-0000-0000-0000-000000000002',
      'human',
      null,
      'Replay',
      '{}',
      null,
      'human-move-1'
    ) ->> 'idempotentReplay'
  )::boolean,
  true,
  'replay devolve o resultado original'
);

select is(
  (
    select count(*)::integer
    from public.deal_stage_history
    where deal_id = 'd1000000-0000-0000-0000-000000000001'
  ),
  1,
  'replay não duplica histórico'
);

select is(
  (
    public.get_pipeline_automation_metrics(
      'b1000000-0000-0000-0000-000000000001'
    ) ->> 'humanMoves'
  )::integer,
  1,
  'métricas agregam comandos sem ambiguidade de colunas'
);

reset role;
set local role service_role;
select set_config(
  'request.jwt.claims',
  json_build_object('role', 'service_role')::text,
  true
);

select is(
  (
    public.transition_deal_stage(
      'd1000000-0000-0000-0000-000000000001',
      'c1000000-0000-0000-0000-000000000002',
      'c1000000-0000-0000-0000-000000000003',
      'ai',
      null,
      'Avaliação positiva',
      '{"signals":{}}',
      0.95,
      'ai-manual-rule'
    ) ->> 'status'
  ),
  'recommended',
  'autonomia nasce desligada e apenas recomenda'
);

update public.stage_transitions
set autonomy_mode = 'assisted',
    requires_human_approval = true,
    min_confidence = 0.80
where from_stage_id = 'c1000000-0000-0000-0000-000000000002'
  and to_stage_id = 'c1000000-0000-0000-0000-000000000003';

select is(
  (
    public.transition_deal_stage(
      'd1000000-0000-0000-0000-000000000001',
      'c1000000-0000-0000-0000-000000000002',
      'c1000000-0000-0000-0000-000000000003',
      'ai',
      null,
      'Critérios cumpridos',
      '{"signals":{}}',
      0.95,
      'ai-assisted-rule'
    ) ->> 'status'
  ),
  'queued',
  'modo assistido cria aprovação'
);

select is(
  (
    select count(*)::integer
    from public.ai_pending_stage_advances
    where deal_id = 'd1000000-0000-0000-0000-000000000001'
      and status = 'pending'
  ),
  1,
  'fila mantém uma pendência por negócio'
);

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', 'a1000000-0000-0000-0000-000000000001',
    'role', 'authenticated'
  )::text,
  true
);

select is(
  (
    public.resolve_pending_stage_advance(
      (
        select id
        from public.ai_pending_stage_advances
        where deal_id = 'd1000000-0000-0000-0000-000000000001'
          and status = 'pending'
      ),
      'approve'
    ) ->> 'status'
  ),
  'approved',
  'aprovação HITL também passa pelo comando único'
);

reset role;
set local role service_role;
select set_config(
  'request.jwt.claims',
  json_build_object('role', 'service_role')::text,
  true
);

update public.stage_transitions
set autonomy_mode = 'autonomous',
    requires_human_approval = false,
    min_confidence = 0.80,
    required_signals = '{"payment.approved":true}',
    cooldown_minutes = 0
where from_stage_id = 'c1000000-0000-0000-0000-000000000003'
  and to_stage_id = 'c1000000-0000-0000-0000-000000000004';

update public.boards
set automation_mode = 'autonomous'
where id = 'b1000000-0000-0000-0000-000000000001';

select is(
  (
    public.transition_deal_stage(
      'd1000000-0000-0000-0000-000000000001',
      'c1000000-0000-0000-0000-000000000003',
      'c1000000-0000-0000-0000-000000000004',
      'ai',
      null,
      'Pagamento ainda não confirmado',
      '{"signals":{"payment":{"approved":false}}}',
      0.95,
      'ai-missing-signal'
    ) ->> 'reason'
  ),
  'required_signals_missing',
  'policy engine bloqueia sinal estruturado ausente'
);

select is(
  (
    public.transition_deal_stage(
      'd1000000-0000-0000-0000-000000000001',
      'c1000000-0000-0000-0000-000000000003',
      'c1000000-0000-0000-0000-000000000004',
      'ai',
      null,
      'Pagamento aprovado',
      '{"signals":{"payment":{"approved":true}}}',
      0.95,
      'ai-valid-signal'
    ) ->> 'status'
  ),
  'accepted',
  'modo autônomo move quando a política está satisfeita'
);

select is(
  (
    select ai_transition_count_24h
    from public.deals
    where id = 'd1000000-0000-0000-0000-000000000001'
  ),
  1,
  'circuit breaker mantém contador diário'
);

update public.stage_transitions
set autonomy_mode = 'autonomous',
    requires_human_approval = false,
    min_confidence = 0.80,
    required_signals = '{}'::jsonb,
    cooldown_minutes = 0
where from_stage_id = 'c1000000-0000-0000-0000-000000000004'
  and to_stage_id = 'c1000000-0000-0000-0000-000000000005';

select is(
  (
    public.transition_deal_stage(
      'd1000000-0000-0000-0000-000000000001',
      'c1000000-0000-0000-0000-000000000004',
      'c1000000-0000-0000-0000-000000000005',
      'ai',
      null,
      'Retry do mesmo evento após ack falhar',
      '{"signals":{"retry":true}}',
      0.95,
      'ai-valid-signal'
    ) ->> 'idempotentReplay'
  )::boolean,
  true,
  'retry do mesmo evento reutiliza a primeira decisão'
);

select is(
  (
    select stage_id
    from public.deals
    where id = 'd1000000-0000-0000-0000-000000000001'
  ),
  'c1000000-0000-0000-0000-000000000004'::uuid,
  'retry do mesmo evento não avança uma segunda etapa'
);

select is(
  (
    select count(*)::integer
    from public.deal_stage_history
    where deal_id = 'd1000000-0000-0000-0000-000000000001'
  ),
  3,
  'retry do mesmo evento não duplica o histórico'
);

select is(
  (
    public.transition_deal_stage(
      'd1000000-0000-0000-0000-000000000001',
      'c1000000-0000-0000-0000-000000000004',
      'c1000000-0000-0000-0000-000000000005',
      'ai',
      null,
      'Evento novo permite o próximo avanço',
      '{"signals":{"next_event":true}}',
      0.95,
      'ai-next-event'
    ) ->> 'status'
  ),
  'accepted',
  'evento novo pode avançar a próxima etapa'
);

select is(
  (
    select stage_id
    from public.deals
    where id = 'd1000000-0000-0000-0000-000000000001'
  ),
  'c1000000-0000-0000-0000-000000000005'::uuid,
  'evento novo conclui exatamente o próximo avanço'
);

select ok(
  exists (
    select 1
    from public.domain_event_subscriptions
    where subscriber_id = 'pipeline.agent'
      and event_types @> array['message.received', 'payment.approved', 'deal.stagnant']
  ),
  'agente independente assina eventos multissinal'
);

select * from finish();
rollback;
