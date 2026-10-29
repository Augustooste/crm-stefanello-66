-- Fase 6 (Sub-feature 0) — niche_templates.plugins: seed de plugins por nicho.
-- Roda contra o shadow DB local (supabase test db --local; pnpm test:db),
-- que reaplica todas as migrations do zero -- não toca a DB real do
-- Lovable. NÃO rodar aqui agora (decisão explícita: agentes da Fase 6
-- (Wave 1) rodam em paralelo compartilhando a Postgres local; execução fica
-- pro agente de sincronização depois que todos os grupos terminarem).
begin;
create extension if not exists pgtap;

select plan(9);

-- =============================================================================
-- 1. Coluna nova: existe, NOT NULL.
-- =============================================================================
select has_column('public', 'niche_templates', 'plugins', 'niche_templates.plugins existe');
select col_not_null('public', 'niche_templates', 'plugins', 'niche_templates.plugins é NOT NULL');

-- =============================================================================
-- 2. Toda linha de niche_templates tem plugins não-nulo -- o default '[]'
-- cobre as linhas que nenhuma UPDATE da migration tocou.
-- =============================================================================
select is(
  (select count(*)::int from public.niche_templates where plugins is null),
  0,
  'nenhuma linha de niche_templates tem plugins nulo'
);

-- =============================================================================
-- 3. Seed explícito por slug (conforme migration 20260712120000).
-- =============================================================================
-- feegow removido do default (migration 20260712190000, decisão de produto);
-- clinica-odontologica fica com agenda + catalogo (doutore saiu em 20260928220000;
-- crm_products_v1 / 20260714150000 liga "catalogo" por padrão em quase todo nicho).
select is(
  (select plugins from public.niche_templates where slug = 'clinica-odontologica'),
  '["agenda","catalogo"]'::jsonb,
  'clinica-odontologica tem agenda e catalogo (feegow e doutore fora do produto)'
);

select is(
  (select plugins from public.niche_templates where slug = 'buffet-eventos'),
  '["agenda","catalogo"]'::jsonb,
  'buffet-eventos tem os plugins agenda e catalogo'
);

select is(
  (select plugins from public.niche_templates where slug = 'ecommerce'),
  '["meta-ads","catalogo"]'::jsonb,
  'ecommerce tem os plugins meta-ads e catalogo'
);

-- Nicho recebeu os plugins "companies" (crm_companies_v1, 20260714100000) e
-- "catalogo" (crm_products_v1, 20260714150000) em migrations posteriores à
-- Fase 6 -- não fica mais em '[]'.
select is(
  (select plugins from public.niche_templates where slug = 'industria-encomenda'),
  '["companies","catalogo"]'::jsonb,
  'industria-encomenda tem os plugins companies e catalogo (adicionados após a Fase 6)'
);

select is(
  (select plugins from public.niche_templates where slug = 'servicos-b2b'),
  '["companies","catalogo"]'::jsonb,
  'servicos-b2b tem os plugins companies e catalogo (adicionados após a Fase 6)'
);

select is(
  (select plugins from public.niche_templates where slug = 'generico'),
  '["companies", "catalogo"]'::jsonb,
  'generico traz companies + catalogo (reseed de 20260811001846)'
);

select * from finish();
rollback;
