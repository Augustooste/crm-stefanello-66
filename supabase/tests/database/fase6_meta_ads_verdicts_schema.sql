-- Fase 6 (Integrações de Nicho), sub-feature 5 — Meta Ads: atribuição de
-- lead + selo de qualidade por IA. Schema de public.ai_lead_verdicts +
-- regressão do catálogo (integrations.meta-ads.available).
-- Roda contra o shadow DB local (supabase test db --local; pnpm test:db),
-- que reaplica todas as migrations do zero -- não toca a DB real do
-- Lovable. NÃO rodar aqui agora (decisão explícita: o agente de
-- sincronização roda isso uma única vez depois que todos os agentes da
-- Fase 6 (Wave 1) terminarem).
begin;
create extension if not exists pgtap;

select plan(12);

-- =============================================================================
-- 1. Tabela + colunas
-- =============================================================================
select has_table('public', 'ai_lead_verdicts', 'tabela ai_lead_verdicts existe');
select has_column('public', 'ai_lead_verdicts', 'tenant_id', 'ai_lead_verdicts.tenant_id existe');
select has_column('public', 'ai_lead_verdicts', 'contact_id', 'ai_lead_verdicts.contact_id existe');
select has_column('public', 'ai_lead_verdicts', 'source', 'ai_lead_verdicts.source existe');
select has_column('public', 'ai_lead_verdicts', 'verdict', 'ai_lead_verdicts.verdict existe');
select has_column('public', 'ai_lead_verdicts', 'rationale', 'ai_lead_verdicts.rationale existe');
select has_column('public', 'ai_lead_verdicts', 'model', 'ai_lead_verdicts.model existe');

-- =============================================================================
-- 2. RLS habilitada, nunca FORCE (convenção real do projeto)
-- =============================================================================
select ok(
  (select relrowsecurity from pg_class where oid = 'public.ai_lead_verdicts'::regclass),
  'RLS habilitada em ai_lead_verdicts'
);
select ok(
  not (select relforcerowsecurity from pg_class where oid = 'public.ai_lead_verdicts'::regclass),
  'RLS NÃO forçada em ai_lead_verdicts (convenção real do projeto)'
);

-- =============================================================================
-- 3. Fixture: 1 tenant (via handle_new_user) + 1 contato, pra exercitar as
--    constraints de verdict/contact_id.
-- =============================================================================
insert into auth.users (id, email) values
  ('55555555-5555-5555-5555-555555555555', 'admin-meta-ads@test.local');

insert into public.contacts (tenant_id, name)
select tenant_id, 'Lead Meta Ads'
from public.profiles where id = '55555555-5555-5555-5555-555555555555';

-- =============================================================================
-- 4. Check constraint: verdict só aceita hot/warm/cold.
-- =============================================================================
select throws_ok(
  $$insert into public.ai_lead_verdicts (tenant_id, contact_id, verdict, model)
    select p.tenant_id, c.id, 'lukewarm', 'google/gemini-3-flash-preview'
    from public.profiles p
    join public.contacts c on c.tenant_id = p.tenant_id
    where p.id = '55555555-5555-5555-5555-555555555555'$$,
  '23514',
  NULL,
  'verdict fora de (hot, warm, cold) é rejeitado pelo check constraint'
);

-- =============================================================================
-- 5. Unique constraint em contact_id -- a UPDATE em conflito é
--    responsabilidade da edge function (ON CONFLICT DO UPDATE), não do
--    banco: um segundo INSERT simples para o mesmo contact_id deve
--    estourar unique_violation.
-- =============================================================================
insert into public.ai_lead_verdicts (tenant_id, contact_id, verdict, model)
select p.tenant_id, c.id, 'hot', 'google/gemini-3-flash-preview'
from public.profiles p
join public.contacts c on c.tenant_id = p.tenant_id
where p.id = '55555555-5555-5555-5555-555555555555';

select throws_ok(
  $$insert into public.ai_lead_verdicts (tenant_id, contact_id, verdict, model)
    select p.tenant_id, c.id, 'warm', 'google/gemini-3-flash-preview'
    from public.profiles p
    join public.contacts c on c.tenant_id = p.tenant_id
    where p.id = '55555555-5555-5555-5555-555555555555'$$,
  '23505',
  NULL,
  'segundo INSERT para o mesmo contact_id é rejeitado pela unique constraint'
);

-- =============================================================================
-- 6. Regressão anti-padrão: a linha 'meta-ads' de public.integrations
--    (herdada da era medflow com available:false) precisa estar
--    available=true depois desta migration -- prova que o INSERT usou ON
--    CONFLICT DO UPDATE, não DO NOTHING.
-- =============================================================================
select is(
  (select available from public.integrations where slug = 'meta-ads'),
  true,
  'integrations.meta-ads está available=true (regressão do anti-padrão DO NOTHING)'
);

select * from finish();
rollback;
