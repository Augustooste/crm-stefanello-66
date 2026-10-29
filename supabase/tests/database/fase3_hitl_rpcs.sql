-- Fase 3 HITL — comportamento das RPCs de resolução (resolve_pending_stage_advance,
-- resolve_hitl_decision, expire_old_pending_advances). Rodar: pnpm test:db.
begin;
create extension if not exists pgtap;

select plan(32);

-- Fixture: 2 tenants (A = sob teste, B = só pra teste de isolamento).
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'admin-a@test.local'),
  ('22222222-2222-2222-2222-222222222222', 'admin-b@test.local');

-- Fixture: convite + usuário não-admin (role='agent') no MESMO tenant do
-- admin A. handle_new_user (versão final, migration 20260706120229) exige
-- invites.token == raw_user_meta_data->>'invite_token' -- só bater o email
-- não é suficiente.
insert into public.invites (tenant_id, email, role, token)
select tenant_id, 'agent-a@test.local', 'agent', 'test-invite-token-fixed'
from public.profiles where id = '11111111-1111-1111-1111-111111111111';

insert into auth.users (id, email, raw_user_meta_data) values
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'agent-a@test.local',
   jsonb_build_object('invite_token', 'test-invite-token-fixed'));

-- Fixture: board + 2 estágios + contato + deal no tenant A.
insert into public.boards (id, tenant_id, name, is_default)
select '33333333-3333-3333-3333-333333333333', tenant_id, 'Board teste', true
from public.profiles where id = '11111111-1111-1111-1111-111111111111';

insert into public.board_stages (id, board_id, name, position) values
  ('44444444-4444-4444-4444-444444444444', '33333333-3333-3333-3333-333333333333', 'Estágio 1', 0),
  ('55555555-5555-5555-5555-555555555555', '33333333-3333-3333-3333-333333333333', 'Estágio 2', 1);

insert into public.contacts (id, tenant_id, name)
select '66666666-6666-6666-6666-666666666666', tenant_id, 'Contato teste'
from public.profiles where id = '11111111-1111-1111-1111-111111111111';

insert into public.deals (id, tenant_id, board_id, stage_id, contact_id, title)
select '77777777-7777-7777-7777-777777777777', tenant_id, '33333333-3333-3333-3333-333333333333',
  '44444444-4444-4444-4444-444444444444', '66666666-6666-6666-6666-666666666666', 'Deal teste'
from public.profiles where id = '11111111-1111-1111-1111-111111111111';

-- =============================================================================
-- create_template_draft / approve_template_version -- governança de
-- templates (não depende de deal/board, fixtures próprios).
-- =============================================================================

create temp table tmp_template_ids (key text primary key, id uuid);

select set_config(
  'request.jwt.claims',
  json_build_object('sub', '11111111-1111-1111-1111-111111111111', 'role', 'authenticated')::text,
  false
);

-- 1. admin cria draft com sucesso: is_draft=true, status='pending',
--    created_by = quem criou.
insert into tmp_template_ids
select 'draft_v1',
  (public.create_template_draft(null, 'Template teste', 'Olá {{nome}}, tudo bem?') ->> 'id')::uuid;

select is(
  (select is_draft from public.messaging_templates where id = (select id from tmp_template_ids where key = 'draft_v1')),
  true,
  'create_template_draft: cria com is_draft=true'
);
select is(
  (select status from public.messaging_templates where id = (select id from tmp_template_ids where key = 'draft_v1')),
  'pending',
  'create_template_draft: status inicial = pending'
);
select is(
  (select created_by from public.messaging_templates where id = (select id from tmp_template_ids where key = 'draft_v1')),
  '11111111-1111-1111-1111-111111111111'::uuid,
  'create_template_draft: created_by = quem criou'
);

-- 2. não-admin (role agent, mesmo tenant) é bloqueado tanto em
--    create_template_draft quanto em approve_template_version.
select set_config(
  'request.jwt.claims',
  json_build_object('sub', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'role', 'authenticated')::text,
  false
);
select throws_ok(
  $$ select public.create_template_draft(null, 'Template não-admin', 'corpo') $$,
  'Unauthorized',
  'create_template_draft: não-admin (role agent) é bloqueado'
);
select throws_ok(
  $$ select public.approve_template_version((select id from tmp_template_ids where key = 'draft_v1')) $$,
  'Unauthorized',
  'approve_template_version: não-admin (role agent) é bloqueado'
);

