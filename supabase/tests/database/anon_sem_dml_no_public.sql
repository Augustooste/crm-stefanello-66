-- Allowlist fechada de privilégios da role `anon` no schema public
-- (code review 02 · H1 — ver 20260810160000_revoke_dml_do_anon.sql).
--
-- Roda contra o shadow DB local (`pnpm test:db`), que reaplica as migrations do
-- zero. ATENÇÃO: verde aqui NÃO substitui a conferência em produção — o ACL do
-- projeto Lovable não é reproduzido fielmente pelo local. A consulta de
-- verificação em prod está no cabeçalho da migration.
begin;
create extension if not exists pgtap;

select plan(5);

-- ---------------------------------------------------------------------------
-- Controle positivo primeiro: sonda negativa sem controle positivo não prova
-- nada (uma sonda quebrada também devolve "zero achados").
-- ---------------------------------------------------------------------------
select ok(
  has_table_privilege('authenticated', 'public.contacts', 'SELECT'),
  'controle positivo: authenticated continua com SELECT em contacts'
);
select ok(
  has_table_privilege('service_role', 'public.contacts', 'INSERT'),
  'controle positivo: service_role continua com INSERT em contacts'
);

-- ---------------------------------------------------------------------------
-- A asserção que segura a regressão: nenhuma tabela de `public` dá DML a anon.
-- ---------------------------------------------------------------------------
select is(
  (
    select coalesce(string_agg(distinct c.relname, ', ' order by c.relname), '')
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral aclexplode(c.relacl) a
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and a.grantee = 'anon'::regrole
      and a.privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
  ),
  '',
  'nenhuma tabela de public concede SELECT/INSERT/UPDATE/DELETE para anon'
);

-- Mesma checagem por has_table_privilege, que enxerga o privilégio EFETIVO
-- (inclui herança via PUBLIC, que `aclexplode` + filtro por grantee não pega).
-- Por OID, não por nome: com nome, o planner avalia has_table_privilege antes do
-- filtro de schema e estoura em tabela homônima de outro schema
-- (`relation "public.instances" does not exist`, medido).
select is(
  (
    select coalesce(string_agg(c.relname, ', ' order by c.relname), '')
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and (
        has_table_privilege('anon', c.oid, 'SELECT') or
        has_table_privilege('anon', c.oid, 'INSERT') or
        has_table_privilege('anon', c.oid, 'UPDATE') or
        has_table_privilege('anon', c.oid, 'DELETE')
      )
  ),
  '',
  'anon não tem privilégio EFETIVO de DML em nenhuma tabela de public'
);

-- ---------------------------------------------------------------------------
-- A torneira: sem isto, a próxima migration recria o grant em toda tabela nova.
-- ---------------------------------------------------------------------------
select ok(
  not exists (
    select 1
    from pg_default_acl d
    join pg_namespace n on n.oid = d.defaclnamespace
    cross join lateral aclexplode(d.defaclacl) a
    where n.nspname = 'public'
      and d.defaclobjtype = 'r'
      and d.defaclrole = 'postgres'::regrole
      and a.grantee = 'anon'::regrole
  ),
  'default privileges de postgres em public não concedem mais nada a anon em tabelas'
);

select * from finish();
rollback;
