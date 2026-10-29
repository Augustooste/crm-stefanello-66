-- Reproduz a ACL de produção: authenticated sem USAGE no schema private.
-- public.find_duplicate_contacts() precisa responder ao admin do tenant sem
-- afrouxar a autorização: não lança para o admin, retorna só o grupo do tenant
-- do chamador (sem vazar contatos de outro tenant) e segue negada a anon.
-- A resolução do tenant replica private.get_active_tenant_id(): active_tenant_id
-- do JWT tem precedência sobre o perfil, perfil desativado não conta e o
-- candidato exige membership ativa.
begin;
select plan(10);

set session_replication_role = replica;
insert into public.tenants(id, name) values
 ('d0000000-0000-4000-8000-000000000001', 'Tenant A (Clínica)'),
 ('d0000000-0000-4000-8000-000000000002', 'Tenant B (Outra)');
insert into auth.users(id, email) values
 ('d0000000-0000-4000-8000-000000000011', 'dup-admin-a@test.invalid'),
 ('d0000000-0000-4000-8000-000000000012', 'dup-desativado@test.invalid'),
 ('d0000000-0000-4000-8000-000000000013', 'dup-revogado@test.invalid');
insert into public.profiles(id, tenant_id, name, role, disabled) values
 ('d0000000-0000-4000-8000-000000000011', 'd0000000-0000-4000-8000-000000000001', 'Admin A', 'admin', false),
 ('d0000000-0000-4000-8000-000000000012', 'd0000000-0000-4000-8000-000000000001', 'Desativado A', 'admin', true),
 ('d0000000-0000-4000-8000-000000000013', 'd0000000-0000-4000-8000-000000000001', 'Revogado A', 'admin', false);
insert into public.roles(id, tenant_id, role_key, name, is_system) values
 ('d0000000-0000-4000-8000-000000000021', 'd0000000-0000-4000-8000-000000000001', 'admin', 'Admin', true),
 ('d0000000-0000-4000-8000-000000000022', 'd0000000-0000-4000-8000-000000000002', 'admin', 'Admin', true);
-- Admin A é membro ativo de A e de B; o desativado tem membership ativa em A;
-- o revogado aponta o perfil para A, mas a membership em A foi revogada.
insert into public.tenant_memberships(tenant_id, user_id, role_id, status, revoked_at) values
 ('d0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000011', 'd0000000-0000-4000-8000-000000000021', 'active', null),
 ('d0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000011', 'd0000000-0000-4000-8000-000000000022', 'active', null),
 ('d0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000012', 'd0000000-0000-4000-8000-000000000021', 'active', null),
 ('d0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000013', 'd0000000-0000-4000-8000-000000000021', 'revoked', '2026-10-01T00:00:00Z');

-- Contatos duplicados (mesmo telefone) em cada tenant.
insert into public.contacts(id, tenant_id, name, phone, email, created_at) values
 ('d0000000-0000-4000-8000-000000000101', 'd0000000-0000-4000-8000-000000000001', 'Ana Duplicada 1', '+5511999990001', 'ana1@a.test', '2026-01-01T10:00:00Z'),
 ('d0000000-0000-4000-8000-000000000102', 'd0000000-0000-4000-8000-000000000001', 'Ana Duplicada 2', '+5511999990001', 'ana2@a.test', '2026-01-02T10:00:00Z'),
 ('d0000000-0000-4000-8000-000000000201', 'd0000000-0000-4000-8000-000000000002', 'Bia Duplicada 1', '+5511999990002', 'bia1@b.test', '2026-01-03T10:00:00Z'),
 ('d0000000-0000-4000-8000-000000000202', 'd0000000-0000-4000-8000-000000000002', 'Bia Duplicada 2', '+5511999990002', 'bia2@b.test', '2026-01-04T10:00:00Z');
set session_replication_role = default;

revoke usage on schema private from authenticated;
select ok(not has_schema_privilege('authenticated', 'private', 'USAGE'), 'Teste reproduz a ACL de produção');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"d0000000-0000-4000-8000-000000000011","role":"authenticated"}', true);

select lives_ok('select public.find_duplicate_contacts()', 'Admin A executa sem USAGE em private');

select is(
  (select g->>'group_size'
     from jsonb_array_elements(public.find_duplicate_contacts()) g
    where g->>'match_value' = '+5511999990001'),
  '2', 'Grupo duplicado de A tem 2 contatos');

select ok(
  (select g->'contact_ids' ?& array['d0000000-0000-4000-8000-000000000101','d0000000-0000-4000-8000-000000000102']
     from jsonb_array_elements(public.find_duplicate_contacts()) g
    where g->>'match_value' = '+5511999990001'),
  'Grupo de A contém os dois contatos do tenant A');

select ok(
  not exists (
    select 1 from jsonb_array_elements(public.find_duplicate_contacts()) g
    where g->>'match_value' = '+5511999990002'
       or g->'contact_ids' ?| array['d0000000-0000-4000-8000-000000000201','d0000000-0000-4000-8000-000000000202']
  ),
  'Não vaza contatos do tenant B');

-- active_tenant_id do JWT (B) vence o tenant do perfil (A).
select set_config('request.jwt.claims', '{"sub":"d0000000-0000-4000-8000-000000000011","role":"authenticated","app_metadata":{"active_tenant_id":"d0000000-0000-4000-8000-000000000002"}}', true);

select is(
  (select g->>'group_size'
     from jsonb_array_elements(public.find_duplicate_contacts()) g
    where g->>'match_value' = '+5511999990002'),
  '2', 'Com active_tenant_id = B no JWT, retorna o grupo duplicado de B');

select ok(
  not exists (
    select 1 from jsonb_array_elements(public.find_duplicate_contacts()) g
    where g->>'match_value' = '+5511999990001'
       or g->'contact_ids' ?| array['d0000000-0000-4000-8000-000000000101','d0000000-0000-4000-8000-000000000102']
  ),
  'Com active_tenant_id = B no JWT, não retorna contatos do tenant A do perfil');

-- Perfil desativado não serve de candidato a tenant.
select set_config('request.jwt.claims', '{"sub":"d0000000-0000-4000-8000-000000000012","role":"authenticated"}', true);
select throws_ok('select public.find_duplicate_contacts()', '42501', null, 'Perfil desativado é negado');

-- Tenant do perfil sem membership ativa é negado.
select set_config('request.jwt.claims', '{"sub":"d0000000-0000-4000-8000-000000000013","role":"authenticated"}', true);
select throws_ok('select public.find_duplicate_contacts()', '42501', null, 'Sem membership ativa no tenant do perfil é negado');

reset role;
set local role anon;
select throws_ok('select public.find_duplicate_contacts()', '42501', null, 'anon não executa');
reset role;

select * from finish();
rollback;
