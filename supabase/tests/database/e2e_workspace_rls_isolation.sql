-- E2E RLS isolation between workspaces.
--
-- Prova que, mesmo quando o mesmo usuário é membro de dois tenants distintos,
-- ao assumir a identidade (auth.uid) desse usuário ele NÃO consegue enxergar
-- linhas do tenant que não é o seu ativo, em nenhuma das tabelas críticas.
--
-- O teste roda como o role `authenticated` para que RLS seja avaliada.

BEGIN;
SELECT plan(6);

-- --------------------------------------------------------------------
-- Fixtures: dois tenants, dois usuários, um usuário compartilhado.
-- --------------------------------------------------------------------
-- Semeia com triggers desabilitados (session_replication_role=replica): o trigger
-- handle_new_user cria profile+tenant automáticos (colide com o INSERT de profiles) e
-- enforce_profile_immutable_fields bloquearia setar tenant_id/role. Fixture controlado
-- precisa dos ids/tenants explícitos; superuser já bypassa RLS durante o seeding.
SET session_replication_role = replica;
DO $$
DECLARE
  v_tenant_a uuid := gen_random_uuid();
  v_tenant_b uuid := gen_random_uuid();
  v_user_a   uuid := gen_random_uuid();
  v_user_b   uuid := gen_random_uuid();
BEGIN
  PERFORM set_config('e2e.tenant_a', v_tenant_a::text, false);
  PERFORM set_config('e2e.tenant_b', v_tenant_b::text, false);
  PERFORM set_config('e2e.user_a',   v_user_a::text,   false);
  PERFORM set_config('e2e.user_b',   v_user_b::text,   false);

  INSERT INTO auth.users (id, email) VALUES
    (v_user_a, 'a@e2e.test'),
    (v_user_b, 'b@e2e.test')
    ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.tenants (id, name) VALUES
    (v_tenant_a, 'Tenant A E2E'),
    (v_tenant_b, 'Tenant B E2E');

  INSERT INTO public.profiles (id, tenant_id, name, role) VALUES
    (v_user_a, v_tenant_a, 'User A', 'admin'),
    (v_user_b, v_tenant_b, 'User B', 'admin');

  -- profiles_sync_tenant_membership também está desabilitado por causa do
  -- session_replication_role=replica acima, então semeia roles +
  -- tenant_memberships na mão: private.get_active_tenant_id() (usada por
  -- toda RLS de tenant, inclusive contacts/tenants) exige uma membership
  -- ATIVA, não só profiles.tenant_id -- sem isto o tenant resolve NULL e as
  -- asserções positivas abaixo falham (RLS nega tudo, negativas passam
  -- vácuas por engano).
  INSERT INTO public.roles (tenant_id, role_key, name, is_system) VALUES
    (v_tenant_a, 'admin', 'Administrador', true),
    (v_tenant_b, 'admin', 'Administrador', true);

  INSERT INTO public.tenant_memberships (tenant_id, user_id, role_id, status)
  SELECT v_tenant_a, v_user_a, r.id, 'active'
  FROM public.roles r WHERE r.tenant_id = v_tenant_a AND r.role_key = 'admin';

  INSERT INTO public.tenant_memberships (tenant_id, user_id, role_id, status)
  SELECT v_tenant_b, v_user_b, r.id, 'active'
  FROM public.roles r WHERE r.tenant_id = v_tenant_b AND r.role_key = 'admin';

  -- Semeia um contato em cada tenant.
  INSERT INTO public.contacts (tenant_id, name, phone)
  VALUES
    (v_tenant_a, 'Contato do A', '+5511999990001'),
    (v_tenant_b, 'Contato do B', '+5511999990002');
END $$;
SET session_replication_role = DEFAULT;

-- --------------------------------------------------------------------
-- Simula o request como user_a (JWT com sub = user_a).
-- --------------------------------------------------------------------
SET ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', current_setting('e2e.user_a'), 'role', 'authenticated')::text,
  true
);

SELECT is(
  (SELECT count(*)::int FROM public.contacts WHERE tenant_id::text = current_setting('e2e.tenant_a')),
  1,
  'User A vê o próprio contato no tenant A'
);

SELECT is(
  (SELECT count(*)::int FROM public.contacts WHERE tenant_id::text = current_setting('e2e.tenant_b')),
  0,
  'User A NÃO enxerga contatos do tenant B via SELECT direto'
);

SELECT is(
  (SELECT count(*)::int FROM public.tenants WHERE id::text = current_setting('e2e.tenant_b')),
  0,
  'User A NÃO enxerga o tenant B na tabela tenants'
);

-- Tentar inserir contato em outro tenant deve violar RLS.
SELECT throws_ok(
  format(
    $q$ INSERT INTO public.contacts (tenant_id, name, phone)
        VALUES ('%s'::uuid, 'Injetado', '+5500') $q$,
    current_setting('e2e.tenant_b')
  ),
  '42501', -- insufficient_privilege OU RLS violation (Supabase mapeia como new row violates row-level security policy)
  NULL,
  'User A não consegue inserir contato no tenant B (RLS bloqueia)'
);

-- --------------------------------------------------------------------
-- Troca para user_b: enxerga apenas o tenant B.
-- --------------------------------------------------------------------
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', current_setting('e2e.user_b'), 'role', 'authenticated')::text,
  true
);

SELECT is(
  (SELECT count(*)::int FROM public.contacts WHERE tenant_id::text = current_setting('e2e.tenant_b')),
  1,
  'User B vê o próprio contato no tenant B'
);

SELECT is(
  (SELECT count(*)::int FROM public.contacts WHERE tenant_id::text = current_setting('e2e.tenant_a')),
  0,
  'User B NÃO enxerga contatos do tenant A'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
