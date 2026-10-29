-- Campanhas nativas (20260925150000): RLS admin-only com template/canal do mesmo
-- tenant, estimativa de audiência (filtro vazio nunca é "todos") e contadores.
begin;
create extension if not exists pgtap;

select plan(20);

-- Fixture: admin A, admin B (tenants distintos) e agente (não-admin) no tenant A.
insert into auth.users (id, email) values
  ('e1111111-1111-4111-8111-111111111111', 'campanha-admin-a@test.local'),
  ('e2222222-2222-4222-8222-222222222222', 'campanha-admin-b@test.local');

insert into public.invites (tenant_id, email, role, token, expires_at)
select tenant_id, 'campanha-agent-a@test.local', 'agent', 'campanha-agent-token', now() + interval '1 day'
from public.profiles where id = 'e1111111-1111-4111-8111-111111111111';
insert into auth.users (id, email, raw_user_meta_data) values
  ('e3333333-3333-4333-8333-333333333333', 'campanha-agent-a@test.local',
   '{"invite_token":"campanha-agent-token"}');

create temp table fx on commit drop as
select
  (select tenant_id from public.profiles where id = 'e1111111-1111-4111-8111-111111111111') as tenant_a,
  (select tenant_id from public.profiles where id = 'e2222222-2222-4222-8222-222222222222') as tenant_b;
grant select on fx to authenticated;

insert into public.messaging_templates (id, tenant_id, name, body, is_draft, status)
select 'f1111111-1111-4111-8111-111111111111', tenant_a, 'tpl-a', 'Oi', false, 'approved' from fx;
insert into public.messaging_templates (id, tenant_id, name, body, is_draft, status)
select 'f2222222-2222-4222-8222-222222222222', tenant_b, 'tpl-b', 'Oi', false, 'approved' from fx;
insert into public.messaging_templates (id, tenant_id, name, body, is_draft, status)
select 'f3333333-3333-4333-8333-333333333333', tenant_a, 'tpl-a-rascunho', 'Oi', true, 'pending' from fx;

insert into public.channels (id, tenant_id, type, provider_slug)
select 'a1111111-1111-4111-8111-111111111111', tenant_a, 'whatsapp', 'evolution' from fx;
insert into public.channels (id, tenant_id, type, provider_slug)
select 'a2222222-2222-4222-8222-222222222222', tenant_b, 'whatsapp', 'evolution' from fx;

insert into public.boards (id, tenant_id, name, is_default)
select 'b1111111-1111-4111-8111-111111111111', tenant_a, 'Funil', false from fx;
insert into public.board_stages (id, board_id, name, position) values
  ('c1111111-1111-4111-8111-111111111111', 'b1111111-1111-4111-8111-111111111111', 'Perdido', 0);

-- Contatos do tenant A: vip (2, um deletado), frio (1). Tenant B: vip (1).
insert into public.contacts (id, tenant_id, name, tags, custom_fields)
select 'd1111111-1111-4111-8111-111111111111', tenant_a, 'Vip 1', array['vip'], '{"plano":"ouro"}'::jsonb from fx;
insert into public.contacts (id, tenant_id, name, tags, deleted_at)
select 'd2222222-2222-4222-8222-222222222222', tenant_a, 'Vip deletado', array['vip'], now() from fx;
insert into public.contacts (id, tenant_id, name, tags)
select 'd3333333-3333-4333-8333-333333333333', tenant_a, 'Frio', array['frio'] from fx;
insert into public.contacts (id, tenant_id, name, tags)
select 'd4444444-4444-4444-8444-444444444444', tenant_b, 'Vip B', array['vip'] from fx;

insert into public.deals (tenant_id, board_id, stage_id, contact_id, title, status)
select tenant_a, 'b1111111-1111-4111-8111-111111111111', 'c1111111-1111-4111-8111-111111111111',
       'd3333333-3333-4333-8333-333333333333', 'Negócio frio', 'lost' from fx;
insert into public.deals (tenant_id, board_id, stage_id, contact_id, title, status)
select tenant_a, 'b1111111-1111-4111-8111-111111111111', 'c1111111-1111-4111-8111-111111111111',
       'd2222222-2222-4222-8222-222222222222', 'Negócio de deletado', 'lost' from fx;

-- Estrutura -------------------------------------------------------------------
select has_column('public', 'template_schedules', 'name', 'template_schedules.name existe');
select has_column('public', 'template_schedules', 'channel_id', 'template_schedules.channel_id existe');
select has_index('public', 'template_schedule_executions', 'tse_schedule_contact_uniq',
  'índice único (schedule_id, contact_id) contra envio em dobro');
