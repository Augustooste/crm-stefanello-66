begin;
create extension if not exists pgtap;
select plan(8);

insert into auth.users (id, email) values
  ('f8000000-0000-4000-8000-000000000001', 'followup-operador@example.test'),
  ('f8000000-0000-4000-8000-000000000002', 'followup-outro-tenant@example.test');

insert into public.boards (id, tenant_id, name)
select 'f8000000-0000-4000-8000-000000000010', tenant_id, 'Prova follow-up'
from public.profiles where id = 'f8000000-0000-4000-8000-000000000001';
insert into public.board_stages (id, board_id, name, position) values
  ('f8000000-0000-4000-8000-000000000011', 'f8000000-0000-4000-8000-000000000010', 'Orçamento enviado', 0);
insert into public.contacts (id, tenant_id, name)
select 'f8000000-0000-4000-8000-000000000012', tenant_id, 'Contato da prova'
from public.profiles where id = 'f8000000-0000-4000-8000-000000000001';
insert into public.deals (tenant_id, board_id, stage_id, contact_id, title, status, stage_entered_at)
select p.tenant_id, 'f8000000-0000-4000-8000-000000000010', 'f8000000-0000-4000-8000-000000000011',
  'f8000000-0000-4000-8000-000000000012', v.title, v.status, now() - interval '10 days'
from public.profiles p cross join (values ('Parado', 'open'), ('Ganho', 'won')) v(title, status)
where p.id = 'f8000000-0000-4000-8000-000000000001';
insert into public.nurture_sequences (id, tenant_id, name, trigger_type, trigger_stage_id, stagnant_days, periodic_days)
select v.id::uuid, p.tenant_id, v.name, v.trigger_type, 'f8000000-0000-4000-8000-000000000011', v.stagnant_days, v.periodic_days
from public.profiles p cross join (values
  ('f8000000-0000-4000-8000-000000000020', 'Estagnação', 'stagnant', 7, null::int),
  ('f8000000-0000-4000-8000-000000000021', 'Periódico', 'periodic', null::int, 90)
) v(id, name, trigger_type, stagnant_days, periodic_days)
where p.id = 'f8000000-0000-4000-8000-000000000001';
insert into public.nurture_enrollments (id, tenant_id, sequence_id, contact_id, next_send_at)
select v.id::uuid, p.tenant_id, v.sequence_id::uuid, 'f8000000-0000-4000-8000-000000000012', now() - interval '1 hour'
from public.profiles p cross join (values
  ('f8000000-0000-4000-8000-000000000030', 'f8000000-0000-4000-8000-000000000020'),
  ('f8000000-0000-4000-8000-000000000031', 'f8000000-0000-4000-8000-000000000021')
) v(id, sequence_id)
where p.id = 'f8000000-0000-4000-8000-000000000001';

-- Ação operacional: membro ativo com papel agent também pode interromper.
update public.tenant_memberships m set role_id = r.id
from public.roles r where m.user_id = 'f8000000-0000-4000-8000-000000000001'
  and r.tenant_id = m.tenant_id and r.role_key = 'agent';
select set_config('request.jwt.claims', '{"sub":"f8000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.set_nurture_enrollment_status('f8000000-0000-4000-8000-000000000030', 'paused')$$,
  'membro agent ativo pode pausar inscrição do próprio tenant');
select lives_ok($$select public.set_nurture_enrollment_status('f8000000-0000-4000-8000-000000000031', 'cancelled')$$,
  'membro agent ativo pode cancelar inscrição do próprio tenant');
reset role;

select ok((select completed_at is not null and next_send_at is null from public.nurture_enrollments
  where id = 'f8000000-0000-4000-8000-000000000031'),
  'cancelamento pela RPC registra encerramento e remove próximo envio');
select public.enroll_stagnant_and_periodic_nurture();
select is((select count(*)::int from public.nurture_enrollments
  where sequence_id = 'f8000000-0000-4000-8000-000000000020'), 1,
  'scanner não cria outra inscrição por cima de uma pausa');
select is((select count(*)::int from public.nurture_enrollments
  where sequence_id = 'f8000000-0000-4000-8000-000000000021'), 1,
  'scanner respeita carência do cancelamento feito pela RPC');

select set_config('request.jwt.claims', '{"sub":"f8000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.set_nurture_enrollment_status('f8000000-0000-4000-8000-000000000030', 'active')$$,
  'P0001', 'Unauthorized', 'outro tenant não consegue retomar inscrição alheia');
reset role;
update public.tenant_memberships set status = 'revoked', revoked_at = now()
where user_id = 'f8000000-0000-4000-8000-000000000001';
select set_config('request.jwt.claims', '{"sub":"f8000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.set_nurture_enrollment_status('f8000000-0000-4000-8000-000000000030', 'active')$$,
  'P0001', 'Unauthorized', 'membro revogado não consegue retomar inscrição');
reset role;
select ok(not has_function_privilege('anon', 'public.set_nurture_enrollment_status(uuid,text)', 'execute'),
  'anon não pode executar a RPC de interrupção');

select * from finish();
rollback;
