-- Chaves de API (Task 6): hash sha256, escopos, expiração, revogação.
-- Rodar: pnpm test:db.
begin;
create extension if not exists pgtap;

select plan(34);

-- Fixture: admin A, admin B (outro tenant) e agente C (convite no tenant A).
insert into auth.users (id, email) values
  ('a6000000-0000-4000-8000-00000000000a', 'adm-a@test.local'),
  ('a6000000-0000-4000-8000-00000000000b', 'adm-b@test.local');
insert into public.invites (tenant_id, email, role, token, expires_at)
select tenant_id, 'agente-c@test.local', 'agent', 'api-keys-agent-token', now() + interval '1 day'
from public.profiles where id = 'a6000000-0000-4000-8000-00000000000a';
insert into auth.users (id, email, raw_user_meta_data) values
  ('a6000000-0000-4000-8000-00000000000c', 'agente-c@test.local',
   '{"invite_token":"api-keys-agent-token"}');

-- 1-3. Estrutura e grants.
select has_table('public', 'api_keys', 'tabela api_keys existe');
select ok(
  coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.api_keys')), false),
  'RLS ligado em api_keys'
);
select ok(
  not exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'api_keys' and grantee in ('anon', 'PUBLIC')
  ) and not exists (
    select 1 from information_schema.role_column_grants
    where table_schema = 'public' and table_name = 'api_keys' and grantee in ('anon', 'PUBLIC')
  ),
  'anon/PUBLIC sem nenhum grant em api_keys'
);

-- 4-9. EXECUTE das RPCs.
select ok(not has_function_privilege('anon', 'public.authenticate_api_key(text)', 'EXECUTE'), 'anon não executa authenticate_api_key');
select ok(not has_function_privilege('authenticated', 'public.authenticate_api_key(text)', 'EXECUTE'), 'authenticated não executa authenticate_api_key');
select ok(has_function_privilege('service_role', 'public.authenticate_api_key(text)', 'EXECUTE'), 'service_role executa authenticate_api_key');
select ok(not has_function_privilege('anon', 'public.create_api_key(text,text[],timestamptz)', 'EXECUTE'), 'anon não executa create_api_key');
select ok(has_function_privilege('authenticated', 'public.create_api_key(text,text[],timestamptz)', 'EXECUTE'), 'authenticated executa create_api_key');
select ok(not has_function_privilege('anon', 'public.revoke_api_key(uuid)', 'EXECUTE'), 'anon não executa revoke_api_key');

-- 10. Lista de escopos.
select is(
  (select array_agg(s order by s) from unnest(public.api_allowed_scopes()) s),
  array['contacts:read', 'contacts:write', 'deals:read', 'deals:write'],
  'api_allowed_scopes() devolve os 4 escopos'
);

-- Admin A cria chave.
select set_config('request.jwt.claims', '{"sub":"a6000000-0000-4000-8000-00000000000a","role":"authenticated"}', false);
set local role authenticated;

create temp table t_created on commit drop as
  select * from public.create_api_key('chave A', array['contacts:read', 'deals:write']);
grant all on t_created to public;

-- 11. Formato do token.
select matches(
  (select token from t_created),
  '^acf_live_[A-Za-z0-9_-]{43}$',
  'token tem formato acf_live_ + 43 chars base64url'
);

-- 12-13. Admin lê a própria chave, mas não key_hash.
select is((select count(*)::int from public.api_keys), 1, 'admin A vê 1 chave');
select throws_ok($$ select key_hash from public.api_keys $$, '42501', null, 'authenticated não lê key_hash');

-- 14-16. Escritas diretas negadas.
select throws_ok(
  $$ insert into public.api_keys (tenant_id, name, key_prefix, key_hash, scopes)
     values (private.get_user_tenant_id(), 'x', 'acf_live_xxx', 'h', array['contacts:read']) $$,
  '42501', null, 'INSERT direto negado'
);
select throws_ok($$ update public.api_keys set revoked_at = null $$, '42501', null, 'UPDATE direto negado');
select throws_ok($$ delete from public.api_keys $$, '42501', null, 'DELETE direto negado');

-- 17-19. Validações de criação.
select throws_ok(
  $$ select * from public.create_api_key('ruim', array['contacts:admin']) $$,
  '22023', null, 'escopo desconhecido gera erro'
);
select throws_ok(
  $$ select * from public.create_api_key('ruim', array[]::text[]) $$,
  '22023', null, 'lista de escopos vazia gera erro'
);
select throws_ok(
  $$ select * from public.create_api_key('ruim', array['contacts:read'], now() - interval '1 day') $$,
  '22023', null, 'expires_at no passado gera erro'
);

