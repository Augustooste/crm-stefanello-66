-- Fase 4 (user stories A + D) — Nurture/Drip + Auto-enrollment:
-- existência/estrutura do schema (rodar: pnpm test:db). Roda contra o shadow
-- DB local (supabase test db --local), que reaplica todas as migrations do
-- zero -- não toca a DB real do Lovable.
begin;
create extension if not exists pgtap;

select plan(38);

-- 1. Tabelas novas existem.
select has_table('public', 'nurture_sequences', 'tabela nurture_sequences existe');
select has_table('public', 'nurture_steps', 'tabela nurture_steps existe');
select has_table('public', 'nurture_enrollments', 'tabela nurture_enrollments existe');

-- 2. RLS habilitada, nunca FORCE (convenção real do projeto).
select ok(
  (select relrowsecurity from pg_class where oid = 'public.nurture_sequences'::regclass),
  'RLS habilitada em nurture_sequences'
);
select ok(
  not (select relforcerowsecurity from pg_class where oid = 'public.nurture_sequences'::regclass),
  'RLS NÃO forçada em nurture_sequences'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.nurture_steps'::regclass),
  'RLS habilitada em nurture_steps'
);
select ok(
  not (select relforcerowsecurity from pg_class where oid = 'public.nurture_steps'::regclass),
  'RLS NÃO forçada em nurture_steps'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.nurture_enrollments'::regclass),
  'RLS habilitada em nurture_enrollments'
);
select ok(
  not (select relforcerowsecurity from pg_class where oid = 'public.nurture_enrollments'::regclass),
  'RLS NÃO forçada em nurture_enrollments'
);

-- 3. Índice único de idempotência: no máximo 1 inscrição ativa por
--    (sequence_id, contact_id) -- critério de aceite do PRD.
select has_index('public', 'nurture_enrollments', 'nurture_enrollments_unique_active', 'unique index: 1 inscrição ativa por (sequence_id, contact_id)');
select has_index('public', 'nurture_enrollments', 'nurture_enrollments_claimable_idx', 'index do scanner/worker: (status, next_send_at) parcial');

-- 4. Constraint unique(sequence_id, step_number) em nurture_steps.
select ok(
  exists (
    select 1
    from pg_constraint
    where conrelid = 'public.nurture_steps'::regclass
      and contype = 'u'
      and conkey = (
        select array_agg(attnum order by attnum)
        from pg_attribute
        where attrelid = 'public.nurture_steps'::regclass
          and attname in ('sequence_id', 'step_number')
      )
  ),
  'constraint unique(sequence_id, step_number) existe em nurture_steps'
);

-- 5. Nenhuma policy de INSERT/UPDATE para authenticated em
--    nurture_enrollments -- toda mutação passa por
--    set_nurture_enrollment_status() ou pelas triggers/scanner SECURITY
--    DEFINER (lição aprendida na fase 3: UPDATE direto bypassa auditoria).
select is(
  (select count(*)::int from pg_policies
    where tablename = 'nurture_enrollments' and cmd = 'INSERT' and 'authenticated' = any(roles)),
  0,
  'nenhuma policy de INSERT para authenticated em nurture_enrollments'
);
select is(
  (select count(*)::int from pg_policies
    where tablename = 'nurture_enrollments' and cmd = 'UPDATE' and 'authenticated' = any(roles)),
  0,
  'nenhuma policy de UPDATE para authenticated em nurture_enrollments'
);

-- 6. Funções existem.
select has_function('public', 'set_nurture_enrollment_status', 'set_nurture_enrollment_status existe');
select has_function('public', 'enroll_deal_on_stage_change', 'enroll_deal_on_stage_change existe');
select has_function('public', 'enroll_deal_on_won', 'enroll_deal_on_won existe');
select has_function('public', 'enroll_stagnant_and_periodic_nurture', 'enroll_stagnant_and_periodic_nurture existe');

