-- Épico D — Persona de IA por tenant: colunas novas em ai_settings +
-- policy "ai_settings tenant read" (achado crítico: sem ela, não-admin não
-- via nem SELECT). Roda contra o shadow DB local (pnpm test:db) — NÃO
-- rodado nesta sessão (stack local compartilhada entre agentes em
-- paralelo; ver notas do PR).
begin;
create extension if not exists pgtap;

select plan(7);

-- =============================================================================
-- 1. Colunas novas + constraint de tamanho do emoji.
-- =============================================================================
select has_column('public', 'ai_settings', 'ai_name', 'ai_settings.ai_name existe');
select has_column('public', 'ai_settings', 'ai_avatar_emoji', 'ai_settings.ai_avatar_emoji existe');

-- =============================================================================
-- 2. Fixture: 2 tenants (admin A e admin B) via handle_new_user.
-- =============================================================================
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'admin-a-persona@test.local'),
  ('22222222-2222-2222-2222-222222222222', 'admin-b-persona@test.local');

-- Fixture: profile NÃO-ADMIN (role='agent') no MESMO tenant do admin A, via invite.
insert into public.invites (tenant_id, email, role, token)
select tenant_id, 'agent-a-persona@test.local', 'agent', 'test-invite-token-persona'
from public.profiles where id = '11111111-1111-1111-1111-111111111111';

insert into auth.users (id, email, raw_user_meta_data) values
  ('33333333-3333-3333-3333-333333333333', 'agent-a-persona@test.local',
   jsonb_build_object('invite_token', 'test-invite-token-persona'));

-- =============================================================================
-- 3. Admin A configura a persona do próprio tenant (upsert, fluxo real da UI).
-- =============================================================================
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '11111111-1111-1111-1111-111111111111', 'role', 'authenticated')::text,
  false
);
set local role authenticated;

insert into public.ai_settings (tenant_id, ai_name, ai_avatar_emoji)
select tenant_id, 'Bia', '🤖'
from public.profiles where id = '11111111-1111-1111-1111-111111111111'
on conflict (tenant_id) do update set ai_name = excluded.ai_name, ai_avatar_emoji = excluded.ai_avatar_emoji;

select is(
  (select ai_name from public.ai_settings ais
    join public.profiles p on p.tenant_id = ais.tenant_id
    where p.id = '11111111-1111-1111-1111-111111111111'),
  'Bia',
  'admin do tenant consegue configurar ai_name (policy admin all cobre INSERT/UPDATE)'
);

reset role;

-- =============================================================================
-- 4. ACHADO CRÍTICO coberto: agent (não-admin) do MESMO tenant consegue
--    SELECT graças à nova policy "ai_settings tenant read" (sem ela, esta
--    query voltava vazia mesmo com a linha existindo).
-- =============================================================================
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '33333333-3333-3333-3333-333333333333', 'role', 'authenticated')::text,
  false
);
set local role authenticated;

select is(
  (select ai_name from public.ai_settings ais
    join public.profiles p on p.tenant_id = ais.tenant_id
    where p.id = '33333333-3333-3333-3333-333333333333'),
  'Bia',
  'agent (não-admin) do mesmo tenant CONSEGUE ler ai_name via "ai_settings tenant read"'
);

-- Não-admin continua bloqueado de ESCREVER (só a policy admin all cobre INSERT/UPDATE).
-- Investigado manualmente (psql direto): o UPDATE roda sem lançar exceção
-- (Postgres não lança para UPDATE que a cláusula USING de "ai_settings admin
-- all" filtra silenciosamente -- diferente de INSERT, que sim lança "new row
-- violates row-level security policy"). "UPDATE 0" confirmado, e o dado
-- permanece 'Bia' mesmo lido com bypass de RLS -- não é buraco de
-- segurança, é o throws_ok que assumia o mecanismo errado. A asserção certa
-- é conferir que o valor não mudou.
update public.ai_settings set ai_name = 'Hackeado'
  where tenant_id = (select tenant_id from public.profiles where id = '33333333-3333-3333-3333-333333333333');

select is(
  (select ai_name from public.ai_settings ais
    join public.profiles p on p.tenant_id = ais.tenant_id
    where p.id = '33333333-3333-3333-3333-333333333333'),
  'Bia',
  'agent (não-admin) tenta UPDATE em ai_settings: RLS filtra a linha (0 rows), ai_name permanece inalterado'
);

reset role;

-- =============================================================================
-- 5. Isolamento entre tenants: admin B não vê a persona do tenant A.
-- =============================================================================
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '22222222-2222-2222-2222-222222222222', 'role', 'authenticated')::text,
  false
);
set local role authenticated;

select is(
  (select count(*)::int from public.ai_settings ais
    join public.profiles p on p.tenant_id = ais.tenant_id
    where p.id = '11111111-1111-1111-1111-111111111111'),
  0,
  'admin B não enxerga ai_settings do tenant A (isolamento por tenant mantido)'
);

reset role;

-- =============================================================================
-- 6. Constraint de tamanho do emoji (char_length <= 4).
-- =============================================================================
select throws_ok(
  $$
    update public.ai_settings set ai_avatar_emoji = '123456'
    where tenant_id = (select tenant_id from public.profiles where id = '11111111-1111-1111-1111-111111111111')
  $$,
  NULL,
  'ai_avatar_emoji > 4 chars é rejeitado pelo check constraint'
);

select * from finish();
rollback;
