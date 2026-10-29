-- Fase 3 HITL — RLS: isolamento de tenant, UPDATE direto bloqueado,
-- toggle_authority de feature-flags. Rodar: pnpm test:db.
begin;
create extension if not exists pgtap;

select plan(15);

-- Fixture: 2 tenants via handle_new_user (trigger em auth.users).
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'admin-a@test.local'),
  ('22222222-2222-2222-2222-222222222222', 'admin-b@test.local');

-- Fixture: 1 hitl_decision por tenant (não depende de deal/board).
insert into public.hitl_decisions (tenant_id, type, priority, category, title, status)
select tenant_id, 'test', 'medium', 'routine', 'decisão do tenant A', 'pending'
from public.profiles where id = '11111111-1111-1111-1111-111111111111';

insert into public.hitl_decisions (tenant_id, type, priority, category, title, status)
select tenant_id, 'test', 'medium', 'routine', 'decisão do tenant B', 'pending'
from public.profiles where id = '22222222-2222-2222-2222-222222222222';

-- Fixture: 1 messaging_template draft por tenant.
insert into public.messaging_templates (tenant_id, name, body, is_draft, status, created_by)
select tenant_id, 'draft-a', 'corpo a', true, 'pending', '11111111-1111-1111-1111-111111111111'
from public.profiles where id = '11111111-1111-1111-1111-111111111111';

insert into public.messaging_templates (tenant_id, name, body, is_draft, status, created_by)
select tenant_id, 'draft-b', 'corpo b', true, 'pending', '22222222-2222-2222-2222-222222222222'
from public.profiles where id = '22222222-2222-2222-2222-222222222222';

select set_config(
  'request.jwt.claims',
  json_build_object('sub', '11111111-1111-1111-1111-111111111111', 'role', 'authenticated')::text,
  false
);
set local role authenticated;

-- 1-2. Isolamento de tenant: admin A só vê a própria decisão/draft.
select is(
  (select count(*)::int from public.hitl_decisions),
  1,
  'admin A vê só 1 hitl_decisions (a própria, não a do tenant B)'
);
select is(
  (select title from public.hitl_decisions limit 1),
  'decisão do tenant A',
  'admin A vê exatamente a decisão do próprio tenant'
);
select is(
  (select count(*)::int from public.messaging_templates),
  1,
  'admin A vê só 1 messaging_templates (o próprio draft, não o do tenant B)'
);

-- 3. UPDATE direto em hitl_decisions bloqueado por RLS (fix de review) --
--    afeta 0 linhas, não lança exceção (RLS filtra, não nega o comando).
update public.hitl_decisions set status = 'approved' where title = 'decisão do tenant A';
select is(
  (select status from public.hitl_decisions where title = 'decisão do tenant A'),
  'pending',
  'UPDATE direto em hitl_decisions não muda nada (sem policy de UPDATE para authenticated)'
);

reset role;

-- 4. Feature-flag catalog: seed + toggle_authority.
insert into public.ai_feature_catalog (feature_key, label, default_enabled, toggle_authority)
values
  ('test_tenant_admin_flag', 'Flag de teste (tenant_admin)', false, 'tenant_admin'),
  ('test_operator_flag', 'Flag de teste (operator)', false, 'operator'),
  ('test_tenant_admin_flag_agent', 'Flag de teste (tenant_admin) p/ agent', false, 'tenant_admin');

select set_config(
  'request.jwt.claims',
  json_build_object('sub', '11111111-1111-1111-1111-111111111111', 'role', 'authenticated')::text,
  false
);
set local role authenticated;

-- 5. Admin liga flag tenant_admin-authority do PRÓPRIO tenant -- sucesso.
insert into public.tenant_ai_features (tenant_id, feature_key, enabled, updated_by)
select tenant_id, 'test_tenant_admin_flag', true, '11111111-1111-1111-1111-111111111111'
from public.profiles where id = '11111111-1111-1111-1111-111111111111';

select is(
  (select enabled from public.tenant_ai_features where feature_key = 'test_tenant_admin_flag'),
  true,
  'admin liga flag tenant_admin-authority do próprio tenant'
);

update public.tenant_ai_features set enabled = false where feature_key = 'test_tenant_admin_flag';
select is(
  (select enabled from public.tenant_ai_features where feature_key = 'test_tenant_admin_flag'),
  false,
  'admin também consegue desligar de volta (UPDATE funciona pra tenant_admin-authority)'
);

reset role;

-- 6. Admin NÃO consegue mexer em flag operator-authority (só service_role) --
--    2 asserts porque INSERT e UPDATE passam por caminhos de RLS distintos:
--    (a) o INSERT roda DE VERDADE sob authenticated (fix de review: antes
--    esse INSERT rodava como o role de conexão, ANTES do "set local role
--    authenticated", nunca testando RLS de verdade) e é REJEITADO com
--    exceção -- WITH CHECK reprovado, nenhuma policy de INSERT cobre
--    'operator'; (b) o UPDATE roda sobre uma linha semeada via service_role
--    e é filtrado silenciosamente -- USING reprovado, 0 linhas afetadas,
--    sem erro. Os dois precisam de assert: são comportamentos de RLS
--    diferentes (exceção vs. filtro silencioso) e o teste antigo só cobria
--    (b).
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '11111111-1111-1111-1111-111111111111', 'role', 'authenticated')::text,
  false
);
set local role authenticated;

select throws_ok(
  $$
    insert into public.tenant_ai_features (tenant_id, feature_key, enabled, updated_by)
    select tenant_id, 'test_operator_flag', true, '11111111-1111-1111-1111-111111111111'
    from public.profiles where id = '11111111-1111-1111-1111-111111111111'
  $$,
  'new row violates row-level security policy for table "tenant_ai_features"',
  'admin NÃO consegue LIGAR (INSERT) flag operator-authority -- RLS rejeita o INSERT inteiro'
);

