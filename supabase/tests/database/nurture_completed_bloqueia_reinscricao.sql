begin;
create extension if not exists pgtap;
select plan(3);

-- Tenant/estrutura mínimos para o scanner stagnant.
insert into auth.users (id, email) values
  ('f8400000-0000-4000-8000-000000000001', 'nurture-completed@example.test');
insert into public.boards (id, tenant_id, name)
select 'f8400000-0000-4000-8000-000000000010', tenant_id, 'Prova completed'
from public.profiles where id = 'f8400000-0000-4000-8000-000000000001';
insert into public.board_stages (id, board_id, name, position) values
  ('f8400000-0000-4000-8000-000000000011', 'f8400000-0000-4000-8000-000000000010', 'Estagnado', 0);
insert into public.contacts (id, tenant_id, name)
select v.id::uuid, p.tenant_id, v.name
from public.profiles p cross join (values
  ('f8400000-0000-4000-8000-000000000012', 'Contato completed recente'),
  ('f8400000-0000-4000-8000-000000000013', 'Contato completed antigo'),
  ('f8400000-0000-4000-8000-000000000014', 'Contato cancelled recente')
) v(id, name) where p.id = 'f8400000-0000-4000-8000-000000000001';
insert into public.deals (id, tenant_id, board_id, stage_id, contact_id, title, status, stage_entered_at)
select v.id::uuid, p.tenant_id, 'f8400000-0000-4000-8000-000000000010',
  'f8400000-0000-4000-8000-000000000011', v.contact_id::uuid, v.title, 'open', now() - interval '10 days'
from public.profiles p cross join (values
  ('f8400000-0000-4000-8000-000000000020', 'f8400000-0000-4000-8000-000000000012', 'Negócio completed recente'),
  ('f8400000-0000-4000-8000-000000000021', 'f8400000-0000-4000-8000-000000000013', 'Negócio completed antigo'),
  ('f8400000-0000-4000-8000-000000000022', 'f8400000-0000-4000-8000-000000000014', 'Negócio cancelled recente')
) v(id, contact_id, title) where p.id = 'f8400000-0000-4000-8000-000000000001';
insert into public.nurture_sequences (id, tenant_id, name, trigger_type, trigger_stage_id, stagnant_days)
select v.id::uuid, p.tenant_id, v.name, 'stagnant',
  'f8400000-0000-4000-8000-000000000011', 1
from public.profiles p cross join (values
  ('f8400000-0000-4000-8000-000000000030', 'Seq completed recente'),
  ('f8400000-0000-4000-8000-000000000031', 'Seq completed antigo'),
  ('f8400000-0000-4000-8000-000000000032', 'Seq cancelled recente')
) v(id, name) where p.id = 'f8400000-0000-4000-8000-000000000001';

-- Três inscrições terminais distintas para o mesmo (sequence, contact) de cada negócio.
insert into public.nurture_enrollments (tenant_id, sequence_id, contact_id, status, completed_at)
select p.tenant_id, v.sequence_id::uuid, v.contact_id::uuid, v.status,
  case when v.status = 'completed' then v.completed_at::timestamptz else now() end
from public.profiles p cross join (values
  ('f8400000-0000-4000-8000-000000000030', 'f8400000-0000-4000-8000-000000000012', 'completed', now()::text),
  ('f8400000-0000-4000-8000-000000000031', 'f8400000-0000-4000-8000-000000000013', 'completed', (now() - interval '10 days')::text),
  ('f8400000-0000-4000-8000-000000000032', 'f8400000-0000-4000-8000-000000000014', 'cancelled', now()::text)
) v(sequence_id, contact_id, status, completed_at)
where p.id = 'f8400000-0000-4000-8000-000000000001';

select public.enroll_stagnant_and_periodic_nurture();

select is((select count(*)::int from public.nurture_enrollments
  where sequence_id = 'f8400000-0000-4000-8000-000000000030'
    and contact_id = 'f8400000-0000-4000-8000-000000000012'), 1,
  'stagnant NÃO reinscreve inscrição completed com completed_at recente');

select is((select count(*)::int from public.nurture_enrollments
  where sequence_id = 'f8400000-0000-4000-8000-000000000031'
    and contact_id = 'f8400000-0000-4000-8000-000000000013'), 2,
  'stagnant reinscreve inscrição completed com completed_at fora da carência');

select is((select count(*)::int from public.nurture_enrollments
  where sequence_id = 'f8400000-0000-4000-8000-000000000032'
    and contact_id = 'f8400000-0000-4000-8000-000000000014'), 1,
  'stagnant continua bloqueando inscrição cancelled recente');

select * from finish();
rollback;