-- 3. aprovar o draft via approve_template_version seta is_draft=false,
--    status='approved', approved_by e approved_at.
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '11111111-1111-1111-1111-111111111111', 'role', 'authenticated')::text,
  false
);
select public.approve_template_version((select id from tmp_template_ids where key = 'draft_v1'));

select is(
  (select is_draft from public.messaging_templates where id = (select id from tmp_template_ids where key = 'draft_v1')),
  false,
  'approve_template_version: seta is_draft=false'
);
select is(
  (select status from public.messaging_templates where id = (select id from tmp_template_ids where key = 'draft_v1')),
  'approved',
  'approve_template_version: seta status=approved'
);
select is(
  (select approved_by from public.messaging_templates where id = (select id from tmp_template_ids where key = 'draft_v1')),
  '11111111-1111-1111-1111-111111111111'::uuid,
  'approve_template_version: seta approved_by'
);
select ok(
  (select approved_at is not null from public.messaging_templates where id = (select id from tmp_template_ids where key = 'draft_v1')),
  'approve_template_version: seta approved_at'
);

-- 4. admin de OUTRO tenant tentando aprovar um template que não é dele é
--    bloqueado (cross-tenant) -- mesmo já estando aprovado, o guard de
--    tenant dispara antes de qualquer checagem de status.
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '22222222-2222-2222-2222-222222222222', 'role', 'authenticated')::text,
  false
);
select throws_ok(
  $$ select public.approve_template_version((select id from tmp_template_ids where key = 'draft_v1')) $$,
  'Unauthorized',
  'approve_template_version: admin de outro tenant é bloqueado (cross-tenant)'
);

-- 5. nova versão (p_parent_id apontando pro draft já aprovado) incrementa
--    version = parent.version + 1 e referencia o parent_id correto.
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '11111111-1111-1111-1111-111111111111', 'role', 'authenticated')::text,
  false
);
insert into tmp_template_ids
select 'draft_v2',
  (public.create_template_draft(
    (select id from tmp_template_ids where key = 'draft_v1'), 'Template teste', 'Olá {{nome}}, novidade!'
  ) ->> 'id')::uuid;

select is(
  (select version from public.messaging_templates where id = (select id from tmp_template_ids where key = 'draft_v2')),
  2,
  'create_template_draft: nova versão = parent.version + 1'
);
select is(
  (select parent_id from public.messaging_templates where id = (select id from tmp_template_ids where key = 'draft_v2')),
  (select id from tmp_template_ids where key = 'draft_v1'),
  'create_template_draft: nova versão referencia parent_id correto'
);

-- =============================================================================
-- resolve_pending_stage_advance
-- =============================================================================

insert into public.ai_pending_stage_advances (
  id, tenant_id, deal_id, current_stage_id, suggested_stage_id, confidence, reason
)
select '88888888-8888-8888-8888-888888888888', tenant_id, '77777777-7777-7777-7777-777777777777',
  '44444444-4444-4444-4444-444444444444', '55555555-5555-5555-5555-555555555555', 0.6, 'teste'
from public.profiles where id = '11111111-1111-1111-1111-111111111111';

select set_config(
  'request.jwt.claims',
  json_build_object('sub', '11111111-1111-1111-1111-111111111111', 'role', 'authenticated')::text,
  false
);

-- 1. reject sem motivo lança exceção.
select throws_ok(
  $$ select public.resolve_pending_stage_advance('88888888-8888-8888-8888-888888888888', 'reject', null, null) $$,
  'reject_reason obrigatório',
  'resolve_pending_stage_advance: reject sem motivo lança exceção'
);

-- 2. admin de OUTRO tenant não consegue resolver (Unauthorized).
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '22222222-2222-2222-2222-222222222222', 'role', 'authenticated')::text,
  false
);
select throws_ok(
  $$ select public.resolve_pending_stage_advance('88888888-8888-8888-8888-888888888888', 'approve', null, null) $$,
  'Unauthorized',
  'resolve_pending_stage_advance: admin de outro tenant recebe Unauthorized'
);

