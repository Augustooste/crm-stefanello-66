-- crm_products (v1, 20260714150000) — RLS: isolamento de tenant.
-- Motivação direta: o medflow-v0 teve um vazamento RLS real de ~2 meses em
-- `products` (policy USING(true), sem isolamento) -- este teste nasce na
-- mesma PR da tabela, não depois. Rodar: pnpm test:db.
begin;
create extension if not exists pgtap;

select plan(8);

-- Fixture: 2 tenants via handle_new_user (trigger em auth.users), mesmo
-- padrão de fase3_hitl_rls.sql.
insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin-produtos-a@test.local'),
  ('44444444-4444-4444-4444-444444444444', 'admin-produtos-b@test.local');

-- Fixture: 1 produto por tenant, semeado como service_role (bypassa RLS).
insert into public.crm_products (tenant_id, name, price, duration_minutes, sku)
select tenant_id, 'Consulta avulsa (tenant A)', 150.00, 60, 'SKU-A'
from public.profiles where id = '33333333-3333-3333-3333-333333333333';

insert into public.crm_products (tenant_id, name, price, duration_minutes, sku)
select tenant_id, 'Consulta avulsa (tenant B)', 200.00, 45, 'SKU-B'
from public.profiles where id = '44444444-4444-4444-4444-444444444444';

-- Captura o tenant_id de B numa GUC de sessão ENQUANTO ainda somos
-- superuser/service_role (bypassa RLS de `profiles`) -- é o único jeito de
-- ter esse valor à mão no teste 5 abaixo: sob `authenticated` do tenant A, um
-- `select tenant_id from profiles where id = <user B>` devolveria 0 linhas
-- (RLS de profiles também isola por tenant), e um INSERT ... SELECT com 0
-- linhas fonte não insere nada nem lança exceção -- daria falso "passou" no
-- throws_ok sem testar WITH CHECK de verdade.
select set_config(
  'test.tenant_b_id',
  (select tenant_id::text from public.profiles where id = '44444444-4444-4444-4444-444444444444'),
  false
);

select set_config(
  'request.jwt.claims',
  json_build_object('sub', '33333333-3333-3333-3333-333333333333', 'role', 'authenticated')::text,
  false
);
set local role authenticated;

-- 1-2. Isolamento de tenant: admin A só vê o próprio produto.
select is(
  (select count(*)::int from public.crm_products),
  1,
  'admin A vê só 1 crm_products (o próprio, não o do tenant B)'
);
select is(
  (select name from public.crm_products limit 1),
  'Consulta avulsa (tenant A)',
  'admin A vê exatamente o produto do próprio tenant'
);

-- 3. Admin A não enxerga o produto do tenant B nem pelo id direto (RLS
--    filtra a linha, não só a listagem).
select is(
  (select count(*)::int from public.crm_products
    where id in (select id from public.crm_products where name = 'Consulta avulsa (tenant B)')),
  0,
  'admin A não enxerga o produto do tenant B mesmo filtrando por id'
);

reset role;

-- 4. UPDATE direto num produto de outro tenant, tentado sob authenticated do
--    tenant A visando o id do produto B (via subselect service_role só pra
--    achar o id -- a tentativa de UPDATE em si roda sob authenticated):
--    afeta 0 linhas, RLS filtra silenciosamente (USING reprovado), não lança
--    exceção.
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '33333333-3333-3333-3333-333333333333', 'role', 'authenticated')::text,
  false
);
set local role authenticated;

update public.crm_products set price = 1.00
  where name = 'Consulta avulsa (tenant B)';

reset role;

select is(
  (select price from public.crm_products where name = 'Consulta avulsa (tenant B)'),
  200.00,
  'UPDATE de admin A no produto do tenant B não afeta nada (RLS filtra, preço intacto)'
);

-- 5. INSERT com tenant_id de outro tenant é rejeitado pelo WITH CHECK --
--    RLS reprova o comando inteiro (exceção), não filtra silenciosamente.
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '33333333-3333-3333-3333-333333333333', 'role', 'authenticated')::text,
  false
);
set local role authenticated;

select throws_ok(
  $$
    insert into public.crm_products (tenant_id, name)
    values (current_setting('test.tenant_b_id')::uuid, 'produto injetado no tenant B')
  $$,
  'new row violates row-level security policy for table "crm_products"',
  'admin A não consegue INSERT em crm_products com tenant_id de outro tenant'
);

reset role;

-- 6-7. Admin B, simetricamente, só vê o próprio produto e não o de A.
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '44444444-4444-4444-4444-444444444444', 'role', 'authenticated')::text,
  false
);
set local role authenticated;

select is(
  (select count(*)::int from public.crm_products),
  1,
  'admin B vê só 1 crm_products (o próprio, não o do tenant A)'
);
select is(
  (select name from public.crm_products limit 1),
  'Consulta avulsa (tenant B)',
  'admin B vê exatamente o produto do próprio tenant'
);

-- 8. DELETE de admin B tentando remover o produto de A: afeta 0 linhas.
delete from public.crm_products where name = 'Consulta avulsa (tenant A)';

reset role;

select is(
  (select count(*)::int from public.crm_products where name = 'Consulta avulsa (tenant A)'),
  1,
  'DELETE de admin B no produto do tenant A não afeta nada (RLS filtra, produto A intacto)'
);

select * from finish();
rollback;
