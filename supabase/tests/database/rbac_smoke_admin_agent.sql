-- Smoke de leitura/escrita por papel (admin x atendente) direto no banco.
--
-- Complementa o smoke de navegador (e2e/rbac-smoke.spec.ts): aqui não há UI
-- para esconder botão nenhum — o que o papel consegue ler ou escrever é o que
-- a RLS efetivamente permite. Roda no CI sem depender de conta viva.
--
-- Os dois usuários vivem no MESMO tenant de propósito: isolamento entre tenants
-- já é coberto por e2e_workspace_rls_isolation.sql. O que se prova aqui é o
-- corte por PAPEL dentro do mesmo tenant.

begin;
create extension if not exists pgtap;
select plan(11);


-- --------------------------------------------------------------------
-- Fixtures. session_replication_role=replica desliga handle_new_user e
-- enforce_profile_immutable_fields, que colidiriam com ids controlados.
-- --------------------------------------------------------------------
set session_replication_role = replica;
do $$
declare
  v_tenant uuid := gen_random_uuid();
  v_admin  uuid := gen_random_uuid();
  v_agent  uuid := gen_random_uuid();
  v_role_admin uuid;
  v_role_agent uuid;
begin
  perform set_config('rbac.tenant', v_tenant::text, false);
  perform set_config('rbac.admin',  v_admin::text,  false);
  perform set_config('rbac.agent',  v_agent::text,  false);

  insert into auth.users (id, email) values
    (v_admin, 'rbac.admin@e2e.test'),
    (v_agent, 'rbac.agent@e2e.test')
    on conflict (id) do nothing;

  insert into public.tenants (id, name) values (v_tenant, 'Tenant RBAC Smoke');

  -- Com session_replication_role=replica o gatilho que semeia os status de
  -- contato não roda; sem eles a FK contacts_status_catalog_fk recusa o insert.
  insert into public.contact_statuses (tenant_id, slug, label, color, sort_order)
  values (v_tenant, 'lead', 'Lead', '#64748b', 1)
  on conflict do nothing;

  insert into public.profiles (id, tenant_id, name, role) values
    (v_admin, v_tenant, 'Admin Smoke', 'admin'),
    (v_agent, v_tenant, 'Atendente Smoke', 'agent');

  insert into public.roles (tenant_id, role_key, name, is_system)
  values (v_tenant, 'admin', 'Administrador', true)
  returning id into v_role_admin;

  insert into public.roles (tenant_id, role_key, name, is_system)
  values (v_tenant, 'agent', 'Atendente', true)
  returning id into v_role_agent;

  -- Admin recebe TODAS as permissões do catálogo; atendente recebe só o
  -- operacional. `tenant.settings.manage` é a chave que private.is_admin() lê.
  insert into public.role_permissions (role_id, permission_id)
  select v_role_admin, p.id from public.permissions p;

  insert into public.role_permissions (role_id, permission_id)
  select v_role_agent, p.id
  from public.permissions p
  where p.permission_key like 'contacts.%'
     or p.permission_key like 'deals.%'
     or p.permission_key like 'activities.%'
     or p.permission_key like 'conversations.%';

  insert into public.tenant_memberships (tenant_id, user_id, role_id, status) values
    (v_tenant, v_admin, v_role_admin, 'active'),
    (v_tenant, v_agent, v_role_agent, 'active');

  insert into public.contacts (tenant_id, name, phone)
  values (v_tenant, 'Contato Smoke', '+5511988880001');

  insert into public.ai_settings (tenant_id) values (v_tenant);
end $$;
set session_replication_role = default;

create or replace function pg_temp.assume(p_user text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    json_build_object('sub', current_setting('rbac.' || p_user), 'role', 'authenticated')::text,
    true
  )::void;
$$;

set role authenticated;

-- --------------------------------------------------------------------
-- ADMIN
-- --------------------------------------------------------------------
select pg_temp.assume('admin');

select is(
  (select count(*)::int from public.contacts where tenant_id::text = current_setting('rbac.tenant')),
  1, 'admin lê os contatos do próprio tenant'
);

select lives_ok(
  format($q$ insert into public.contacts (tenant_id, name, phone)
             values ('%s'::uuid, 'Criado pelo admin', '+5511988880002') $q$,
         current_setting('rbac.tenant')),
  'admin cria contato no próprio tenant'
);

select lives_ok(
  format($q$ update public.ai_settings set updated_at = now() where tenant_id = '%s'::uuid $q$,
         current_setting('rbac.tenant')),
  'admin altera a configuração de IA'
);

select lives_ok(
  format($q$ insert into public.tenant_integrations (tenant_id, slug, status)
             values ('%s'::uuid, 'zapi', 'pending') $q$,
         current_setting('rbac.tenant')),
  'admin conecta integração no próprio tenant'
);

-- --------------------------------------------------------------------
-- ATENDENTE
-- --------------------------------------------------------------------
select pg_temp.assume('agent');

select is(
  (select count(*)::int from public.contacts where tenant_id::text = current_setting('rbac.tenant')),
  2, 'atendente lê os contatos do tenant (inclusive o criado pelo admin)'
);

select lives_ok(
  format($q$ insert into public.contacts (tenant_id, name, phone)
             values ('%s'::uuid, 'Criado pelo atendente', '+5511988880003') $q$,
         current_setting('rbac.tenant')),
  'atendente cria contato — trabalho do dia a dia dele'
);

select lives_ok(
  format($q$ insert into public.activities (tenant_id, title, type, owner_id)
             values ('%s'::uuid, 'Ligar para o lead', 'call', '%s'::uuid) $q$,
         current_setting('rbac.tenant'), current_setting('rbac.agent')),
  'atendente registra atividade'
);

-- O corte de papel: configuração é do admin. UPDATE negado por RLS não lança
-- erro no Postgres — ele simplesmente não casa linha nenhuma.
-- CTE com UPDATE só é aceita no nível de cima da consulta.
with alterado as (
  update public.ai_settings set updated_at = now()
  where tenant_id::text = current_setting('rbac.tenant')
  returning 1
)
select is(
  (select count(*)::int from alterado),
  0, 'atendente NÃO altera a configuração de IA'
);

select throws_ok(
  format($q$ insert into public.tenant_integrations (tenant_id, slug, status)
             values ('%s'::uuid, 'meta-cloud', 'pending') $q$,
         current_setting('rbac.tenant')),
  '42501',
  null,
  'atendente NÃO conecta integração'
);

select is(
  (select count(*)::int from public.tenant_integrations where tenant_id::text = current_setting('rbac.tenant')),
  0, 'atendente NÃO enxerga as integrações conectadas do tenant'
);

-- Segredo de integração não é legível por nenhum papel do app.
-- Sem GRANT para authenticated (20260728130000): nem chega a avaliar RLS.
select throws_ok(
  'select count(*) from public.integration_secrets',
  '42501',
  null,
  'atendente não lê integration_secrets (só service_role)'
);

reset role;
select * from finish();
rollback;
