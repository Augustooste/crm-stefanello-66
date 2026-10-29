-- Fase 4 — fila de jobs genérica (job_queue) — existência/estrutura do
-- schema (rodar: pnpm test:db). Roda contra o shadow DB local (supabase
-- test db --local), que reaplica todas as migrations do zero -- não toca a
-- DB real do Lovable.
begin;
create extension if not exists pgtap;

select plan(29);

-- 1. Tabela + RLS habilitada (nunca FORCE -- convenção real do projeto).
select has_table('public', 'job_queue', 'tabela job_queue existe');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.job_queue'::regclass),
  'RLS habilitada em job_queue'
);
select ok(
  not (select relforcerowsecurity from pg_class where oid = 'public.job_queue'::regclass),
  'RLS NÃO forçada em job_queue (convenção real do projeto)'
);

-- 2. Colunas essenciais.
select has_column('public', 'job_queue', 'tenant_id', 'job_queue.tenant_id existe');
select has_column('public', 'job_queue', 'job_type', 'job_queue.job_type existe');
select has_column('public', 'job_queue', 'status', 'job_queue.status existe');
select has_column('public', 'job_queue', 'payload', 'job_queue.payload existe');
select has_column('public', 'job_queue', 'scheduled_for', 'job_queue.scheduled_for existe');
select has_column('public', 'job_queue', 'attempts', 'job_queue.attempts existe');
select has_column('public', 'job_queue', 'max_attempts', 'job_queue.max_attempts existe');

-- 3. Índice de claim (parcial, só jobs pendentes).
select has_index('public', 'job_queue', 'job_queue_claimable_idx', 'índice de claim (status, scheduled_for) where pending existe');

-- 4. Policies: exatamente 1 SELECT para authenticated (tenant-scoped), zero
--    policies de escrita para authenticated (só service_role escreve).
select is(
  (select count(*)::int from pg_policies
    where tablename = 'job_queue' and cmd = 'SELECT' and 'authenticated' = any(roles)),
  1,
  'exatamente 1 policy de SELECT para authenticated em job_queue'
);
select is(
  (select count(*)::int from pg_policies
    where tablename = 'job_queue' and cmd in ('INSERT', 'UPDATE', 'DELETE') and 'authenticated' = any(roles)),
  0,
  'nenhuma policy de INSERT/UPDATE/DELETE para authenticated em job_queue'
);

-- 5. claim_jobs: existe, SECURITY DEFINER, search_path fixo, revoke
--    confirmado (pg_proc.proacl: sem EXECUTE para authenticated/anon, com
--    EXECUTE para service_role).
select has_function('public', 'claim_jobs', 'função claim_jobs existe');
select ok(
  (select prosecdef from pg_proc where oid = 'public.claim_jobs(int, text[])'::regprocedure),
  'claim_jobs é SECURITY DEFINER'
);
select ok(
  exists (
    select 1 from pg_proc
    where oid = 'public.claim_jobs(int, text[])'::regprocedure
      and proconfig is not null
      and exists (select 1 from unnest(proconfig) c where c like 'search_path=%')
  ),
  'claim_jobs tem search_path fixo'
);
-- `has_function_privilege` em vez de `aclexplode` + join em `pg_roles`: o join
-- DESCARTA em silêncio a linha cujo `grantee` é 0, que é exatamente como o
-- Postgres representa PUBLIC. Um `grant execute ... to public` (o default de
-- toda função nova, aliás) não produz nenhuma linha com oid casável em
-- `pg_roles`, então a versão anterior devolvia string vazia e ficava VERDE com
-- authenticated e anon executando a função por herança de PUBLIC. Além disso
-- `proacl` é NULL quando a função nunca teve GRANT explícito — e `aclexplode`
-- de NULL não devolve linha nenhuma, o mesmo falso verde por outro caminho.
-- `has_function_privilege` responde a pergunta que interessa ("este papel
-- consegue executar?") resolvendo PUBLIC e herança de role. Mesmo padrão já
-- usado em rbac_complete_lifecycle.sql e tenant_memberships_rbac.sql.
select ok(
  not has_function_privilege('authenticated', 'public.claim_jobs(int, text[])', 'EXECUTE'),
  'claim_jobs não tem EXECUTE para authenticated'
);
select ok(
  not has_function_privilege('anon', 'public.claim_jobs(int, text[])', 'EXECUTE'),
  'claim_jobs não tem EXECUTE para anon'
);
select ok(
  has_function_privilege('service_role', 'public.claim_jobs(int, text[])', 'EXECUTE'),
  'claim_jobs tem EXECUTE para service_role'
);

-- 6. Check constraint de status (valores válidos).
select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.job_queue'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%pending%running%success%failed%'
  ),
  'check constraint de status (pending/running/success/failed) existe'
);