reset role;

-- Semeia a linha via service_role (bypassa RLS) só pra ter o que tentar (e
-- falhar) desligar no assert de UPDATE abaixo -- o INSERT acima já provou
-- que a via normal (authenticated) é bloqueada desde a criação da linha.
insert into public.tenant_ai_features (tenant_id, feature_key, enabled, updated_by)
select tenant_id, 'test_operator_flag', true, '11111111-1111-1111-1111-111111111111'
from public.profiles where id = '11111111-1111-1111-1111-111111111111';

select set_config(
  'request.jwt.claims',
  json_build_object('sub', '11111111-1111-1111-1111-111111111111', 'role', 'authenticated')::text,
  false
);
set local role authenticated;

update public.tenant_ai_features set enabled = false where feature_key = 'test_operator_flag';
select is(
  (select enabled from public.tenant_ai_features where feature_key = 'test_operator_flag'),
  true,
  'admin NÃO consegue desligar flag operator-authority (UPDATE não afeta nada)'
);

reset role;

-- 7. Admin de B não vê nem consegue mexer na flag de A -- isolamento de
--    tenant, independente de toggle_authority. Marca um valor conhecido
--    (true) antes de trocar de role, pra distinguir "bloqueado" de
--    "coincidentemente já era esse valor".
update public.tenant_ai_features set enabled = true where feature_key = 'test_tenant_admin_flag';

select set_config(
  'request.jwt.claims',
  json_build_object('sub', '22222222-2222-2222-2222-222222222222', 'role', 'authenticated')::text,
  false
);
set local role authenticated;

select is(
  (select count(*)::int from public.tenant_ai_features),
  0,
  'admin B não vê nenhuma linha de tenant_ai_features do tenant A'
);

update public.tenant_ai_features
  set enabled = false
  where feature_key = 'test_tenant_admin_flag';

reset role;

select is(
  (select enabled from public.tenant_ai_features where feature_key = 'test_tenant_admin_flag'),
  true,
  'admin B não consegue alterar flag do tenant A (UPDATE de B não afetou a linha, continua true)'
);

-- 8. Sem profile (uid aleatório): fail-closed total.
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '99999999-9999-9999-9999-999999999999', 'role', 'authenticated')::text,
  false
);
set local role authenticated;

select is(
  (select count(*)::int from public.hitl_decisions),
  0,
  'usuário sem profile não vê nenhum hitl_decisions (fail-closed)'
);

reset role;

-- 9. Fixture: profile NÃO-ADMIN (role='agent') no MESMO tenant do admin A,
--    via invite -- a versão final de handle_new_user exige
--    raw_user_meta_data->>'invite_token' batendo com invites.token (só
--    bater e-mail não basta, mudou depois da 1a versão da função).
insert into public.invites (tenant_id, email, role, token)
select tenant_id, 'agent-a@test.local', 'agent', 'test-invite-token-fixed'
from public.profiles where id = '11111111-1111-1111-1111-111111111111';

insert into auth.users (id, email, raw_user_meta_data) values
  ('44444444-4444-4444-4444-444444444444', 'agent-a@test.local', jsonb_build_object('invite_token', 'test-invite-token-fixed'));

select is(
  (select role from public.profiles where id = '44444444-4444-4444-4444-444444444444'),
  'agent',
  'fixture: agent-a vira profile role=agent (não-admin) via invite aceito'
);
select is(
  (select tenant_id from public.profiles where id = '44444444-4444-4444-4444-444444444444'),
  (select tenant_id from public.profiles where id = '11111111-1111-1111-1111-111111111111'),
  'fixture: agent-a fica no MESMO tenant do admin A que convidou (não cria tenant novo)'
);

-- 10. Não-admin (agent) é bloqueado de escrever em messaging_templates --
--     policy "messaging_templates admin all" exige is_admin().
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '44444444-4444-4444-4444-444444444444', 'role', 'authenticated')::text,
  false
);
set local role authenticated;

select throws_ok(
  $$
    insert into public.messaging_templates (tenant_id, name, body, is_draft, status, created_by)
    select tenant_id, 'agent-draft', 'corpo agent', true, 'pending', '44444444-4444-4444-4444-444444444444'
    from public.profiles where id = '44444444-4444-4444-4444-444444444444'
  $$,
  'new row violates row-level security policy for table "messaging_templates"',
  'não-admin (agent) é bloqueado de INSERT em messaging_templates'
);

reset role;

-- 11. Não-admin (agent) do tenant CERTO é bloqueado de LIGAR flag
--     tenant_admin-authority -- cobertura que faltava: só tínhamos "admin de
--     outro tenant" (7) e "admin numa flag operator" (6), nunca "não-admin
--     do tenant certo numa flag tenant_admin".
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '44444444-4444-4444-4444-444444444444', 'role', 'authenticated')::text,
  false
);
set local role authenticated;

select throws_ok(
  $$
    insert into public.tenant_ai_features (tenant_id, feature_key, enabled, updated_by)
    select tenant_id, 'test_tenant_admin_flag_agent', true, '44444444-4444-4444-4444-444444444444'
    from public.profiles where id = '44444444-4444-4444-4444-444444444444'
  $$,
  'new row violates row-level security policy for table "tenant_ai_features"',
  'não-admin (agent) é bloqueado de LIGAR flag tenant_admin-authority mesmo no tenant certo'
);

reset role;

select * from finish();
rollback;