-- 3. approve válido: move deals.stage_id + grava 1 linha de auditoria.
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '11111111-1111-1111-1111-111111111111', 'role', 'authenticated')::text,
  false
);
select public.resolve_pending_stage_advance('88888888-8888-8888-8888-888888888888', 'approve', null, null);

select is(
  (select stage_id from public.deals where id = '77777777-7777-7777-7777-777777777777'),
  '55555555-5555-5555-5555-555555555555'::uuid,
  'approve move deals.stage_id pro estágio sugerido'
);
select is(
  (select status from public.ai_pending_stage_advances where id = '88888888-8888-8888-8888-888888888888'),
  'approved',
  'approve marca ai_pending_stage_advances.status = approved'
);
select is(
  (select count(*)::int from public.hitl_audit_log
    where subject_type = 'stage_advance' and subject_id = '88888888-8888-8888-8888-888888888888'
    and event = 'approved' and previous_status = 'pending' and new_status = 'approved'),
  1,
  'approve grava exatamente 1 linha de auditoria (created pela RPC de resolução)'
);

-- 4. approve de novo (já resolvida) lança exceção.
select throws_ok(
  $$ select public.resolve_pending_stage_advance('88888888-8888-8888-8888-888888888888', 'approve', null, null) $$,
  'Already resolved',
  'resolve_pending_stage_advance: resolver 2x a mesma pendência lança exceção'
);

-- 5. approve com current_stage_id obsoleto (deal já mudou de estágio por
--    outro caminho) lança "recarregue" -- guarda otimista contra corrida.
insert into public.ai_pending_stage_advances (
  id, tenant_id, deal_id, current_stage_id, suggested_stage_id, confidence, reason
)
select '99999999-9999-9999-9999-999999999999', tenant_id, '77777777-7777-7777-7777-777777777777',
  '44444444-4444-4444-4444-444444444444', -- estágio antigo, deal já não está mais aqui
  '55555555-5555-5555-5555-555555555555', 0.6, 'teste corrida'
from public.profiles where id = '11111111-1111-1111-1111-111111111111';

select throws_ok(
  $$ select public.resolve_pending_stage_advance('99999999-9999-9999-9999-999999999999', 'approve', null, null) $$,
  'Deal stage mudou desde a sugestão -- recarregue',
  'resolve_pending_stage_advance: guarda otimista pega corrida de stage_id'
);

-- 6. p_action inválido lança exceção -- checagem roda ANTES de buscar a
--    linha, então um id inexistente não muda o comportamento.
select throws_ok(
  $$ select public.resolve_pending_stage_advance('00000000-0000-0000-0000-000000000000', 'bogus', null, null) $$,
  'Invalid action: must be approve or reject',
  'resolve_pending_stage_advance: p_action inválido lança exceção'
);

-- =============================================================================
-- resolve_hitl_decision
-- =============================================================================

insert into public.hitl_decisions (id, tenant_id, type, priority, category, title, status, snooze_until)
select 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', tenant_id, 'test', 'medium', 'routine', 'decisão pendente', 'pending', null
from public.profiles where id = '11111111-1111-1111-1111-111111111111';

insert into public.hitl_decisions (id, tenant_id, type, priority, category, title, status, snooze_until)
select 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', tenant_id, 'test', 'medium', 'routine', 'decisão snoozed vencida', 'snoozed', now() - interval '1 hour'
from public.profiles where id = '11111111-1111-1111-1111-111111111111';

insert into public.hitl_decisions (id, tenant_id, type, priority, category, title, status, snooze_until)
select 'cccccccc-cccc-cccc-cccc-cccccccccccc', tenant_id, 'test', 'medium', 'routine', 'decisão snoozed futura', 'snoozed', now() + interval '1 hour'
from public.profiles where id = '11111111-1111-1111-1111-111111111111';

