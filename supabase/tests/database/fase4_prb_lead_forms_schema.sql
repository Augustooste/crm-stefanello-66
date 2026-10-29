-- Fase 4 (user story I) — lead-capture forms públicos: existência/RLS/
-- trigger de validação (rodar: pnpm test:db). Roda contra o shadow DB local
-- (supabase test db --local), que reaplica todas as migrations do zero --
-- não toca a DB real do Lovable.
--
-- Esta é a primeira superfície de escrita ANÔNIMA do projeto: os testes
-- comportamentais abaixo rodam de fato como "set local role anon" (não só
-- checam existência de policy/trigger), simulando exatamente o caminho que
-- a página pública de captura usa.
begin;
create extension if not exists pgtap;

select plan(14);

-- Fixture: 2 tenants via handle_new_user (trigger em auth.users).
insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin-leadforms-a@test.local'),
  ('44444444-4444-4444-4444-444444444444', 'admin-leadforms-b@test.local');

-- Fixture: lead_forms semeados como o role de conexão (superuser local,
-- bypassa RLS) -- 1 ativo e 1 inativo no tenant A, 1 ativo no tenant B.
insert into public.lead_forms (id, tenant_id, name, slug, is_active)
select 'a1000000-0000-0000-0000-000000000001', tenant_id, 'Formulário Ativo A', 'form-ativo-a', true
from public.profiles where id = '33333333-3333-3333-3333-333333333333';

insert into public.lead_forms (id, tenant_id, name, slug, is_active)
select 'a1000000-0000-0000-0000-000000000002', tenant_id, 'Formulário Inativo A', 'form-inativo-a', false
from public.profiles where id = '33333333-3333-3333-3333-333333333333';

insert into public.lead_forms (id, tenant_id, name, slug, is_active)
select 'a1000000-0000-0000-0000-000000000003', tenant_id, 'Formulário Ativo B', 'form-ativo-b', true
from public.profiles where id = '44444444-4444-4444-4444-444444444444';

-- Captura o tenant_id do tenant B AGORA (como role de conexão/superuser, que
-- lê lead_forms) para o teste de forja cross-tenant (teste 12) mais abaixo:
-- lá dentro rodamos como anon, que NÃO tem mais SELECT em lead_forms
-- (revogado em 20260712172902), então não dá pra ler este valor de lá.
select tenant_id as forged_tenant_id
from public.lead_forms where id = 'a1000000-0000-0000-0000-000000000003' \gset

-- 1-2. Tabelas existem.
select has_table('public', 'lead_forms', 'tabela lead_forms existe');
select has_table('public', 'lead_form_submissions', 'tabela lead_form_submissions existe');

-- 3-6. RLS habilitada, nunca FORCE (convenção real do projeto), nas 2 tabelas.
select ok(
  (select relrowsecurity from pg_class where oid = 'public.lead_forms'::regclass),
  'RLS habilitada em lead_forms'
);
select ok(
  not (select relforcerowsecurity from pg_class where oid = 'public.lead_forms'::regclass),
  'RLS NÃO forçada em lead_forms'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.lead_form_submissions'::regclass),
  'RLS habilitada em lead_form_submissions'
);
select ok(
  not (select relforcerowsecurity from pg_class where oid = 'public.lead_form_submissions'::regclass),
  'RLS NÃO forçada em lead_form_submissions (NUNCA desabilitada -- anti-padrão do medflow, não repetir)'
);

-- 7-9. Contrato NOVO (migration 20260712172902): a leitura anônima direta da
--       tabela foi revogada (REVOKE SELECT + DROP POLICY "public read active")
--       e a página pública passou a ler só via RPC get_public_lead_form
--       (SECURITY DEFINER, projeção mínima id/name/success_message/fields).
--       Testes comportamentais reais trocando pra role anon.
set local role anon;

-- 7. anon NÃO consegue mais SELECT direto na tabela -- o SELECT foi revogado,
--    então falha na camada de grant com permission denied (SQLSTATE 42501),
--    não é mais uma questão de RLS.
select throws_ok(
  $$select count(*) from public.lead_forms$$,
  '42501',
  NULL,
  'anon NÃO consegue mais SELECT direto em lead_forms (SELECT revogado)'
);

