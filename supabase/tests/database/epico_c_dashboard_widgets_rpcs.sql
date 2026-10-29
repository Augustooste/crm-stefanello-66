-- Épico C (Dashboard rico) — pgTAP para os 3 novos RPCs de dashboard:
-- dashboard_wallet_health, dashboard_messaging_performance,
-- dashboard_ai_hitl_performance. Roda contra o shadow DB local
-- (supabase test db --local; pnpm test:db), reaplica todas as migrations
-- do zero -- não toca a DB real do Lovable. NÃO executado neste agente
-- (decisão explícita: múltiplos agentes rodando em paralelo contra a
-- mesma stack local Docker; reset destrutivo do shadow DB ficaria pro
-- agente de verificação final, sozinho -- ver MEMORY.md "Git index race
-- entre agentes paralelos").
begin;
create extension if not exists pgtap;

select plan(27);

-- =============================================================================
-- 1. Rejeição: as 3 funções são bloqueadas para anon (revoke). authenticated
--    TEM grant (diferente de dashboard_report_for_tenant, que é admin-only
--    via /relatorios) -- aqui o alvo é /app, não admin-gated.
-- =============================================================================
set local role anon;
select throws_ok(
  $$select public.dashboard_wallet_health()$$,
  '42501', NULL,
  'anon é bloqueado de executar dashboard_wallet_health'
);
select throws_ok(
  $$select public.dashboard_messaging_performance('2026-07-01T00:00:00Z'::timestamptz, '2026-07-08T00:00:00Z'::timestamptz)$$,
  '42501', NULL,
  'anon é bloqueado de executar dashboard_messaging_performance'
);
select throws_ok(
  $$select public.dashboard_ai_hitl_performance('2026-07-01T00:00:00Z'::timestamptz, '2026-07-08T00:00:00Z'::timestamptz)$$,
  '42501', NULL,
  'anon é bloqueado de executar dashboard_ai_hitl_performance'
);
reset role;

-- =============================================================================
-- 2. Fixtures: 2 tenants (A com 2 profiles/owners, B para provar isolamento),
--    1 board+stage por tenant, 1 channel, contatos, deals, conversas,
--    mensagens e fila HITL.
-- =============================================================================
insert into auth.users (id, email) values
  ('30303030-3030-3030-3030-303030303030', 'admin-a-dashwidgets@test.local'),
  ('40404040-4040-4040-4040-404040404040', 'vendedor-a-dashwidgets@test.local'),
  ('50505050-5050-5050-5050-505050505050', 'admin-b-dashwidgets@test.local');

-- vendedor-a é convidado pro MESMO tenant do admin-a (profiles.tenant_id
-- já existe via handle_new_user; ajustamos pra apontar pro tenant de A).
-- enforce_profile_immutable_fields bloquearia esse UPDATE fora do fluxo de
-- app normal (troca de tenant_id exige private.is_admin() com JWT de sessão);
-- desabilita triggers só pro seeding, mesmo padrão de
-- e2e_workspace_rls_isolation.sql.
SET session_replication_role = replica;
update public.profiles
set tenant_id = (select tenant_id from public.profiles where id = '30303030-3030-3030-3030-303030303030')
where id = '40404040-4040-4040-4040-404040404040';
SET session_replication_role = DEFAULT;

insert into public.boards (tenant_id, name, is_default)
select tenant_id, 'Board A', true from public.profiles where id = '30303030-3030-3030-3030-303030303030';

insert into public.board_stages (board_id, name, position)
select b.id, 'Fechado', 0
from public.boards b
join public.profiles p on p.tenant_id = b.tenant_id
where p.id = '30303030-3030-3030-3030-303030303030';

insert into public.boards (tenant_id, name, is_default)
select tenant_id, 'Board B', true from public.profiles where id = '50505050-5050-5050-5050-505050505050';

insert into public.board_stages (board_id, name, position)
select b.id, 'Fechado', 0
from public.boards b
join public.profiles p on p.tenant_id = b.tenant_id
where p.id = '50505050-5050-5050-5050-505050505050';

insert into public.channels (tenant_id, type, provider_slug, status)
select tenant_id, 'whatsapp', 'meta', 'connected'
from public.profiles where id = '30303030-3030-3030-3030-303030303030';

-- Contato 1 (tenant A, owner = vendedor-a): ativo (mensagem recente),
-- contribui pro LTV via deal won.
insert into public.contacts (id, tenant_id, name, owner_id)
select '60606060-6060-6060-6060-606060606060', tenant_id, 'Contato Ativo A', '40404040-4040-4040-4040-404040404040'
from public.profiles where id = '30303030-3030-3030-3030-303030303030';

-- Contato 2 (tenant A, sem owner): inativo (sem mensagem nenhuma).
insert into public.contacts (id, tenant_id, name)
select '70707070-7070-7070-7070-707070707070', tenant_id, 'Contato Inativo A'
from public.profiles where id = '30303030-3030-3030-3030-303030303030';

-- Contato 3 (tenant B): prova isolamento -- nunca deve aparecer nos
-- resultados de A.
insert into public.contacts (id, tenant_id, name)
select '80808080-8080-8080-8080-808080808080', tenant_id, 'Contato B'
from public.profiles where id = '50505050-5050-5050-5050-505050505050';

-- Deal won do contato ativo (LTV) e deal parado (stagnant, > 10 dias em
-- 'open') do mesmo owner.
insert into public.deals (tenant_id, board_id, stage_id, contact_id, title, value, status, owner_id, stage_entered_at)
select p.tenant_id, b.id, s.id, '60606060-6060-6060-6060-606060606060', 'Negócio ganho', 1500, 'won',
       '40404040-4040-4040-4040-404040404040', now()
from public.profiles p
join public.boards b on b.tenant_id = p.tenant_id
join public.board_stages s on s.board_id = b.id
where p.id = '30303030-3030-3030-3030-303030303030';

insert into public.deals (tenant_id, board_id, stage_id, contact_id, title, value, status, owner_id, stage_entered_at)
select p.tenant_id, b.id, s.id, '70707070-7070-7070-7070-707070707070', 'Negócio parado', 300, 'open',
       '40404040-4040-4040-4040-404040404040', now() - interval '15 days'
from public.profiles p
join public.boards b on b.tenant_id = p.tenant_id
join public.board_stages s on s.board_id = b.id
where p.id = '30303030-3030-3030-3030-303030303030';

-- Conversa + mensagens do contato ativo: 1 'in' seguida de 1 'out' (sender
-- 'agent'), 2 min depois -- prova FRT mediana e taxa_resposta_pct.
-- created_at explícito (2026-07-02, dentro da janela fixa usada nos testes
-- de messaging_performance abaixo): sem isso cai no default now(), fora da
-- janela '2026-07-01'/'2026-07-08' e conversas_total viria 0.
insert into public.conversations (id, tenant_id, contact_id, channel_id, awaiting_human, created_at)
select '90909090-9090-9090-9090-909090909090', p.tenant_id, '60606060-6060-6060-6060-606060606060', ch.id, true, '2026-07-02T09:59:00Z'
from public.profiles p
join public.channels ch on ch.tenant_id = p.tenant_id
where p.id = '30303030-3030-3030-3030-303030303030';

insert into public.messages (tenant_id, conversation_id, direction, sender, content, created_at)
select tenant_id, '90909090-9090-9090-9090-909090909090', 'in', 'contact', 'Oi', '2026-07-02T10:00:00Z'
from public.profiles where id = '30303030-3030-3030-3030-303030303030';

-- close_handoff_sla_event (fase3_hitl_decision_queue_schema.sql) seta
-- awaiting_human=false nesta conversa assim que a mensagem 'out'/agent abaixo
-- é inserida -- comportamento correto de produto, não bug. O teste de
-- ai_hitl.aguardando_humano por isso usa uma SEGUNDA conversa dedicada mais
-- abaixo, que nunca recebe resposta de agente.
insert into public.messages (tenant_id, conversation_id, direction, sender, content, created_at)
select tenant_id, '90909090-9090-9090-9090-909090909090', 'out', 'agent', 'Olá!', '2026-07-02T10:02:00Z'
from public.profiles where id = '30303030-3030-3030-3030-303030303030';

-- Mensagem IA enviada (out) nas últimas 24h, pro cálculo de cobertura_24h_pct
-- e de msgs_ia (janela ampla usada nos testes abaixo precisa começar antes
-- de "agora - 2h" pra incluir esta mensagem).
insert into public.messages (tenant_id, conversation_id, direction, sender, content, created_at)
select tenant_id, '90909090-9090-9090-9090-909090909090', 'out', 'ai', 'Follow-up automático', now() - interval '2 hours'
from public.profiles where id = '30303030-3030-3030-3030-303030303030';

-- Segunda conversa do contato ativo, ainda aguardando humano (sem resposta de
-- agente -- não dispara close_handoff_sla_event) -- é a que
-- ai_hitl.aguardando_humano deve contar.
insert into public.conversations (id, tenant_id, contact_id, channel_id, awaiting_human)
select '91909090-9090-9090-9090-909090909091', p.tenant_id, '60606060-6060-6060-6060-606060606060', ch.id, true
from public.profiles p
join public.channels ch on ch.tenant_id = p.tenant_id
where p.id = '30303030-3030-3030-3030-303030303030';

-- Fila HITL: 1 auto_approved, 1 approved sem edição, 1 approved com edição,
-- todos ligados a deals do owner vendedor-a (via deal 'Negócio ganho').
insert into public.ai_pending_stage_advances
  (tenant_id, deal_id, current_stage_id, suggested_stage_id, confidence, reason, status, user_edits)
select p.tenant_id, d.id, s.id, s.id, 0.9, 'teste', 'auto_approved', null
from public.profiles p
join public.deals d on d.tenant_id = p.tenant_id and d.title = 'Negócio ganho'
join public.board_stages s on s.board_id = d.board_id
where p.id = '30303030-3030-3030-3030-303030303030';

insert into public.ai_pending_stage_advances
  (tenant_id, deal_id, current_stage_id, suggested_stage_id, confidence, reason, status, user_edits)
select p.tenant_id, d.id, s.id, s.id, 0.9, 'teste', 'approved', null
from public.profiles p
join public.deals d on d.tenant_id = p.tenant_id and d.title = 'Negócio ganho'
join public.board_stages s on s.board_id = d.board_id
where p.id = '30303030-3030-3030-3030-303030303030';

insert into public.ai_pending_stage_advances
  (tenant_id, deal_id, current_stage_id, suggested_stage_id, confidence, reason, status, user_edits)
select p.tenant_id, d.id, s.id, s.id, 0.9, 'teste', 'approved', '{"note": "ajustado"}'::jsonb
from public.profiles p
join public.deals d on d.tenant_id = p.tenant_id and d.title = 'Negócio ganho'
join public.board_stages s on s.board_id = d.board_id
where p.id = '30303030-3030-3030-3030-303030303030';

-- Tenant B: 1 conversa aguardando humano -- não deve vazar pro resultado de A.
insert into public.conversations (tenant_id, contact_id, channel_id, awaiting_human)
select p.tenant_id, '80808080-8080-8080-8080-808080808080', ch.id, true
from public.profiles p
join public.channels ch on ch.tenant_id = p.tenant_id
where p.id = '50505050-5050-5050-5050-505050505050';

-- =============================================================================
-- 3. Comportamento -- chamando como authenticated (único role com EXECUTE nas
--    3 funções, confirmado nas migrations: dashboard_wallet_health,
--    dashboard_messaging_performance e dashboard_ai_hitl_performance só
--    concedem grant a authenticated, não a service_role -- v_tenant é
--    resolvido via private.get_user_tenant_id()/get_active_tenant_id(), que
--    exige auth.uid() de uma sessão authenticated real).
-- =============================================================================
select set_config('request.jwt.claims', json_build_object(
  'sub', '30303030-3030-3030-3030-303030303030', 'role', 'authenticated')::text, false);
set local role authenticated;

-- --- dashboard_wallet_health -------------------------------------------------
select is(
  (select (public.dashboard_wallet_health(null, 30, 10) ->> 'contatos_total')::int),
  2,
  'wallet_health.contatos_total = 2 (só tenant A, exclui tenant B)'
);
select is(
  (select (public.dashboard_wallet_health(null, 30, 10) ->> 'contatos_ativos')::int),
  1,
  'wallet_health.contatos_ativos = 1 (contato com mensagem recente)'
);
select is(
  (select (public.dashboard_wallet_health(null, 30, 10) ->> 'contatos_inativos')::int),
  1,
  'wallet_health.contatos_inativos = 1 (contato sem mensagem)'
);
select is(
  (select (public.dashboard_wallet_health(null, 30, 10) ->> 'negocios_parados')::int),
  1,
  'wallet_health.negocios_parados = 1 (deal open há 15 dias > threshold de 10)'
);
select is(
  (select (public.dashboard_wallet_health(null, 30, 10) ->> 'negocios_parados_valor')::numeric),
  300::numeric,
  'wallet_health.negocios_parados_valor = 300'
);
select is(
  (select (public.dashboard_wallet_health(null, 30, 10) ->> 'ltv_medio')::numeric),
  1500::numeric,
  'wallet_health.ltv_medio = 1500 (média dos deals won do contato ativo)'
);
select is(
  (select (public.dashboard_wallet_health('40404040-4040-4040-4040-404040404040'::uuid, 30, 10) ->> 'contatos_total')::int),
  1,
  'wallet_health filtra por p_owner_id: só o contato do vendedor-a'
);
select throws_ok(
  $$select public.dashboard_wallet_health(null, 0, 10)$$,
  'P0001', NULL,
  'wallet_health rejeita p_inactive_days < 1'
);

-- --- dashboard_messaging_performance -----------------------------------------
select is(
  (select (public.dashboard_messaging_performance('2026-07-01T00:00:00Z'::timestamptz, '2026-07-08T00:00:00Z'::timestamptz) ->> 'conversas_total')::int),
  1,
  'messaging_performance.conversas_total = 1 (só tenant A)'
);
select is(
  (select (public.dashboard_messaging_performance('2026-07-01T00:00:00Z'::timestamptz, '2026-07-08T00:00:00Z'::timestamptz) ->> 'frt_mediana_seg')::numeric),
  120::numeric,
  'messaging_performance.frt_mediana_seg = 120 (2 minutos entre in e primeiro out)'
);
select is(
  (select (public.dashboard_messaging_performance('2026-07-01T00:00:00Z'::timestamptz, '2026-07-08T00:00:00Z'::timestamptz) ->> 'taxa_resposta_pct')::numeric),
  100.0::numeric,
  'messaging_performance.taxa_resposta_pct = 100.0'
);
select is(
  (select (public.dashboard_messaging_performance('2026-07-01T00:00:00Z'::timestamptz, '2026-07-08T00:00:00Z'::timestamptz) ->> 'msgs_humano')::int),
  1,
  'messaging_performance.msgs_humano = 1 (sender agent, dentro da janela)'
);
select is(
  (select (public.dashboard_messaging_performance(now() - interval '3 hours', now() + interval '1 day') ->> 'msgs_ia')::int),
  1,
  'messaging_performance.msgs_ia = 1 (mensagem ai enviada nas últimas 2h, dentro da janela ampla)'
);
select is(
  (select (public.dashboard_messaging_performance('2026-07-01T00:00:00Z'::timestamptz, '2026-07-08T00:00:00Z'::timestamptz, '40404040-4040-4040-4040-404040404040'::uuid) ->> 'conversas_total')::int),
  1,
  'messaging_performance filtra por p_owner_id via contacts.owner_id (não sender)'
);
select throws_ok(
  $$select public.dashboard_messaging_performance('2026-07-08T00:00:00Z'::timestamptz, '2026-07-01T00:00:00Z'::timestamptz)$$,
  'P0001', NULL,
  'messaging_performance rejeita p_to <= p_from'
);

-- --- dashboard_ai_hitl_performance --------------------------------------------
select is(
  (select (public.dashboard_ai_hitl_performance(now() - interval '1 day', now() + interval '1 hour') ->> 'aguardando_humano')::int),
  1,
  'ai_hitl.aguardando_humano = 1 (só a conversa awaiting_human de tenant A)'
);
select is(
  (select (public.dashboard_ai_hitl_performance(now() - interval '1 day', now() + interval '1 hour') ->> 'auto_avancos')::int),
  1,
  'ai_hitl.auto_avancos = 1'
);
select is(
  (select (public.dashboard_ai_hitl_performance(now() - interval '1 day', now() + interval '1 hour') ->> 'drafts_aprovados_sem_edicao')::int),
  1,
  'ai_hitl.drafts_aprovados_sem_edicao = 1'
);
select is(
  (select (public.dashboard_ai_hitl_performance(now() - interval '1 day', now() + interval '1 hour') ->> 'drafts_editados')::int),
  1,
  'ai_hitl.drafts_editados = 1'
);
select is(
  (select (public.dashboard_ai_hitl_performance(now() - interval '1 day', now() + interval '1 hour') ->> 'taxa_aprovacao_pct')::numeric),
  100.0::numeric,
  'ai_hitl.taxa_aprovacao_pct = 100.0 (2 approved / 2 approved+rejected; auto_approved não entra no denominador)'
);
select cmp_ok(
  (select (public.dashboard_ai_hitl_performance(now() - interval '1 day', now() + interval '1 hour') ->> 'cobertura_24h_pct')::numeric),
  '>',
  0::numeric,
  'ai_hitl.cobertura_24h_pct > 0 (há 1 hora-bucket com mensagem ai nas últimas 24h)'
);

reset role;

insert into public.ai_pending_stage_advances
  (tenant_id, deal_id, current_stage_id, suggested_stage_id, confidence, reason, status)
select p.tenant_id, d.id, s.id, s.id, 0.9, 'teste de revisão humana', 'rejected'
from public.profiles p
join public.deals d on d.tenant_id = p.tenant_id and d.title = 'Negócio ganho'
join public.board_stages s on s.board_id = d.board_id
where p.id = '30303030-3030-3030-3030-303030303030';
set local role authenticated;
select is(
  (public.dashboard_ai_hitl_performance(now() - interval '1 day', now() + interval '1 hour') ->> 'taxa_aprovacao_pct')::numeric,
  66.7::numeric,
  'taxa mantém contrato humano: 2 aprovações / 3 revisões, sem autoaprovação'
);
reset role;

insert into public.deals (tenant_id, board_id, stage_id, contact_id, title, value, status, owner_id)
select tenant_id, board_id, stage_id, contact_id, 'Segundo negócio do mesmo contato', 200, 'open', owner_id
from public.deals where contact_id='60606060-6060-6060-6060-606060606060' and title='Negócio ganho';
set local role authenticated;
select is(
  (public.dashboard_ai_hitl_performance(now() - interval '1 day', now() + interval '1 hour') ->> 'aguardando_humano')::int,
  1,
  'uma conversa aguardando humano com dois negócios conta uma vez sem filtro de quadro'
);
select is(
  (public.dashboard_ai_hitl_performance(now() - interval '1 day', now() + interval '1 hour', null,
    (select board_id from public.deals where contact_id='60606060-6060-6060-6060-606060606060' and title='Negócio ganho')
  ) ->> 'aguardando_humano')::int,
  1,
  'uma conversa aguardando humano com dois negócios conta uma vez no quadro selecionado'
);
reset role;

select * from finish();
rollback;