-- 6. reject sem motivo lança exceção.
select throws_ok(
  $$ select public.resolve_hitl_decision('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'reject', null, null, null) $$,
  'reject_reason obrigatório',
  'resolve_hitl_decision: reject sem motivo lança exceção'
);

-- 7. snoozed com prazo NO FUTURO continua bloqueado.
select throws_ok(
  $$ select public.resolve_hitl_decision('cccccccc-cccc-cccc-cccc-cccccccccccc', 'approve', null, null, null) $$,
  'Already resolved',
  'resolve_hitl_decision: snooze ainda no futuro continua bloqueado'
);

-- 8. snoozed VENCIDO reativa (fix de review: round-trip do snooze) e
--    previous_status na auditoria reflete o estado real ('snoozed', não o
--    literal 'pending' hardcoded -- fix de review).
select public.resolve_hitl_decision('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'approve', null, null, null);
select is(
  (select status from public.hitl_decisions where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  'approved',
  'resolve_hitl_decision: snooze vencido é resolvido com sucesso (reativação)'
);
select is(
  (select previous_status from public.hitl_audit_log
    where subject_type = 'decision' and subject_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    order by created_at desc limit 1),
  'snoozed',
  'resolve_hitl_decision: auditoria grava previous_status=snoozed (não o literal pending)'
);

-- 9. p_action inválido lança exceção -- mesma checagem antecipada de
--    resolve_pending_stage_advance.
select throws_ok(
  $$ select public.resolve_hitl_decision('00000000-0000-0000-0000-000000000000', 'bogus', null, null, null) $$,
  'Invalid action: must be approve, reject or snooze',
  'resolve_hitl_decision: p_action inválido lança exceção'
);

-- 10. ação 'snooze' de ponta a ponta: decisão 'pending' vira 'snoozed', com
--     snooze_until gravado e decided_at/decided_by MANTIDOS null -- ninguém
--     "decidiu" ainda, só adiou.
insert into public.hitl_decisions (id, tenant_id, type, priority, category, title, status, snooze_until)
select 'ffffffff-ffff-ffff-ffff-ffffffffffff', tenant_id, 'test', 'medium', 'routine', 'decisão pra snoozear', 'pending', null
from public.profiles where id = '11111111-1111-1111-1111-111111111111';

select public.resolve_hitl_decision(
  'ffffffff-ffff-ffff-ffff-ffffffffffff', 'snooze', null, '2027-01-01 00:00:00+00'::timestamptz, null
);

select is(
  (select status from public.hitl_decisions where id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'),
  'snoozed',
  'resolve_hitl_decision: snooze de uma pending seta status=snoozed'
);
select is(
  (select snooze_until from public.hitl_decisions where id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'),
  '2027-01-01 00:00:00+00'::timestamptz,
  'resolve_hitl_decision: snooze grava snooze_until com o valor informado'
);
select is(
  (select decided_at from public.hitl_decisions where id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'),
  null,
  'resolve_hitl_decision: snooze mantém decided_at null'
);
select is(
  (select decided_by from public.hitl_decisions where id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'),
  null,
  'resolve_hitl_decision: snooze mantém decided_by null'
);

-- 11. expire_old_pending_advances só tem GRANT para service_role -- sob role
--     authenticated (papel real de Postgres, não só JWT claims), a chamada
--     deve falhar com permission denied.
set local role authenticated;
select throws_ok(
  $$ select public.expire_old_pending_advances() $$,
  'permission denied for function expire_old_pending_advances',
  'expire_old_pending_advances: bloqueado sob role authenticated (GRANT só p/ service_role)'
);

reset role;

-- =============================================================================
-- expire_old_pending_advances
-- =============================================================================

update public.ai_pending_stage_advances set expires_at = now() - interval '1 hour'
  where id = '99999999-9999-9999-9999-999999999999';
update public.hitl_decisions set expires_at = now() - interval '1 hour'
  where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

select public.expire_old_pending_advances();

select is(
  (select status from public.ai_pending_stage_advances where id = '99999999-9999-9999-9999-999999999999'),
  'expired',
  'expire_old_pending_advances: expira ai_pending_stage_advances vencido'
);
select is(
  (select status from public.hitl_decisions where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  'expired',
  'expire_old_pending_advances: expira hitl_decisions vencido'
);

select * from finish();
rollback;
