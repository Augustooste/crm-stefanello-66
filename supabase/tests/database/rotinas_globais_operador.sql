begin;
create extension if not exists pgtap;
select plan(31);

-- Dois admins de tenants diferentes; nenhum recebe autoridade de plataforma.
set local session_replication_role = replica;
do $$
declare
  v_tenant uuid;
  v_user uuid;
  v_role uuid;
  v_actor text;
begin
  foreach v_actor in array array['admin', 'other_admin', 'operator'] loop
    v_tenant := gen_random_uuid();
    v_user := gen_random_uuid();
    perform set_config('rotinas.' || v_actor, v_user::text, true);
    insert into auth.users (id, email) values (v_user, v_user::text || '@rotinas.test');
    insert into public.tenants (id, name) values (v_tenant, 'Teste de rotinas globais');
    insert into public.profiles (id, tenant_id, name, role)
      values (v_user, v_tenant, v_actor, 'admin');
    insert into public.roles (tenant_id, role_key, name, is_system)
      values (v_tenant, 'admin', 'Administrador', true) returning id into v_role;
    insert into public.role_permissions (role_id, permission_id)
      select v_role, id from public.permissions;
    insert into public.tenant_memberships (tenant_id, user_id, role_id, status)
      values (v_tenant, v_user, v_role, 'active');
  end loop;
end;
$$;
set local session_replication_role = origin;

create function pg_temp.assume(p_actor text) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object(
    'sub', current_setting('rotinas.' || p_actor), 'role', 'authenticated'
  )::text, true)::void;
$$;

-- Simula remix frio sem promover automaticamente nenhum admin.
delete from private.platform_operators;
create temp table initial_cron as select jobid, active from cron.job;

set local role authenticated;
select pg_temp.assume('admin');
select ok(private.is_admin(), 'fixture é admin real do tenant');
select throws_ok(
  $$select public.activate_scheduled_jobs()$$, '42501', null,
  'admin de tenant não pode ativar rotinas globais'
);
select throws_ok(
  $$select public.pause_scheduled_jobs()$$, '42501', null,
  'admin de tenant não pode pausar rotinas globais'
);
select lives_ok(
  $$select public.scheduled_jobs_status()$$,
  'admin mantém leitura do estado das rotinas'
);
select is(
  (public.scheduled_jobs_status()->>'can_manage')::boolean, false,
  'ambiente sem operador continua somente leitura para o primeiro admin'
);
select throws_ok(
  $$insert into private.platform_operators(user_id)
      values (current_setting('rotinas.admin')::uuid)$$, '42501', null,
  'admin não pode cadastrar a si próprio como operador'
);
select throws_ok(
  $$select * from private.platform_operators$$, '42501', null,
  'cadastro de operadores não é exposto a authenticated'
);
select throws_ok(
  $$select private.sync_scheduled_jobs(true)$$, '42501', null,
  'admin não pode contornar a RPC chamando o reconciliador privado'
);
select throws_ok(
  $$select public.configure_internal_access('http://127.0.0.1:54321', 'teste-local')$$,
  '42501', null, 'admin não chama diretamente a escrita privilegiada do Vault'
);
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', current_setting('rotinas.admin'), 'role', 'authenticated',
  'user_metadata', jsonb_build_object('is_platform_operator', true, 'role', 'operator')
)::text, true);
select throws_ok(
  $$select public.activate_scheduled_jobs()$$, '42501', null,
  'metadados editáveis pelo usuário não conferem autoridade de operador'
);
select pg_temp.assume('other_admin');
select ok(private.is_admin(), 'segundo tenant também tem admin real');
select throws_ok(
  $$select public.pause_scheduled_jobs()$$, '42501', null,
  'admin de outro tenant também não pode pausar a plataforma'
);
select throws_ok(
  $$select public.activate_scheduled_jobs()$$, '42501', null,
  'admin de outro tenant também não pode ativar a plataforma'
);