-- =============================================================================
-- 7. claim_jobs -- comportamento real (claim atômico, sem duplicar, filtro
--    de job_type, respeito a scheduled_for). Existência/grants já cobertos
--    na seção 5 acima; aqui é a função rodando de verdade.
-- =============================================================================

-- Fixture: 1 tenant via handle_new_user (trigger em auth.users).
insert into auth.users (id, email) values
  ('66666666-6666-6666-6666-666666666666', 'admin-jobqueue@test.local');

-- Seed: 3 jobs pendentes, já vencidos (scheduled_for <= now()), job_type
-- variado -- claim_jobs(2, null) deve reivindicar só 2 deles.
insert into public.job_queue (tenant_id, job_type, status, scheduled_for)
select tenant_id, 'nurture_step', 'pending', now() - interval '1 minute'
from public.profiles where id = '66666666-6666-6666-6666-666666666666';
insert into public.job_queue (tenant_id, job_type, status, scheduled_for)
select tenant_id, 'broadcast_send', 'pending', now() - interval '1 minute'
from public.profiles where id = '66666666-6666-6666-6666-666666666666';
insert into public.job_queue (tenant_id, job_type, status, scheduled_for)
select tenant_id, 'digest_deliver', 'pending', now() - interval '1 minute'
from public.profiles where id = '66666666-6666-6666-6666-666666666666';

create temp table claim_result_1 as
select * from public.claim_jobs(2, null);

select is(
  (select count(*)::int from claim_result_1),
  2,
  'claim_jobs(2, null) reivindica exatamente 2 jobs (respeitando o limit)'
);
select is(
  (select count(*)::int from claim_result_1 where status = 'running'),
  2,
  'jobs reivindicados ficam com status running'
);
select is(
  (select count(*)::int from claim_result_1 where attempts = 1),
  2,
  'attempts incrementado de 0 para 1 nos jobs reivindicados'
);
select is(
  (select count(*)::int from claim_result_1 where started_at is not null),
  2,
  'started_at preenchido nos jobs reivindicados'
);

-- Concorrência: 2ª chamada com o mesmo limit não pode devolver nenhum dos 2
-- jobs já reivindicados na chamada anterior -- é exatamente o `for update
-- skip locked` + o filtro `status = 'pending'` dentro de claim_jobs que
-- garantem isso. Mutation-check: se o `for update skip locked` fosse
-- removido, uma claim_jobs concorrente correndo em paralelo poderia
-- bloquear e devolver a mesma linha (duplicar o claim); se o filtro
-- `status = 'pending'` fosse removido do WHERE, os jobs já 'running' da
-- 1ª chamada voltariam a ser candidatos aqui. Os dois asserts abaixo (count
-- = 1 restante, zero interseção com claim_result_1) pegariam qualquer uma
-- dessas duas regressões.
create temp table claim_result_2 as
select * from public.claim_jobs(2, null);

select is(
  (select count(*)::int from claim_result_2),
  1,
  'segunda chamada reivindica só o job pendente restante (3 seeds - 2 já reivindicados = 1)'
);
select is(
  (select count(*)::int from claim_result_2 c join claim_result_1 c1 on c.id = c1.id),
  0,
  'segunda chamada não devolve nenhum job já reivindicado pela primeira (sem duplicar)'
);

-- Filtro p_job_types: só o job do tipo pedido volta, mesmo com outro tipo
-- também pendente e vencido na fila.
insert into public.job_queue (tenant_id, job_type, status, scheduled_for)
select tenant_id, 'tipo_a', 'pending', now() - interval '1 minute'
from public.profiles where id = '66666666-6666-6666-6666-666666666666';
insert into public.job_queue (tenant_id, job_type, status, scheduled_for)
select tenant_id, 'tipo_b', 'pending', now() - interval '1 minute'
from public.profiles where id = '66666666-6666-6666-6666-666666666666';

create temp table claim_result_filtered as
select * from public.claim_jobs(10, array['tipo_a']);

select is(
  (select count(*)::int from claim_result_filtered),
  1,
  'claim_jobs(10, array[tipo_a]) retorna só 1 job mesmo com tipo_b também pendente/vencido'
);
select is(
  (select job_type from claim_result_filtered limit 1),
  'tipo_a',
  'o job retornado é do tipo filtrado (tipo_a), não tipo_b'
);

-- scheduled_for no futuro: nunca reivindicado. Isolado com job_type próprio
-- para não colidir com o tipo_b ainda pendente do bloco anterior.
insert into public.job_queue (tenant_id, job_type, status, scheduled_for)
select tenant_id, 'tipo_futuro', 'pending', now() + interval '1 hour'
from public.profiles where id = '66666666-6666-6666-6666-666666666666';

select is(
  (select count(*)::int from public.claim_jobs(10, array['tipo_futuro'])),
  0,
  'job com scheduled_for no futuro não é reivindicado por claim_jobs'
);

select * from finish();
rollback;