-- 7. Todas SECURITY DEFINER com search_path fixo (fail-closed).
select is(
  (
    with target_functions(signature) as (
      values
        ('public.set_nurture_enrollment_status(uuid, text)'),
        ('public.enroll_deal_on_stage_change()'),
        ('public.enroll_deal_on_won()'),
        ('public.enroll_stagnant_and_periodic_nurture()')
    )
    select coalesce(string_agg(tf.signature, ', '), '')
    from target_functions tf
    join pg_proc p on p.oid = tf.signature::regprocedure
    where not p.prosecdef
  ),
  '',
  'todas as 4 funções de nurture são SECURITY DEFINER (lista = reprovadas)'
);
select is(
  (
    with target_functions(signature) as (
      values
        ('public.set_nurture_enrollment_status(uuid, text)'),
        ('public.enroll_deal_on_stage_change()'),
        ('public.enroll_deal_on_won()'),
        ('public.enroll_stagnant_and_periodic_nurture()')
    )
    select coalesce(string_agg(tf.signature, ', '), '')
    from target_functions tf
    join pg_proc p on p.oid = tf.signature::regprocedure
    where p.proconfig is null
       or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')
  ),
  '',
  'todas as 4 funções de nurture têm search_path fixo (lista = reprovadas)'
);

-- 8. Triggers de auto-enrollment em deals existem.
select has_trigger('public', 'deals', 'trg_deals_enroll_stage_change', 'trigger de auto-enrollment por stage_change existe');
select has_trigger('public', 'deals', 'trg_deals_enroll_won', 'trigger de auto-enrollment por won existe');

-- 9. Colunas-chave presentes (spot-check de schema).
select has_column('public', 'nurture_enrollments', 'contact_id', 'nurture_enrollments.contact_id existe');
select has_column('public', 'nurture_enrollments', 'current_step', 'nurture_enrollments.current_step existe');
select has_column('public', 'nurture_sequences', 'trigger_type', 'nurture_sequences.trigger_type existe');

-- 10. RPC set_nurture_enrollment_status é chamável por authenticated (não
--     revogada por completo -- diferente das triggers/scanner acima).
select ok(
  has_function_privilege('authenticated', 'public.set_nurture_enrollment_status(uuid, text)', 'execute'),
  'authenticated pode executar set_nurture_enrollment_status'
);

-- =============================================================================
-- 11. Índice único nurture_enrollments_unique_active — comportamento (não só
--     existência): parcial em status='active', então 2 linhas ATIVAS para o
--     MESMO (sequence_id, contact_id) colidem, mas com status diferente não.
-- =============================================================================
insert into auth.users (id, email) values
  ('99999999-9999-9999-9999-999999999991', 'admin-nurture-unique@test.local');

insert into public.nurture_sequences (id, tenant_id, name)
select '99999999-9999-9999-9999-999999999992', tenant_id, 'Sequence unique-idx'
from public.profiles where id = '99999999-9999-9999-9999-999999999991';

insert into public.contacts (id, tenant_id, name)
select '99999999-9999-9999-9999-999999999993', tenant_id, 'Contato unique-idx'
from public.profiles where id = '99999999-9999-9999-9999-999999999991';

insert into public.nurture_enrollments (tenant_id, sequence_id, contact_id, status)
select tenant_id, '99999999-9999-9999-9999-999999999992', '99999999-9999-9999-9999-999999999993', 'active'
from public.profiles where id = '99999999-9999-9999-9999-999999999991';

select throws_ok(
  $$insert into public.nurture_enrollments (tenant_id, sequence_id, contact_id, status)
    select tenant_id, '99999999-9999-9999-9999-999999999992'::uuid, '99999999-9999-9999-9999-999999999993'::uuid, 'active'
    from public.profiles where id = '99999999-9999-9999-9999-999999999991'::uuid$$,
  '23505',
  NULL,
  'segunda inscrição ATIVA para o mesmo (sequence_id, contact_id) é rejeitada pelo índice único (unique_violation)'
);

insert into public.nurture_enrollments (tenant_id, sequence_id, contact_id, status)
select tenant_id, '99999999-9999-9999-9999-999999999992', '99999999-9999-9999-9999-999999999993', 'paused'
from public.profiles where id = '99999999-9999-9999-9999-999999999991';

select is(
  (select count(*)::int from public.nurture_enrollments
    where sequence_id = '99999999-9999-9999-9999-999999999992'
      and contact_id = '99999999-9999-9999-9999-999999999993'),
  2,
  'inscrição com status DIFERENTE (paused) para o mesmo par é aceita -- índice é parcial (where status=active)'
);