select ok(
  not has_function_privilege('anon', 'public.estimate_campaign_audience(jsonb)', 'EXECUTE'),
  'anon não estima audiência'
);
select ok(
  not has_function_privilege('anon', 'public.campaign_execution_stats(uuid[])', 'EXECUTE'),
  'anon não lê contadores'
);

-- Admin A ---------------------------------------------------------------------
select set_config('request.jwt.claims',
  json_build_object('sub', 'e1111111-1111-4111-8111-111111111111', 'role', 'authenticated')::text, true);
set local role authenticated;

select is(public.estimate_campaign_audience('{}'::jsonb), 0, 'filtro vazio estima 0, nunca todos');
select is(public.estimate_campaign_audience('{"foo":"bar"}'::jsonb), 0, 'só chave desconhecida estima 0');
select is(public.estimate_campaign_audience('{"tags":[]}'::jsonb), 0, 'lista de tags vazia estima 0');
select is(public.estimate_campaign_audience('{"tags":["vip"]}'::jsonb), 1,
  'tags: conta só contato ativo do próprio tenant (deletado e tenant B fora)');
select is(public.estimate_campaign_audience('{"stage_id":"c1111111-1111-4111-8111-111111111111"}'::jsonb), 1,
  'estágio: conta via deals, contato deletado fora');
select is(public.estimate_campaign_audience('{"tags":["vip"],"stage_id":"c1111111-1111-4111-8111-111111111111"}'::jsonb), 0,
  'tags + estágio: interseção (AND)');
select is(public.estimate_campaign_audience('{"custom_field":{"plano":"ouro"}}'::jsonb), 1,
  'campo personalizado: containment');

select lives_ok(
  $$insert into public.template_schedules (tenant_id, template_id, channel_id, name, audience_filter, scheduled_for)
    select tenant_a, 'f1111111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
           'Reativação', '{"tags":["vip"]}'::jsonb, now() + interval '1 hour' from fx$$,
  'admin cria campanha com template aprovado e canal do próprio tenant'
);
select throws_ok(
  $$insert into public.template_schedules (tenant_id, template_id, channel_id, scheduled_for)
    select tenant_a, 'f2222222-2222-4222-8222-222222222222', 'a1111111-1111-4111-8111-111111111111', now() from fx$$,
  '42501', null, 'template de outro tenant é recusado'
);
select throws_ok(
  $$insert into public.template_schedules (tenant_id, template_id, channel_id, scheduled_for)
    select tenant_a, 'f1111111-1111-4111-8111-111111111111', 'a2222222-2222-4222-8222-222222222222', now() from fx$$,
  '42501', null, 'canal de outro tenant é recusado'
);
select throws_ok(
  $$insert into public.template_schedules (tenant_id, template_id, channel_id, scheduled_for)
    select tenant_a, 'f3333333-3333-4333-8333-333333333333', 'a1111111-1111-4111-8111-111111111111', now() from fx$$,
  '42501', null, 'rascunho não aprovado é recusado'
);
select throws_ok(
  $$insert into public.template_schedules (tenant_id, template_id, channel_id, scheduled_for, status)
    select tenant_a, 'f1111111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111', now(), 'running' from fx$$,
  '42501', null, 'campanha não nasce fora de pending'
);
reset role;

-- Contadores agregados, escopados por RLS --------------------------------------
insert into public.template_schedule_executions (schedule_id, contact_id, scheduled_for, status)
select ts.id, 'd1111111-1111-4111-8111-111111111111', now(), 'sent'
from public.template_schedules ts where ts.name = 'Reativação';

select set_config('request.jwt.claims',
  json_build_object('sub', 'e2222222-2222-4222-8222-222222222222', 'role', 'authenticated')::text, true);
set local role authenticated;
select is(
  (select count(*)::int from public.campaign_execution_stats(
     array(select id from public.template_schedules))),
  0,
  'admin B não vê contadores da campanha do tenant A'
);
reset role;

-- Agente (não-admin) do tenant A -----------------------------------------------
select set_config('request.jwt.claims',
  json_build_object('sub', 'e3333333-3333-4333-8333-333333333333', 'role', 'authenticated')::text, true);
set local role authenticated;
select throws_ok(
  $$select public.estimate_campaign_audience('{"tags":["vip"]}'::jsonb)$$,
  '42501', null, 'não-admin não estima audiência'
);
select throws_ok(
  $$insert into public.template_schedules (tenant_id, template_id, channel_id, scheduled_for)
    select tenant_a, 'f1111111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111', now() from fx$$,
  '42501', null, 'não-admin não cria campanha pela API'
);
reset role;

select * from finish();
rollback;
