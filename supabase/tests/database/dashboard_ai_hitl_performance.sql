begin;
create extension if not exists pgtap;
select plan(23);

-- Test 1: RPC exists
select ok(
  exists(select 1 from information_schema.routines 
    where routine_name = 'dashboard_ai_hitl_performance'),
  'dashboard_ai_hitl_performance RPC exists'
);

-- Test 2: Test user created
insert into auth.users (id, email) 
values ('00010000-0000-0000-0000-000000000001', 'test-dashboard@test.local');

select ok(
  exists(select 1 from public.profiles where id = '00010000-0000-0000-0000-000000000001'),
  'Test user profile created'
);

-- Authenticate as test user for remaining tests
set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '00010000-0000-0000-0000-000000000001', 'role', 'authenticated')::text,
  true
);

-- Test 3: RPC callable with null filters
select ok(
  (select jsonb_typeof(public.dashboard_ai_hitl_performance(
    '2026-10-10'::timestamp,
    '2026-10-11'::timestamp,
    null,
    null
  )) = 'object'),
  'RPC returns JSON object with null filters'
);

-- O contrato é aditivo: métricas antigas e novas permanecem no mesmo retorno.
select ok(
  public.dashboard_ai_hitl_performance(
    '2026-10-10'::timestamp,
    '2026-10-11'::timestamp,
    null,
    null
  ) ?& array['aguardando_humano','auto_avancos','drafts_aprovados_sem_edicao','drafts_editados',
    'sugestoes_pendentes','avancos_auto_aprovados','avancos_aprovados_humano','avancos_rejeitados',
    'taxa_aprovacao_pct','cobertura_24h_pct'],
  'JSON preserva todas as métricas anteriores e adiciona as métricas da imersão'
);

select ok(
  public.dashboard_ai_hitl_performance(
    '2026-10-10'::timestamp,
    '2026-10-11'::timestamp,
    null,
    null
  ) ? 'taxa_aprovacao_pct',
  'JSON contains taxa_aprovacao_pct field'
);

select ok(
  public.dashboard_ai_hitl_performance(
    '2026-10-10'::timestamp,
    '2026-10-11'::timestamp,
    null,
    null
  ) ? 'avancos_auto_aprovados',
  'JSON contains avancos_auto_aprovados field'
);

-- Test 5: RPC accepts all 4 parameters
select ok(
  (select jsonb_typeof(public.dashboard_ai_hitl_performance(
    '2026-10-10'::timestamp,
    '2026-10-11'::timestamp,
    '00010000-0000-0000-0000-000000000001'::uuid,
    'b0001000-0000-0000-0000-000000000001'::uuid
  )) = 'object'),
  'RPC accepts owner_id and board_id parameters'
);

-- Test 6: Invalid range rejected
reset role;
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '00010000-0000-0000-0000-000000000001', 'role', 'authenticated')::text,
  true
);

select throws_ok(
  $$select public.dashboard_ai_hitl_performance(
    '2026-10-11'::timestamp,
    '2026-10-10'::timestamp,
    null,
    null
  )$$,
  'invalid_range',
  'Rejects invalid date range'
);

-- O modo autonomous aplica o comando sem criar pendência de aprovação.
insert into public.boards(id, tenant_id, name)
select 'b0001000-0000-0000-0000-000000000001', tenant_id, 'Dashboard autônomo'
from public.profiles where id = '00010000-0000-0000-0000-000000000001';
insert into public.board_stages(id, board_id, name, position) values
  ('c0001000-0000-0000-0000-000000000001', 'b0001000-0000-0000-0000-000000000001', 'Origem', 0),
  ('c0001000-0000-0000-0000-000000000002', 'b0001000-0000-0000-0000-000000000001', 'Destino', 1);
update public.stage_transitions
set autonomy_mode = 'autonomous', min_confidence = 0.80,
    requires_human_approval = false, cooldown_minutes = 0
where board_id = 'b0001000-0000-0000-0000-000000000001';
insert into public.deals(id, tenant_id, board_id, stage_id, owner_id, title, status)
select ('d0001000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
  tenant_id, 'b0001000-0000-0000-0000-000000000001',
  'c0001000-0000-0000-0000-000000000001', id, 'Avanço de dashboard ' || n, 'open'
from public.profiles cross join generate_series(1, 2) n
where id = '00010000-0000-0000-0000-000000000001';
insert into public.ai_pending_stage_advances
  (tenant_id, deal_id, current_stage_id, suggested_stage_id, confidence, reason, status)
select tenant_id, id, stage_id, 'c0001000-0000-0000-0000-000000000002',
  0.95, 'Autoaprovação legada', 'auto_approved'
from public.deals where id = 'd0001000-0000-0000-0000-000000000002';

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  public.transition_deal_stage(
    'd0001000-0000-0000-0000-000000000001',
    'c0001000-0000-0000-0000-000000000001',
    'c0001000-0000-0000-0000-000000000002',
    'ai', null, 'Critérios cumpridos', '{}', 0.95, 'dashboard-autonomous'
  ) ->> 'status',
  'accepted',
  'avanço autonomous é aplicado pela RPC real sem aprovação humana'
);
reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00010000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);
select is(
  (public.dashboard_ai_hitl_performance(now() - interval '1 day', now() + interval '1 hour') ->> 'auto_avancos')::int,
  2,
  'auto_avancos soma o autonomous direto e a autoaprovação legada'
);
select is(
  (public.dashboard_ai_hitl_performance(now() - interval '1 day', now() + interval '1 hour') ->> 'avancos_auto_aprovados')::int,
  1,
  'a métrica específica de autoaprovações mantém seu contrato'
);
reset role;