reset role;
select results_eq(
  $$select jobid, active from cron.job order by jobid$$,
  $$select jobid, active from initial_cron order by jobid$$,
  'chamadas negadas não alteram nenhum cron'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'private.platform_operators'::regclass),
  'cadastro privado também tem RLS habilitada'
);

set local role anon;
select throws_ok(
  $$select public.activate_scheduled_jobs()$$, '42501', null,
  'anônimo não ativa as rotinas'
);
select throws_ok(
  $$select public.pause_scheduled_jobs()$$, '42501', null,
  'anônimo não pausa as rotinas'
);
select throws_ok(
  $$select public.scheduled_jobs_status()$$, '42501', null,
  'anônimo não consulta o estado das rotinas'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', gen_random_uuid(), 'role', 'authenticated'
)::text, true);
select throws_ok(
  $$select public.scheduled_jobs_status()$$, '42501', null,
  'autenticado sem papel admin ou operador não lê o estado global'
);
reset role;

-- Cadastro explícito pelo administrador do banco, fora do caminho do usuário.
insert into private.platform_operators(user_id)
  values (current_setting('rotinas.operator')::uuid);
set local role authenticated;
select pg_temp.assume('operator');
select is(
  (public.scheduled_jobs_status()->>'can_manage')::boolean, true,
  'operador recebe permissão explícita no estado das rotinas'
);
select lives_ok(
  $$select public.activate_scheduled_jobs()$$,
  'operador consegue ativar as rotinas globais'
);
reset role;
select is(
  (select count(*)::integer
   from private.scheduled_job_catalog() c left join cron.job j on j.jobname = c.jobname
   where j.jobid is null or j.active is distinct from c.default_active),
  0, 'ativação do operador materializa todo o catálogo com os defaults vigentes'
);
select ok(
  exists (select 1 from cron.job where jobname = 'ai-response-worker-every-minute' and active),
  'ativação realmente liga o worker de respostas'
);
create temp table activated_cron as select to_jsonb(j) as job from cron.job j;

-- A Server Function de bootstrap usa service_role em nome de um admin.
-- Configurar o Vault não pode pausar os jobs por esse caminho indireto.
set local role service_role;
select lives_ok(
  $$select public.configure_internal_access('http://127.0.0.1:54321', 'teste-local-sem-provedor')$$,
  'bootstrap mantém a escrita do Vault pelo servidor'
);
reset role;
select results_eq(
  $$select to_jsonb(j) from cron.job j order by j.jobid$$,
  $$select job from activated_cron order by (job->>'jobid')::bigint$$,
  'bootstrap não muda estado, agenda ou comando de nenhum cron'
);

set local role authenticated;
select pg_temp.assume('operator');
select lives_ok(
  $$select public.pause_scheduled_jobs()$$,
  'operador consegue pausar as rotinas globais'
);
select is(
  (public.scheduled_jobs_status()->>'active')::integer, 0,
  'pausa do operador desliga todas as rotinas do catálogo'
);
reset role;
select is(
  (select count(*) from cron.job), (select count(*) from activated_cron),
  'pausa preserva os jobs registrados'
);
set local role authenticated;
select pg_temp.assume('admin');
select throws_ok(
  $$select public.pause_scheduled_jobs()$$, '42501', null,
  'cadastrar um operador não concede poder aos demais admins'
);
reset role;

delete from private.platform_operators
  where user_id = current_setting('rotinas.operator')::uuid;
set local role authenticated;
select pg_temp.assume('operator');
select throws_ok(
  $$select public.activate_scheduled_jobs()$$, '42501', null,
  'revogar o cadastro impede ativação com o mesmo JWT'
);
select is(
  (public.scheduled_jobs_status()->>'can_manage')::boolean, false,
  'operador revogado mantém apenas a leitura de admin'
);
reset role;
select * from finish();
rollback;