-- =============================================================================
-- 12. enroll_stagnant_and_periodic_nurture() — comportamento ponta-a-ponta
--     para os 2 trigger_types implementados (stagnant + periodic). Não cobre
--     todos os casos-limite do PRD, só prova que a função funciona.
-- =============================================================================
insert into auth.users (id, email) values
  ('88888888-8888-8888-8888-888888888881', 'admin-nurture-scanner@test.local');

insert into public.boards (id, tenant_id, name, is_default)
select '88888888-8888-8888-8888-888888888882', tenant_id, 'Board scanner', true
from public.profiles where id = '88888888-8888-8888-8888-888888888881';

insert into public.board_stages (id, board_id, name, position) values
  ('88888888-8888-8888-8888-888888888883', '88888888-8888-8888-8888-888888888882', 'Estágio estagnado', 0);

-- Sequence stagnant: trigger_stage_id aponta pro estágio acima, stagnant_days=5.
insert into public.nurture_sequences (id, tenant_id, name, trigger_type, trigger_stage_id, stagnant_days)
select '88888888-8888-8888-8888-888888888884', tenant_id, 'Sequence stagnant', 'stagnant',
  '88888888-8888-8888-8888-888888888883', 5
from public.profiles where id = '88888888-8888-8888-8888-888888888881';

-- Sequence periodic: periodic_days=30, sem trigger_stage_id (não exigido pro trigger_type periodic).
insert into public.nurture_sequences (id, tenant_id, name, trigger_type, periodic_days)
select '88888888-8888-8888-8888-888888888885', tenant_id, 'Sequence periodic', 'periodic', 30
from public.profiles where id = '88888888-8888-8888-8888-888888888881';

insert into public.contacts (id, tenant_id, name)
select '88888888-8888-8888-8888-888888888886', tenant_id, 'Contato estagnado'
from public.profiles where id = '88888888-8888-8888-8888-888888888881';
insert into public.contacts (id, tenant_id, name)
select '88888888-8888-8888-8888-888888888887', tenant_id, 'Contato won'
from public.profiles where id = '88888888-8888-8888-8888-888888888881';

-- Deal estagnado: aberto, no estágio-gatilho, parado há 10 dias (> 5 configurados).
insert into public.deals (id, tenant_id, board_id, stage_id, contact_id, title, status, stage_entered_at)
select '88888888-8888-8888-8888-888888888888', tenant_id, '88888888-8888-8888-8888-888888888882',
  '88888888-8888-8888-8888-888888888883', '88888888-8888-8888-8888-888888888886', 'Deal estagnado', 'open',
  now() - interval '10 days'
from public.profiles where id = '88888888-8888-8888-8888-888888888881';

-- Deal won: contato elegível pro periodic (sem inscrição prévia, sem completed_at recente).
insert into public.deals (id, tenant_id, board_id, stage_id, contact_id, title, status)
select '88888888-8888-8888-8888-888888888889', tenant_id, '88888888-8888-8888-8888-888888888882',
  '88888888-8888-8888-8888-888888888883', '88888888-8888-8888-8888-888888888887', 'Deal ganho', 'won'
from public.profiles where id = '88888888-8888-8888-8888-888888888881';

create temp table tmp_scanner_result as
select public.enroll_stagnant_and_periodic_nurture() as result;

select is(
  (select (result->>'stagnant')::int from tmp_scanner_result),
  1,
  'enroll_stagnant_and_periodic_nurture: 1 enrollment stagnant criado'
);
select is(
  (select (result->>'periodic')::int from tmp_scanner_result),
  1,
  'enroll_stagnant_and_periodic_nurture: 1 enrollment periodic criado'
);
select is(
  (select count(*)::int from public.nurture_enrollments
    where sequence_id = '88888888-8888-8888-8888-888888888884'
      and contact_id = '88888888-8888-8888-8888-888888888886'
      and status = 'active'),
  1,
  'enrollment stagnant criado com status active pro contato/deal estagnado'
);
select is(
  (select count(*)::int from public.nurture_enrollments
    where sequence_id = '88888888-8888-8888-8888-888888888885'
      and contact_id = '88888888-8888-8888-8888-888888888887'
      and status = 'active'),
  1,
  'enrollment periodic criado com status active pro contato com deal won'
);

