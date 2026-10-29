begin;
create extension if not exists pgtap;
select plan(6);

insert into auth.users (id, email) values
  ('f8100000-0000-4000-8000-000000000001', 'historico-followup@example.test'),
  ('f8100000-0000-4000-8000-000000000002', 'historico-outro-tenant@example.test');
insert into public.contacts (id, tenant_id, name)
select 'f8100000-0000-4000-8000-000000000010', tenant_id, 'Contato do histórico'
from public.profiles where id = 'f8100000-0000-4000-8000-000000000001';
insert into public.nurture_sequences (id, tenant_id, name)
select 'f8100000-0000-4000-8000-000000000020', tenant_id, 'Histórico isolado'
from public.profiles where id = 'f8100000-0000-4000-8000-000000000001';
insert into public.nurture_enrollments (id, tenant_id, sequence_id, contact_id, status)
select 'f8100000-0000-4000-8000-000000000030', tenant_id,
  'f8100000-0000-4000-8000-000000000020', 'f8100000-0000-4000-8000-000000000010', 'completed'
from public.profiles where id = 'f8100000-0000-4000-8000-000000000001';
set local role service_role;
insert into public.nurture_execution_history (tenant_id, enrollment_id, step_number, outcome)
select tenant_id, id, 1, 'sent' from public.nurture_enrollments
where id = 'f8100000-0000-4000-8000-000000000030';
reset role;

select set_config('request.jwt.claims', '{"sub":"f8100000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.nurture_execution_history
  where enrollment_id = 'f8100000-0000-4000-8000-000000000030'), 1,
  'tenant lê histórico mesmo após conclusão da inscrição');
select throws_ok($$insert into public.nurture_execution_history (tenant_id, enrollment_id, step_number, outcome)
  select tenant_id, id, 1, 'sent' from public.nurture_enrollments
  where id = 'f8100000-0000-4000-8000-000000000030'$$,
  '42501', null, 'usuário não fabrica execução pelo PostgREST');
select throws_ok($$update public.nurture_execution_history set outcome = 'completed'
  where enrollment_id = 'f8100000-0000-4000-8000-000000000030'$$,
  '42501', null, 'usuário não altera resultado registrado pelo worker');
reset role;

select set_config('request.jwt.claims', '{"sub":"f8100000-0000-4000-8000-000000000002","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.nurture_execution_history
  where enrollment_id = 'f8100000-0000-4000-8000-000000000030'), 0,
  'outro tenant não lê histórico por ID conhecido');
reset role;
update public.tenant_memberships set status = 'revoked', revoked_at = now()
where user_id = 'f8100000-0000-4000-8000-000000000001';
select set_config('request.jwt.claims', '{"sub":"f8100000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.nurture_execution_history
  where enrollment_id = 'f8100000-0000-4000-8000-000000000030'), 0,
  'membro revogado perde leitura do histórico');
reset role;
set local role anon;
select throws_ok($$select * from public.nurture_execution_history$$,
  '42501', null, 'anon não lê histórico');
reset role;

select * from finish();
rollback;
