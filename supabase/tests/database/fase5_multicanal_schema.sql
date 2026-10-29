-- Fase 5 (multi-canal genérico) — schema base: colunas novas em
-- public.channels, unique index de webhook_token, novo vocabulário de
-- status de conexão, coluna provider em messaging_webhook_events (rodar:
-- pnpm test:db). Roda contra o shadow DB local (supabase test db --local),
-- que reaplica todas as migrations do zero -- não toca a DB real do Lovable.
begin;
create extension if not exists pgtap;

select plan(24);

-- 1-5. Colunas novas existem em public.channels.
select has_column('public', 'channels', 'status_message', 'channels.status_message existe');
select has_column('public', 'channels', 'last_connected_at', 'channels.last_connected_at existe');
select has_column('public', 'channels', 'webhook_health', 'channels.webhook_health existe');
select has_column('public', 'channels', 'webhook_health_checked_at', 'channels.webhook_health_checked_at existe');
select has_column('public', 'channels', 'webhook_token', 'channels.webhook_token existe');

-- 6. provider existe em messaging_webhook_events.
select has_column('public', 'messaging_webhook_events', 'provider', 'messaging_webhook_events.provider existe');

-- 7. Default de channels.status agora é 'pending' (idioma pgTAP,
--    independente de como o Postgres renderiza o literal do default).
select col_default_is(
  'public', 'channels', 'status', 'pending',
  'default de channels.status é pending'
);

-- Fixture: tenant via handle_new_user (mesmo padrão dos demais testes de
-- schema deste projeto).
insert into auth.users (id, email) values
  ('55555555-5555-5555-5555-555555555555', 'admin-multicanal@test.local');

-- 8. unique index de webhook_token -- comportamento real (não só
--    existência): dois canais com o MESMO webhook_token colidem.
insert into public.channels (tenant_id, type, provider_slug, status, webhook_token)
select tenant_id, 'whatsapp', 'evolution', 'pending', 'tok-mesmo-webhook'
from public.profiles where id = '55555555-5555-5555-5555-555555555555';

select throws_ok(
  $$insert into public.channels (tenant_id, type, provider_slug, status, webhook_token)
    select tenant_id, 'whatsapp', 'evolution-2', 'pending', 'tok-mesmo-webhook'
    from public.profiles where id = '55555555-5555-5555-5555-555555555555'$$,
  '23505',
  NULL,
  'insert com webhook_token duplicado é rejeitado pelo unique index (23505)'
);

-- 9. webhook_token null não colide -- índice é parcial (where webhook_token
--    is not null), dois canais sem token nunca conflitam entre si.
insert into public.channels (tenant_id, type, provider_slug, status)
select tenant_id, 'whatsapp', 'evolution-3', 'pending'
from public.profiles where id = '55555555-5555-5555-5555-555555555555';
insert into public.channels (tenant_id, type, provider_slug, status)
select tenant_id, 'whatsapp', 'evolution-4', 'pending'
from public.profiles where id = '55555555-5555-5555-5555-555555555555';

select is(
  (select count(*)::int from public.channels
    where provider_slug in ('evolution-3', 'evolution-4') and webhook_token is null),
  2,
  'dois canais com webhook_token null coexistem (índice parcial não bloqueia)'
);

-- 10. CHECK novo de status -- valor do vocabulário ANTIGO agora é rejeitado.
select throws_ok(
  $$insert into public.channels (tenant_id, type, provider_slug, status)
    select tenant_id, 'whatsapp', 'evolution-5', 'active'
    from public.profiles where id = '55555555-5555-5555-5555-555555555555'$$,
  '23514',
  NULL,
  'status = active (vocabulário antigo) é rejeitado pelo CHECK novo'
);

-- 11-12. CHECK novo de status -- valores novos de conexão são aceitos.
select lives_ok(
  $$insert into public.channels (tenant_id, type, provider_slug, status)
    select tenant_id, 'whatsapp', 'evolution-6', 'connecting'
    from public.profiles where id = '55555555-5555-5555-5555-555555555555'$$,
  'status = connecting (vocabulário novo) é aceito'
);
select lives_ok(
  $$insert into public.channels (tenant_id, type, provider_slug, status)
    select tenant_id, 'whatsapp', 'evolution-7', 'waiting_qr'
    from public.profiles where id = '55555555-5555-5555-5555-555555555555'$$,
  'status = waiting_qr (vocabulário novo) é aceito'
);

-- =========================================================================
-- Fixtures para a migration de onboarding do Evolution (20260712110000):
-- webhook_token protegido por grant coluna-a-coluna + RPC
-- get_channel_webhook_tokens() admin-only.
-- =========================================================================

-- Fixture: convite + usuário não-admin (role='agent') no MESMO tenant do
-- admin '55555555-...' -- mesmo padrão de fase3_hitl_rpcs.sql (invites.token
-- precisa bater com raw_user_meta_data->>'invite_token').
insert into public.invites (tenant_id, email, role, token)
select tenant_id, 'agent-multicanal@test.local', 'agent', 'test-invite-token-multicanal'
from public.profiles where id = '55555555-5555-5555-5555-555555555555';

insert into auth.users (id, email, raw_user_meta_data) values
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'agent-multicanal@test.local',
   jsonb_build_object('invite_token', 'test-invite-token-multicanal'));

