-- handle_new_user — convite que não resolve tem que falhar o cadastro, nunca
-- abrir tenant fantasma (migration 20260810140000). Rodar: pnpm test:db.
begin;
create extension if not exists pgtap;

select plan(11);

-- Fixture: usuário sem convite vira dono do próprio tenant. É o self-serve, e
-- é justamente o comportamento que a migration NÃO pode ter quebrado.
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'dono@test.local');

select is(
  (select count(*)::integer from public.profiles
    where id = 'aaaaaaaa-0000-0000-0000-000000000001' and role = 'admin'),
  1,
  'cadastro sem token continua criando tenant próprio com o usuário como admin'
);

-- Convite válido no tenant do dono.
insert into public.invites (tenant_id, email, role, token)
select tenant_id, 'convidado@test.local', 'agent', 'token-valido'
  from public.profiles where id = 'aaaaaaaa-0000-0000-0000-000000000001';

insert into auth.users (id, email, raw_user_meta_data) values
  ('aaaaaaaa-0000-0000-0000-000000000002', 'convidado@test.local',
   jsonb_build_object('invite_token', 'token-valido'));

select is(
  (select p.tenant_id from public.profiles p
    where p.id = 'aaaaaaaa-0000-0000-0000-000000000002'),
  (select p.tenant_id from public.profiles p
    where p.id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  'convite válido põe o convidado no tenant de quem convidou'
);

select is(
  (select role from public.profiles where id = 'aaaaaaaa-0000-0000-0000-000000000002'),
  'agent',
  'convite válido aplica o papel do convite, não admin'
);

select isnt(
  (select accepted_at from public.invites where token = 'token-valido'),
  null,
  'convite válido é marcado como aceito'
);

-- Token que não existe.
select throws_ok(
  $$insert into auth.users (id, email, raw_user_meta_data) values
      ('aaaaaaaa-0000-0000-0000-000000000003', 'fantasma@test.local',
       jsonb_build_object('invite_token', 'token-que-nao-existe'))$$,
  '22023',
  'Convite inválido, expirado ou emitido para outro e-mail',
  'token inexistente aborta o cadastro em vez de criar tenant novo'
);

-- Token real, mas vencido.
insert into public.invites (tenant_id, email, role, token, expires_at)
select tenant_id, 'atrasado@test.local', 'agent', 'token-vencido', now() - interval '1 day'
  from public.profiles where id = 'aaaaaaaa-0000-0000-0000-000000000001';

select throws_ok(
  $$insert into auth.users (id, email, raw_user_meta_data) values
      ('aaaaaaaa-0000-0000-0000-000000000004', 'atrasado@test.local',
       jsonb_build_object('invite_token', 'token-vencido'))$$,
  '22023',
  'Convite inválido, expirado ou emitido para outro e-mail',
  'token expirado aborta o cadastro'
);

-- Os dois cadastros abortados não podem ter deixado nada para trás. Asserção
-- deliberadamente sobre `profiles` e não sobre "tenant órfão": no comportamento
-- antigo o tenant fantasma nascia COM membro, então contar órfão passaria nos
-- dois casos e não provaria nada.
select is(
  (select count(*)::integer from public.profiles
    where id in ('aaaaaaaa-0000-0000-0000-000000000003',
                 'aaaaaaaa-0000-0000-0000-000000000004')),
  0,
  'cadastro abortado não deixa profile nem tenant para trás'
);

-- ---------------------------------------------------------------------------
-- Convite pelo login social: sem token, casando por e-mail (20260810150000).
-- ---------------------------------------------------------------------------

insert into public.invites (tenant_id, email, role, token)
select tenant_id, 'pelo-google@test.local', 'agent', 'token-que-o-google-nao-carrega'
  from public.profiles where id = 'aaaaaaaa-0000-0000-0000-000000000001';

insert into auth.users (id, email, raw_app_meta_data) values
  ('aaaaaaaa-0000-0000-0000-000000000005', 'pelo-google@test.local',
   jsonb_build_object('provider', 'google', 'providers', jsonb_build_array('google')));

select is(
  (select p.tenant_id from public.profiles p
    where p.id = 'aaaaaaaa-0000-0000-0000-000000000005'),
  (select p.tenant_id from public.profiles p
    where p.id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  'convidado que entra pelo Google cai no tenant do convite, sem token'
);

select is(
  (select role from public.profiles where id = 'aaaaaaaa-0000-0000-0000-000000000005'),
  'agent',
  'login social aplica o papel do convite'
);

select isnt(
  (select accepted_at from public.invites where token = 'token-que-o-google-nao-carrega'),
  null,
  'convite consumido pelo login social é marcado como aceito'
);

-- O cadastro por senha NAO pode casar por e-mail: nesse caminho o endereco ainda
-- nao foi provado, e o token existe justamente para isso. Quem tem convite aberto
-- mas se cadastra com senha sem token continua indo para tenant proprio.
insert into public.invites (tenant_id, email, role, token)
select tenant_id, 'so-com-token@test.local', 'agent', 'token-obrigatorio-na-senha'
  from public.profiles where id = 'aaaaaaaa-0000-0000-0000-000000000001';

insert into auth.users (id, email, raw_app_meta_data) values
  ('aaaaaaaa-0000-0000-0000-000000000006', 'so-com-token@test.local',
   jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email')));

select isnt(
  (select p.tenant_id from public.profiles p
    where p.id = 'aaaaaaaa-0000-0000-0000-000000000006'),
  (select p.tenant_id from public.profiles p
    where p.id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  'cadastro por senha sem token nao entra no tenant do convite pelo e-mail'
);

select * from finish();
rollback;
