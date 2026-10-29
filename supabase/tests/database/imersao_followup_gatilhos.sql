begin;
create extension if not exists pgtap;
select plan(4);

insert into auth.users (id, email) values
  ('f8200000-0000-4000-8000-000000000001', 'followup-gatilhos@example.test');
insert into public.boards (id, tenant_id, name)
select 'f8200000-0000-4000-8000-000000000010', tenant_id, 'Gatilhos da prova'
from public.profiles where id = 'f8200000-0000-4000-8000-000000000001';
insert into public.board_stages (id, board_id, name, position, is_won) values
  ('f8200000-0000-4000-8000-000000000011', 'f8200000-0000-4000-8000-000000000010', 'Proposta', 0, false),
  ('f8200000-0000-4000-8000-000000000012', 'f8200000-0000-4000-8000-000000000010', 'Ganho', 1, true);
insert into public.contacts (id, tenant_id, name)
select 'f8200000-0000-4000-8000-000000000013', tenant_id, 'Contato de gatilhos'
from public.profiles where id = 'f8200000-0000-4000-8000-000000000001';
insert into public.deals (id, tenant_id, board_id, stage_id, contact_id, title)
select 'f8200000-0000-4000-8000-000000000014', tenant_id, 'f8200000-0000-4000-8000-000000000010',
  'f8200000-0000-4000-8000-000000000011', 'f8200000-0000-4000-8000-000000000013', 'Proposta da prova'
from public.profiles where id = 'f8200000-0000-4000-8000-000000000001';
insert into public.nurture_sequences (id, tenant_id, name, trigger_type, trigger_stage_id)
select v.id::uuid, p.tenant_id, v.trigger_type, v.trigger_type, 'f8200000-0000-4000-8000-000000000012'
from public.profiles p cross join (values
  ('f8200000-0000-4000-8000-000000000020', 'stage_change'),
  ('f8200000-0000-4000-8000-000000000021', 'won')
) v(id, trigger_type) where p.id = 'f8200000-0000-4000-8000-000000000001';
insert into public.nurture_enrollments (tenant_id, sequence_id, contact_id, status, next_send_at)
select p.tenant_id, v.sequence_id::uuid, 'f8200000-0000-4000-8000-000000000013', v.status, now()
from public.profiles p cross join (values
  ('f8200000-0000-4000-8000-000000000020', 'paused'),
  ('f8200000-0000-4000-8000-000000000021', 'sending')
) v(sequence_id, status) where p.id = 'f8200000-0000-4000-8000-000000000001';

select set_config('request.jwt.claims', '{"sub":"f8200000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select public.transition_deal_stage(
  p_deal_id := 'f8200000-0000-4000-8000-000000000014',
  p_expected_stage_id := 'f8200000-0000-4000-8000-000000000011',
  p_target_stage_id := 'f8200000-0000-4000-8000-000000000012',
  p_idempotency_key := 'f8-prova-gatilhos',
  p_reason := 'Prova dos gatilhos de acompanhamento'
);
select is((select count(*)::int from public.nurture_enrollments
  where sequence_id = 'f8200000-0000-4000-8000-000000000020'), 1,
  'mudança de etapa não cria inscrição por cima de uma pausa');
select is((select count(*)::int from public.nurture_enrollments
  where sequence_id = 'f8200000-0000-4000-8000-000000000021'), 1,
  'negócio ganho não duplica inscrição com envio em andamento');

-- Encerrada a inscrição antiga, uma nova entrada no estágio é um novo gatilho.
select public.set_nurture_enrollment_status(id, 'cancelled')
from public.nurture_enrollments
where sequence_id in ('f8200000-0000-4000-8000-000000000020', 'f8200000-0000-4000-8000-000000000021');
select public.transition_deal_stage(
  p_deal_id := 'f8200000-0000-4000-8000-000000000014',
  p_expected_stage_id := 'f8200000-0000-4000-8000-000000000012',
  p_target_stage_id := 'f8200000-0000-4000-8000-000000000011',
  p_idempotency_key := 'f8-prova-retorno'
);
select public.transition_deal_stage(
  p_deal_id := 'f8200000-0000-4000-8000-000000000014',
  p_expected_stage_id := 'f8200000-0000-4000-8000-000000000011',
  p_target_stage_id := 'f8200000-0000-4000-8000-000000000012',
  p_idempotency_key := 'f8-prova-nova-entrada'
);
select is((select count(*)::int from public.nurture_enrollments
  where sequence_id = 'f8200000-0000-4000-8000-000000000020' and status = 'active'), 1,
  'nova entrada na etapa continua inscrevendo quando não há pausa nem envio em voo');
select is((select count(*)::int from public.nurture_enrollments
  where sequence_id = 'f8200000-0000-4000-8000-000000000021' and status = 'active'), 1,
  'novo ganho continua inscrevendo quando não há pausa nem envio em voo');
reset role;
select * from finish();
rollback;