-- Fixture: tenant B (admin próprio via handle_new_user, sem convite) + 1
-- canal Evolution com webhook_token DIFERENTE -- prova de isolamento entre
-- tenants na RPC.
insert into auth.users (id, email) values
  ('66666666-6666-6666-6666-666666666666', 'admin-b-multicanal@test.local');

insert into public.channels (tenant_id, type, provider_slug, status, webhook_token)
select tenant_id, 'whatsapp', 'evolution', 'pending', 'tok-tenant-b'
from public.profiles where id = '66666666-6666-6666-6666-666666666666';

-- 13-14. Catálogo: entrada 'evolution' existe e está available.
select is(
  (select count(*)::int from public.integrations where slug = 'evolution'),
  1,
  'catálogo tem exatamente 1 linha para slug=evolution'
);
select is(
  (select available from public.integrations where slug = 'evolution'),
  true,
  'integrations.evolution está available=true'
);

-- 15-16. RPC get_channel_webhook_tokens existe e é executável por authenticated.
select has_function('public', 'get_channel_webhook_tokens', 'get_channel_webhook_tokens existe');
select ok(
  has_function_privilege('authenticated', 'public.get_channel_webhook_tokens()', 'execute'),
  'authenticated pode executar get_channel_webhook_tokens'
);

select set_config(
  'request.jwt.claims',
  json_build_object('sub', '55555555-5555-5555-5555-555555555555', 'role', 'authenticated')::text,
  false
);
set local role authenticated;

-- 17. SELECT direto de webhook_token por authenticated é negado -- prova do
--     grant coluna-a-coluna (revoke select on channels + grant select sem
--     webhook_token). SQLSTATE 42501 (insufficient_privilege), não texto de
--     mensagem (version-brittle entre versões do Postgres).
select throws_ok(
  $$select webhook_token from public.channels limit 1$$,
  '42501',
  NULL,
  'authenticated não consegue SELECT direto de channels.webhook_token (coluna não concedida)'
);

-- 17b. last_status_reason PRECISA estar concedida: é lida por
--      useTenantChannels() em src/lib/api/integrations.ts. Sem o grant, a
--      tela de Integrações quebra com 42501 (regressão real de 2026-07-31).
select lives_ok(
  $$select last_status_reason from public.channels limit 1$$,
  'authenticated consegue SELECT de channels.last_status_reason'
);

-- 17c. qr_code também é segredo -- só sai via RPC get_channel_qr_codes().
select throws_ok(
  $$select qr_code from public.channels limit 1$$,
  '42501',
  NULL,
  'authenticated não consegue SELECT direto de channels.qr_code'
);


-- 18. Admin do tenant A chama a RPC e recebe o PRÓPRIO webhook_token --
--     prova que SECURITY DEFINER contorna o revoke acima (o join só toca
--     colunas concedidas de channels: id/provider_slug).
select is(
  (
    select wt.webhook_token
    from public.get_channel_webhook_tokens() wt
    join public.channels c on c.id = wt.channel_id
    where c.provider_slug = 'evolution'
  ),
  'tok-mesmo-webhook',
  'admin do tenant A recebe via RPC o webhook_token do próprio canal evolution'
);

reset role;

select set_config(
  'request.jwt.claims',
  json_build_object('sub', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'role', 'authenticated')::text,
  false
);
set local role authenticated;

-- 19. Não-admin (agent, MESMO tenant do admin A) chama a RPC e recebe 0
--     linhas -- is_admin() no WHERE filtra silenciosamente, sem exceção.
select is(
  (select count(*)::int from public.get_channel_webhook_tokens()),
  0,
  'agent (não-admin) chamando a RPC recebe 0 linhas -- is_admin() filtra'
);

reset role;

select set_config(
  'request.jwt.claims',
  json_build_object('sub', '66666666-6666-6666-6666-666666666666', 'role', 'authenticated')::text,
  false
);
set local role authenticated;

-- 20-21. Admin do tenant B chama a RPC e recebe SÓ o próprio token --
--        isolamento entre tenants (tenant_id no WHERE da RPC).
select is(
  (select count(*)::int from public.get_channel_webhook_tokens()),
  1,
  'admin do tenant B recebe exatamente 1 linha (o próprio canal)'
);
select is(
  (select webhook_token from public.get_channel_webhook_tokens() limit 1),
  'tok-tenant-b',
  'admin do tenant B recebe o PRÓPRIO token, nunca o do tenant A'
);

reset role;

-- 22. Guarda-corpo de drift: a lista de colunas de channels concedidas a
--     `authenticated` tem que ser EXATAMENTE esta. Coluna nova sem grant
--     (quebra a UI) ou grant amplo demais (vaza segredo) falha aqui, no CI,
--     em vez de falhar na tela do usuário.
select is(
  (
    select array_agg(a.attname::text order by a.attname)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    cross join lateral aclexplode(a.attacl) x
    where n.nspname = 'public'
      and c.relname = 'channels'
      and x.grantee::regrole::text = 'authenticated'
      and x.privilege_type = 'SELECT'
  ),
  array[
    'config', 'created_at', 'id', 'last_connected_at', 'last_status_reason',
    'provider_slug', 'status', 'status_message', 'tenant_id', 'type',
    'updated_at', 'webhook_health', 'webhook_health_checked_at'
  ]::text[],
  'grants coluna-a-coluna de channels para authenticated batem com a allowlist (sem webhook_token/qr_code)'
);

select * from finish();
rollback;
