-- Fase 4 PR-B (user story G) -- view deal_owner_leaderboard.
-- Roda contra o shadow DB local (supabase test db --local; pnpm test:db),
-- que reaplica todas as migrations do zero -- não toca a DB real do
-- Lovable. NÃO rodar aqui agora (fase de schema em paralelo).
--
-- Teste crítico desta view: por padrão uma view Postgres roda com os
-- privilégios do DONO (bypassa RLS) -- se security_invoker=true não
-- estivesse ativo, um teste com um único tenant "passaria" mesmo com o bug
-- (não haveria segundo tenant pra vazar dados). Por isso o teste central
-- aqui usa DOIS tenants e prova, através da própria view (não das tabelas
-- base), que cada admin só enxerga a linha do seu tenant.
begin;
create extension if not exists pgtap;

select plan(12);

-- =============================================================================
-- 1. View existe, com security_invoker=true e grant correto
-- =============================================================================
select has_view('public', 'deal_owner_leaderboard', 'view deal_owner_leaderboard existe');

select ok(
  (select reloptions from pg_class where relname = 'deal_owner_leaderboard')
    @> array['security_invoker=true'],
  'view deal_owner_leaderboard tem security_invoker=true (obrigatório -- sem isso a view bypassaria RLS de deals/profiles)'
);

select ok(
  exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name = 'deal_owner_leaderboard'
      and grantee = 'authenticated'
      and privilege_type = 'SELECT'
  ),
  'authenticated tem grant SELECT na view'
);

-- =============================================================================
-- 2. Fixture: 2 tenants via handle_new_user (trigger em auth.users), cada um
--    com board + stage + contato + deals de um mesmo owner (o próprio admin).
-- =============================================================================
insert into auth.users (id, email) values
  ('aaaaaaaa-1111-1111-1111-111111111111', 'admin-a-leaderboard@test.local'),
  ('aaaaaaaa-2222-2222-2222-222222222222', 'admin-b-leaderboard@test.local');

-- Tenant A
insert into public.boards (id, tenant_id, name, is_default)
select 'bbbbbbbb-1111-1111-1111-111111111111', tenant_id, 'Board A', true
from public.profiles where id = 'aaaaaaaa-1111-1111-1111-111111111111';

insert into public.board_stages (id, board_id, name, position) values
  ('cccccccc-1111-1111-1111-111111111111', 'bbbbbbbb-1111-1111-1111-111111111111', 'Estágio A', 0);

insert into public.contacts (id, tenant_id, name)
select 'dddddddd-1111-1111-1111-111111111111', tenant_id, 'Contato A'
from public.profiles where id = 'aaaaaaaa-1111-1111-1111-111111111111';

-- Deal A ganho (owner = admin A) -- value 1000.00
insert into public.deals (id, tenant_id, board_id, stage_id, contact_id, owner_id, title, value, status)
select 'eeeeeeee-1111-1111-1111-111111111111', tenant_id, 'bbbbbbbb-1111-1111-1111-111111111111',
  'cccccccc-1111-1111-1111-111111111111', 'dddddddd-1111-1111-1111-111111111111',
  'aaaaaaaa-1111-1111-1111-111111111111', 'Deal A ganho', 1000.00, 'won'
from public.profiles where id = 'aaaaaaaa-1111-1111-1111-111111111111';

-- Deal A perdido (owner = admin A) -- value 500.00 (não entra em total_won_value)
insert into public.deals (id, tenant_id, board_id, stage_id, contact_id, owner_id, title, value, status)
select 'eeeeeeee-1111-1111-1111-111111111112', tenant_id, 'bbbbbbbb-1111-1111-1111-111111111111',
  'cccccccc-1111-1111-1111-111111111111', 'dddddddd-1111-1111-1111-111111111111',
  'aaaaaaaa-1111-1111-1111-111111111111', 'Deal A perdido', 500.00, 'lost'
from public.profiles where id = 'aaaaaaaa-1111-1111-1111-111111111111';

-- Deal A ganho SEM owner_id -- não deve aparecer em nenhuma linha nem
-- inflar wins/total_won_value do admin A (prova o join/where owner_id is not null).
insert into public.deals (id, tenant_id, board_id, stage_id, contact_id, owner_id, title, value, status)
select 'eeeeeeee-1111-1111-1111-111111111113', tenant_id, 'bbbbbbbb-1111-1111-1111-111111111111',
  'cccccccc-1111-1111-1111-111111111111', 'dddddddd-1111-1111-1111-111111111111',
  null, 'Deal A sem dono', 2000.00, 'won'