-- =============================================================================
-- 13. Cancelamento sobrevive à varredura seguinte.
--     O contato responde, o webhook cancela — e antes desta carência o scanner
--     reinscrevia o mesmo contato do passo 0 na execução seguinte, anulando a
--     feature de "parar ao responder" em uma varredura.
-- =============================================================================
update public.nurture_enrollments
set status = 'cancelled', completed_at = now(), next_send_at = null
where sequence_id in (
  '88888888-8888-8888-8888-888888888884',
  '88888888-8888-8888-8888-888888888885'
);

create temp table tmp_scanner_apos_cancelamento as
select public.enroll_stagnant_and_periodic_nurture() as result;

select is(
  (select (result->>'stagnant')::int from tmp_scanner_apos_cancelamento),
  0,
  'stagnant: cancelamento recente segura a reinscrição na varredura seguinte'
);
select is(
  (select (result->>'periodic')::int from tmp_scanner_apos_cancelamento),
  0,
  'periodic: cancelamento recente segura a reinscrição na varredura seguinte'
);
select is(
  (select count(*)::int from public.nurture_enrollments
    where sequence_id in (
      '88888888-8888-8888-8888-888888888884',
      '88888888-8888-8888-8888-888888888885'
    )),
  2,
  'nenhuma linha nova de enrollment criada depois do cancelamento'
);

-- =============================================================================
-- 14. Reativar não pode disparar o envio na hora.
--     `set_nurture_enrollment_status` só trocava `status`, e o claim do worker
--     é `status='active' and next_send_at <= now()` — reativar depois que o
--     horário venceu fazia a mensagem sair no tique seguinte, sem o respiro do
--     passo. Pausa curta (horário ainda no futuro) tem que preservar o
--     agendamento original.
-- =============================================================================
insert into public.nurture_steps (sequence_id, step_number, delay_hours, message_template)
values ('88888888-8888-8888-8888-888888888884', 1, 48, 'Primeiro toque');

-- Contexto de tenant: a RPC compara com private.get_user_tenant_id().
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '88888888-8888-8888-8888-888888888881', 'role', 'authenticated')::text,
  false
);

-- (a) Vencido: pausa longa. next_send_at ficou 2h no passado.
insert into public.nurture_enrollments
  (id, tenant_id, sequence_id, contact_id, current_step, status, next_send_at)
select '88888888-8888-8888-8888-88888888888a', tenant_id,
       '88888888-8888-8888-8888-888888888884',
       '88888888-8888-8888-8888-888888888886',
       0, 'paused', now() - interval '2 hours'
from public.profiles where id = '88888888-8888-8888-8888-888888888881';

select public.set_nurture_enrollment_status(
  '88888888-8888-8888-8888-88888888888a', 'active'
);

select ok(
  (select next_send_at from public.nurture_enrollments
    where id = '88888888-8888-8888-8888-88888888888a') > now(),
  'reativar não deixa a inscrição imediatamente reivindicável pelo worker'
);
select ok(
  (select next_send_at from public.nurture_enrollments
    where id = '88888888-8888-8888-8888-88888888888a')
    between now() + interval '47 hours' and now() + interval '49 hours',
  'reancora usando o delay_hours do passo pendente (48h), não um valor fixo'
);

-- (b) Não vencido: pausa curta, horário ainda no futuro — preserva o original.
insert into public.nurture_enrollments
  (id, tenant_id, sequence_id, contact_id, current_step, status, next_send_at)
select '88888888-8888-8888-8888-88888888888b', tenant_id,
       '88888888-8888-8888-8888-888888888884',
       '88888888-8888-8888-8888-888888888887',
       0, 'paused', now() + interval '10 hours'
from public.profiles where id = '88888888-8888-8888-8888-888888888881';

select public.set_nurture_enrollment_status(
  '88888888-8888-8888-8888-88888888888b', 'active'
);

select ok(
  (select next_send_at from public.nurture_enrollments
    where id = '88888888-8888-8888-8888-88888888888b')
    between now() + interval '9 hours' and now() + interval '11 hours',
  'pausa curta preserva o agendamento original em vez de empurrar para frente'
);

select * from finish();
rollback;