-- 20-21. Agente (não-admin) não cria nem revoga.
select set_config('request.jwt.claims', '{"sub":"a6000000-0000-4000-8000-00000000000c","role":"authenticated"}', false);
select throws_ok(
  $$ select * from public.create_api_key('agente', array['contacts:read']) $$,
  '42501', null, 'membro não-admin não cria chave'
);
select throws_ok(
  format($$ select public.revoke_api_key(%L) $$, (select id from t_created)),
  '42501', null, 'membro não-admin não revoga chave'
);
-- Não-admin do mesmo tenant não enxerga linhas (braço private.is_admin() da policy).
select is((select count(*)::int from public.api_keys), 0, 'membro não-admin do mesmo tenant não vê chaves');

-- 22-23. Admin B não vê nem revoga chave do tenant A.
select set_config('request.jwt.claims', '{"sub":"a6000000-0000-4000-8000-00000000000b","role":"authenticated"}', false);
select is((select count(*)::int from public.api_keys), 0, 'admin B não vê chaves do tenant A');
select throws_ok(
  format($$ select public.revoke_api_key(%L) $$, (select id from t_created)),
  'P0002', null, 'admin B não revoga chave do tenant A'
);

reset role;

-- 24-26. Token nunca persistido; hash e prefixo corretos.
select is(
  (select key_hash from public.api_keys where id = (select id from t_created)),
  encode(extensions.digest((select token from t_created), 'sha256'), 'hex'),
  'key_hash = sha256(token) em hex'
);
select is(
  (select key_prefix from public.api_keys where id = (select id from t_created)),
  left((select token from t_created), 12),
  'key_prefix = primeiros 12 chars do token'
);
select is(
  (select count(*)::int from public.api_keys k where k::text like '%' || (select token from t_created) || '%'),
  0,
  'token completo não aparece em nenhuma coluna'
);

-- authenticate_api_key (como service_role).
select set_config('request.jwt.claims', '{"role":"service_role"}', false);
set local role service_role;

-- 27. Hash certo devolve escopos.
select results_eq(
  format($$ select scopes from public.authenticate_api_key(%L) $$,
    encode(extensions.digest((select token from t_created), 'sha256'), 'hex')),
  $$ values (array['contacts:read', 'deals:write']::text[]) $$,
  'hash correto autentica e devolve escopos'
);
-- 28. Hash errado.
select is((select count(*)::int from public.authenticate_api_key(repeat('0', 64))), 0, 'hash errado → 0 linhas');

-- 29-30. last_used_at: dentro de 5 min não muda; depois de 5 min atualiza.
reset role;
update public.api_keys set last_used_at = now() - interval '1 minute' where id = (select id from t_created);
set local role service_role;
select * from public.authenticate_api_key(encode(extensions.digest((select token from t_created), 'sha256'), 'hex'));
reset role;
select is(
  (select last_used_at from public.api_keys where id = (select id from t_created)),
  now() - interval '1 minute',
  'last_used_at não muda dentro de 5 min'
);
update public.api_keys set last_used_at = now() - interval '10 minutes' where id = (select id from t_created);
set local role service_role;
select * from public.authenticate_api_key(encode(extensions.digest((select token from t_created), 'sha256'), 'hex'));
reset role;
select is(
  (select last_used_at from public.api_keys where id = (select id from t_created)),
  now(),
  'last_used_at atualiza após 5 min'
);

-- 31. Expirada → 0 linhas.
update public.api_keys set expires_at = now() - interval '1 second' where id = (select id from t_created);
set local role service_role;
select is(
  (select count(*)::int from public.authenticate_api_key(encode(extensions.digest((select token from t_created), 'sha256'), 'hex'))),
  0, 'chave expirada → 0 linhas'
);
reset role;
update public.api_keys set expires_at = null where id = (select id from t_created);

-- 32-33. Revogada pelo admin → 0 linhas e revoked_at gravado.
select set_config('request.jwt.claims', '{"sub":"a6000000-0000-4000-8000-00000000000a","role":"authenticated"}', false);
set local role authenticated;
select public.revoke_api_key((select id from t_created));
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', false);
set local role service_role;
select is(
  (select count(*)::int from public.authenticate_api_key(encode(extensions.digest((select token from t_created), 'sha256'), 'hex'))),
  0, 'chave revogada → 0 linhas'
);
reset role;
select isnt(
  (select revoked_at from public.api_keys where id = (select id from t_created)),
  null, 'revoke_api_key grava revoked_at'
);

select * from finish();
rollback;