from public.profiles where id = 'aaaaaaaa-1111-1111-1111-111111111111';

-- Tenant B
insert into public.boards (id, tenant_id, name, is_default)
select 'bbbbbbbb-2222-2222-2222-222222222222', tenant_id, 'Board B', true
from public.profiles where id = 'aaaaaaaa-2222-2222-2222-222222222222';

insert into public.board_stages (id, board_id, name, position) values
  ('cccccccc-2222-2222-2222-222222222222', 'bbbbbbbb-2222-2222-2222-222222222222', 'Estágio B', 0);

insert into public.contacts (id, tenant_id, name)
select 'dddddddd-2222-2222-2222-222222222222', tenant_id, 'Contato B'
from public.profiles where id = 'aaaaaaaa-2222-2222-2222-222222222222';

-- Deal B ganho (owner = admin B)
insert into public.deals (id, tenant_id, board_id, stage_id, contact_id, owner_id, title, value, status)
select 'eeeeeeee-2222-2222-2222-222222222222', tenant_id, 'bbbbbbbb-2222-2222-2222-222222222222',
  'cccccccc-2222-2222-2222-222222222222', 'dddddddd-2222-2222-2222-222222222222',
  'aaaaaaaa-2222-2222-2222-222222222222', 'Deal B ganho', 300.00, 'won'
from public.profiles where id = 'aaaaaaaa-2222-2222-2222-222222222222';

-- =============================================================================
-- 3. Admin A consulta a view: SÓ a própria linha, cálculos corretos.
-- =============================================================================
select set_config(
  'request.jwt.claims',
  json_build_object('sub', 'aaaaaaaa-1111-1111-1111-111111111111', 'role', 'authenticated')::text,
  false
);
set local role authenticated;

select is(
  (select count(*)::int from public.deal_owner_leaderboard),
  1,
  'admin A vê exatamente 1 linha na view (isolamento de tenant -- não vê a linha do tenant B)'
);

select is(
  (select tenant_id from public.deal_owner_leaderboard limit 1),
  (select tenant_id from public.profiles where id = 'aaaaaaaa-1111-1111-1111-111111111111'),
  'a linha visível por admin A pertence ao tenant A'
);

select is(
  (select wins::int from public.deal_owner_leaderboard where owner_id = 'aaaaaaaa-1111-1111-1111-111111111111'),
  1,
  'wins = 1 (só o deal ganho com owner_id -- o ganho sem owner_id não conta)'
);

select is(
  (select decided::int from public.deal_owner_leaderboard where owner_id = 'aaaaaaaa-1111-1111-1111-111111111111'),
  2,
  'decided = 2 (1 ganho + 1 perdido do mesmo owner)'
);

select is(
  (select win_rate_pct from public.deal_owner_leaderboard where owner_id = 'aaaaaaaa-1111-1111-1111-111111111111'),
  50.0,
  'win_rate_pct = 50.0 (1 ganho / 2 decididos)'
);

select is(
  (select total_won_value from public.deal_owner_leaderboard where owner_id = 'aaaaaaaa-1111-1111-1111-111111111111'),
  1000.00,
  'total_won_value = 1000.00 (só o deal ganho COM owner_id -- o de 2000.00 sem owner_id não entra)'
);

select is(
  (select count(*)::int from public.deal_owner_leaderboard where owner_id is null),
  0,
  'nenhuma linha da view tem owner_id null (deal sem owner_id nunca aparece)'
);

reset role;

-- =============================================================================
-- 4. Admin B consulta a view: SÓ a própria linha (prova reversa de isolamento).
-- =============================================================================
select set_config(
  'request.jwt.claims',
  json_build_object('sub', 'aaaaaaaa-2222-2222-2222-222222222222', 'role', 'authenticated')::text,
  false
);
set local role authenticated;

select is(
  (select count(*)::int from public.deal_owner_leaderboard),
  1,
  'admin B vê exatamente 1 linha na view (isolamento de tenant -- não vê a linha do tenant A)'
);

select is(
  (select tenant_id from public.deal_owner_leaderboard limit 1),
  (select tenant_id from public.profiles where id = 'aaaaaaaa-2222-2222-2222-222222222222'),
  'a linha visível por admin B pertence ao tenant B (nunca ao tenant A)'
);

reset role;

select * from finish();
rollback;
