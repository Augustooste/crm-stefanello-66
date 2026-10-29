-- Fase 4 PR-B (user story J) -- lead vs. contact staging: existência de
-- colunas/constraint e comportamento do DEFAULT + desacoplamento
-- owner_id/status (rodar: pnpm test:db). Roda contra o shadow DB local
-- (supabase test db --local), que reaplica todas as migrations do zero --
-- não toca a DB real do Lovable. O backfill retroativo em si (contatos
-- pré-existentes -> 'contact') já rodou 1x na migration contra os dados
-- reais no momento da aplicação e não é testável aqui.
begin;
create extension if not exists pgtap;

select plan(10);

-- 1. Colunas existem.
select has_column('public', 'contacts', 'status', 'coluna status existe em contacts');
select has_column('public', 'contacts', 'owner_id', 'coluna owner_id existe em contacts');

-- 2. O CHECK contacts_status_check NÃO existe mais: a migration
-- 20260724131048 o dropou de propósito ao trocar o vocabulário fixo
-- ('lead','contact') pelo catálogo por tenant em contact_statuses (6 slugs
-- default, seed por trigger em tenants). Recriar o CHECK quebraria qualquer
-- status customizado que o tenant cadastre — por isso o teste virou o
-- inverso: guarda contra a volta da constraint.
--
-- Quem validou o vocabulário no lugar do CHECK foi a FK composta
-- `contacts_status_catalog_fk` (migration 20260725000000), que referencia
-- contact_statuses(tenant_id, slug) — ver itens 5 e 7.
select ok(
  not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.contacts'::regclass
      and conname = 'contacts_status_check'
  ),
  'contacts_status_check não existe mais (status vem do catálogo contact_statuses)'
);

insert into auth.users (id, email) values
  ('88888888-8888-8888-8888-888888888888', 'admin-contacts-staging@test.local');

-- 3. Insert sem especificar status nasce com status='lead' (valida DEFAULT).
insert into public.contacts (tenant_id, name)
select tenant_id, 'Contato sem status explicito'
from public.profiles where id = '88888888-8888-8888-8888-888888888888';

select is(
  (select status from public.contacts
    where tenant_id = (select tenant_id from public.profiles where id = '88888888-8888-8888-8888-888888888888')
      and name = 'Contato sem status explicito'),
  'lead',
  'contato inserido sem status explicito nasce com status=lead (DEFAULT)'
);

-- 4. Insert explícito com status='contact' funciona.
insert into public.contacts (tenant_id, name, status)
select tenant_id, 'Contato ja em relacao', 'contact'
from public.profiles where id = '88888888-8888-8888-8888-888888888888';

select is(
  (select status from public.contacts
    where tenant_id = (select tenant_id from public.profiles where id = '88888888-8888-8888-8888-888888888888')
      and name = 'Contato ja em relacao'),
  'contact',
  'insert explicito com status=contact e aceito'
);

-- 5. Status fora do catálogo do tenant é rejeitado pela FK composta (23503).
-- Entre 20260724131048 (que dropou o CHECK) e 20260725000000 (que pôs a FK)
-- este insert passava — o teste ficou marcando o buraco com um lives_ok até a
-- FK existir.
select throws_ok(
  $$insert into public.contacts (tenant_id, name, status)
    select tenant_id, 'Contato invalido', 'invalido' from public.profiles
    where id = '88888888-8888-8888-8888-888888888888'$$,
  '23503',
  NULL,
  'status fora do catálogo é rejeitado pela FK contacts_status_catalog_fk (23503)'
);

-- 6. Atribuir owner_id via UPDATE NÃO muda status (sem trigger de acoplamento).
insert into public.contacts (tenant_id, name, status)
select tenant_id, 'Contato para atribuicao', 'lead'
from public.profiles where id = '88888888-8888-8888-8888-888888888888';

update public.contacts
set owner_id = '88888888-8888-8888-8888-888888888888'
where tenant_id = (select tenant_id from public.profiles where id = '88888888-8888-8888-8888-888888888888')
  and name = 'Contato para atribuicao';

select is(
  (select status from public.contacts
    where tenant_id = (select tenant_id from public.profiles where id = '88888888-8888-8888-8888-888888888888')
      and name = 'Contato para atribuicao'),
  'lead',
  'atribuir owner_id via UPDATE nao muda status (nao existe trigger de acoplamento indevido)'
);

-- =============================================================================
-- 7-9. A FK composta que substituiu o CHECK (migration 20260725000000).
-- Composta de propósito: garante que o status existe E pertence ao MESMO tenant
-- do contato — um CHECK não conseguiria expressar isso, e um FK só em `status`
-- deixaria um tenant usar slug cadastrado por outro.
-- =============================================================================
select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.contacts'::regclass
      and conname = 'contacts_status_catalog_fk'
      and contype = 'f'
      and confrelid = 'public.contact_statuses'::regclass
  ),
  'contacts_status_catalog_fk referencia contact_statuses'
);

-- Segundo tenant, com um slug que só existe no catálogo DELE.
insert into auth.users (id, email) values
  ('99999999-9999-9999-9999-999999999999', 'admin-outro-tenant@test.local');

insert into public.contact_statuses (tenant_id, slug, label, color, sort_order, is_default)
select tenant_id, 'exclusivo-do-outro', 'Exclusivo', '#111111', 700, false
from public.profiles where id = '99999999-9999-9999-9999-999999999999';

select throws_ok(
  $$insert into public.contacts (tenant_id, name, status)
    select tenant_id, 'Contato roubando status alheio', 'exclusivo-do-outro'
    from public.profiles where id = '88888888-8888-8888-8888-888888888888'$$,
  '23503',
  NULL,
  'slug do catálogo de OUTRO tenant é rejeitado (FK é composta com tenant_id)'
);

-- ON DELETE RESTRICT: apagar do catálogo um status ainda em uso é bloqueado, em
-- vez de deixar contatos apontando para nada (que era o estado anterior à FK).
select throws_ok(
  $$delete from public.contact_statuses
    where tenant_id = (select tenant_id from public.profiles
                        where id = '88888888-8888-8888-8888-888888888888')
      and slug = 'lead'$$,
  '23503',
  NULL,
  'apagar do catálogo um status em uso é bloqueado (ON DELETE RESTRICT)'
);

select * from finish();
rollback;