-- O mesmo avanço pode ter comando, histórico e registro legado: conta uma vez.
insert into public.ai_pending_stage_advances
  (tenant_id, deal_id, current_stage_id, suggested_stage_id, confidence, reason, status, transition_command_id)
select tenant_id, deal_id, expected_stage_id, target_stage_id,
  confidence, 'Registro legado do mesmo avanço', 'auto_approved', id
from public.deal_stage_transition_commands
where deal_id = 'd0001000-0000-0000-0000-000000000001';
insert into public.deals(id, tenant_id, board_id, stage_id, owner_id, title, status)
select ('d0001000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
  tenant_id, 'b0001000-0000-0000-0000-000000000001',
  'c0001000-0000-0000-0000-000000000001', id, 'Decisão não automática ' || n, 'open'
from public.profiles cross join generate_series(3, 4) n
where id = '00010000-0000-0000-0000-000000000001';
set local role authenticated;
select is(
  (public.dashboard_ai_hitl_performance(now() - interval '1 day', now() + interval '1 hour') ->> 'auto_avancos')::int,
  2,
  'comando, histórico e autoaprovação vinculada não duplicam o avanço'
);
select is(
  (public.dashboard_ai_hitl_performance(now() - interval '1 day', now() + interval '1 hour',
    '00010000-0000-0000-0000-000000000001', 'b0001000-0000-0000-0000-000000000001') ->> 'auto_avancos')::int,
  2,
  'ambas as origens respeitam o responsável e o quadro selecionados'
);
select is(
  (public.dashboard_ai_hitl_performance(now() - interval '1 day', now() + interval '1 hour',
    null, 'b0001000-0000-0000-0000-000000000002') ->> 'auto_avancos')::int,
  0,
  'outro quadro não recebe avanços das duas origens'
);
select is(
  (public.dashboard_ai_hitl_performance(now() - interval '1 day', now() + interval '1 hour',
    '00010000-0000-0000-0000-000000000002') ->> 'auto_avancos')::int,
  0,
  'outro responsável não recebe avanços das duas origens'
);
select is(
  (public.dashboard_ai_hitl_performance(now() - interval '3 days', now() - interval '1 day') ->> 'auto_avancos')::int,
  0,
  'a janela temporal exclui comandos e autoaprovações posteriores'
);
select is(
  public.transition_deal_stage(
    'd0001000-0000-0000-0000-000000000003',
    'c0001000-0000-0000-0000-000000000001',
    'c0001000-0000-0000-0000-000000000002',
    'human', null, 'Movimento humano', '{}', null, 'dashboard-human'
  ) ->> 'status',
  'accepted',
  'a fixture humana aplica uma transição real'
);
select is(
  (public.dashboard_ai_hitl_performance(now() - interval '1 day', now() + interval '1 hour') ->> 'auto_avancos')::int,
  2,
  'comandos aceitos de humanos não são autoavanços'
);
reset role;
update public.stage_transitions set autonomy_mode = 'shadow'
where board_id = 'b0001000-0000-0000-0000-000000000001';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  public.transition_deal_stage(
    'd0001000-0000-0000-0000-000000000004',
    'c0001000-0000-0000-0000-000000000001',
    'c0001000-0000-0000-0000-000000000002',
    'ai', null, 'Decisão sem aplicação', '{}', 0.95, 'dashboard-shadow'
  ) ->> 'status',
  'shadowed',
  'a fixture shadow registra decisão sem movimentar'
);
reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00010000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);
select is(
  (public.dashboard_ai_hitl_performance(now() - interval '1 day', now() + interval '1 hour') ->> 'auto_avancos')::int,
  2,
  'decisões da IA não aplicadas não são autoavanços'
);
reset role;

-- A data canônica é a do comando; reimportar seu legado não cria outro avanço.
update public.deal_stage_transition_commands
set created_at = now() - interval '2 days'
where deal_id = 'd0001000-0000-0000-0000-000000000001';
set local role authenticated;
select is(
  (public.dashboard_ai_hitl_performance(now() - interval '1 day', now() + interval '1 hour') ->> 'auto_avancos')::int,
  1,
  'autoaprovação vinculada não reconta comando de outra janela'
);
select is(
  (public.dashboard_ai_hitl_performance(now() - interval '3 days', now() - interval '1 day') ->> 'auto_avancos')::int,
  1,
  'o avanço vinculado aparece somente na janela do comando'
);
reset role;
insert into auth.users(id, email)
values ('00010000-0000-0000-0000-000000000002', 'dashboard-outro-tenant@test.local');
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00010000-0000-0000-0000-000000000002","role":"authenticated"}',
  true
);
select is(
  (public.dashboard_ai_hitl_performance(now() - interval '3 days', now() + interval '1 hour') ->> 'auto_avancos')::int,
  0,
  'outro tenant não recebe autoaprovações nem comandos aceitos'
);
reset role;

select finish();
rollback;