-- 8. anon LÊ um formulário ATIVO via a RPC (grant execute + security definer
--    contornam a falta de SELECT na tabela) -- 1 linha projetada.
select is(
  (select count(*)::int
     from public.get_public_lead_form('a1000000-0000-0000-0000-000000000001')),
  1,
  'anon lê form ativo A via get_public_lead_form (1 linha projetada)'
);

-- 9. RPC de formulário INATIVO retorna 0 linhas (a função filtra
--    is_active = true), mesmo o form existindo na tabela.
select is(
  (select count(*)::int
     from public.get_public_lead_form('a1000000-0000-0000-0000-000000000002')),
  0,
  'get_public_lead_form de form inativo (A) retorna 0 linhas (filtra is_active)'
);

reset role;

-- 10-11. Trigger de validação: teste comportamental REAL (não só
--       has_trigger/has_function).
--       NÃO roda mais como anon: desde 20260724200000 o anon não tem INSERT
--       (revogado por ser vetor de DoS), e o Postgres nega no ACL ANTES de
--       disparar o trigger — o teste receberia 42501 em vez de P0001. O trigger
--       BEFORE INSERT dispara igual sob o role de conexão, que é o que importa
--       aqui. A garantia nova (anon não escreve) virou o teste 14.

select throws_ok(
  $$insert into public.lead_form_submissions (lead_form_id, data)
    values ('00000000-0000-0000-0000-000000000000', '{"nome": "teste"}')$$,
  'P0001',
  NULL,
  'insert com lead_form_id inexistente é rejeitado pelo trigger (RAISE EXCEPTION)'
);

select throws_ok(
  $$insert into public.lead_form_submissions (lead_form_id, data)
    values ('a1000000-0000-0000-0000-000000000002', '{"nome": "teste"}')$$,
  'P0001',
  NULL,
  'insert em formulário inativo (form-inativo-a) é rejeitado pelo trigger'
);

-- 12. Insert em formulário ativo sucede -- e o "atacante" anônimo tenta
--     forjar um tenant_id que NÃO é o do formulário (do tenant B, enquanto
--     o formulário é do tenant A).
insert into public.lead_form_submissions (tenant_id, lead_form_id, data)
values (
  :'forged_tenant_id',
  'a1000000-0000-0000-0000-000000000001',
  '{"nome": "lead real"}'
);

reset role;

select is(
  (select count(*)::int from public.lead_form_submissions
    where lead_form_id = 'a1000000-0000-0000-0000-000000000001'),
  1,
  'insert em formulário ativo (form-ativo-a) sucede'
);

-- 13. tenant_id gravado foi SOBRESCRITO pelo trigger com o tenant_id real
--     do formulário (tenant A), não o valor forjado que o teste tentou
--     passar (tenant B).
select is(
  (select tenant_id from public.lead_form_submissions
    where lead_form_id = 'a1000000-0000-0000-0000-000000000001'),
  (select tenant_id from public.lead_forms where id = 'a1000000-0000-0000-0000-000000000001'),
  'tenant_id da submissão foi sobrescrito pelo trigger com o tenant_id real do formulário (não o forjado)'
);

-- 14. REGRESSÃO DO CRITICAL (code review 2026-07-24, 01a-security-messaging.md):
--     `anon` tinha GRANT INSERT direto nesta tabela, o que tornava contornável
--     todo o rate-limit da edge function lead-form-submit (bastava POST em
--     /rest/v1 com a anon key, que é pública) — 60 inserts derrubavam
--     permanentemente o formulário de qualquer tenant. A migration
--     20260724200000 revogou o grant e dropou a policy pública.
--     42501 = permission denied, negado no ACL antes de RLS/trigger.
--     O caminho legítimo (edge function com service_role) não passa por aqui.
set local role anon;

select throws_ok(
  $$insert into public.lead_form_submissions (lead_form_id, data)
    values ('a1000000-0000-0000-0000-000000000001', '{"nome": "teste"}')$$,
  '42501',
  NULL,
  'anon NÃO consegue inserir submissão direto (grant revogado) — nem em formulário ativo'
);

reset role;

select * from finish();
rollback;
