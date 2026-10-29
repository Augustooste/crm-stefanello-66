-- Hardening do code review de 2026-07-24 (docs/code-review/00-INDICE.md, PR #124):
-- migrations 20260724200000_revoke_anon_lead_form_submissions e
-- 20260724210000_webhook_consecutive_failures.
--
-- O ponto central desta suite são os testes de GRANT (6-10): no prod toda função
-- nova nasce com EXECUTE concedido NOMINALMENTE a anon/authenticated (default
-- privileges do projeto), e `revoke ... from public` não desfaz grant nominal.
-- Sem o revoke explícito, a RPC SECURITY DEFINER que escreve em channels fica
-- chamável por qualquer um via PostgREST. Aconteceu no prod e passou
-- despercebido pelo review — daí virar teste.
--
-- LIMITE CONHECIDO destes testes (leia antes de confiar no verde): o vetor real
-- NÃO é reproduzível aqui. Localmente as migrations rodam como `postgres`, e o
-- default privilege que concede EXECUTE nominal pertence a `supabase_admin`
-- (`pg_default_acl`: defaclrole=supabase_admin concede a anon/authenticated;
-- defaclrole=postgres não concede a ninguém). Resultado: função criada pelo
-- replay local nasce com proacl nulo, e `revoke ... from public` sozinho já
-- zera has_function_privilege para anon/authenticated. Ou seja: apagar da
-- migration o `revoke execute ... from anon, authenticated` mantém esta suite
-- 100% verde e reabre o furo em prod. O que os testes 6-10 pegam de fato é a
-- REINTRODUÇÃO de um grant explícito (por migration futura, por sync do
-- Lovable) — o teste 10 é o mais forte, porque falha para QUALQUER role fora da
-- allowlist, não só anon/authenticated.
--
-- Roda contra o shadow DB local (pnpm test:db), que reaplica as migrations do
-- zero. Não toca a DB do Lovable.
begin;
create extension if not exists pgtap;

select plan(16);

-- =============================================================================
-- 1-2. Contador de falhas consecutivas em channels.
-- =============================================================================
select has_column(
  'public', 'channels', 'webhook_consecutive_failures',
  'channels.webhook_consecutive_failures existe'
);
select col_not_null(
  'public', 'channels', 'webhook_consecutive_failures',
  'channels.webhook_consecutive_failures é NOT NULL'
);

-- =============================================================================
-- 3-4. A RPC de incremento existe e é SECURITY DEFINER (precisa ser: escreve
-- em channels a partir da edge function, que não é dona da tabela).
-- =============================================================================
select has_function(
  'public', 'bump_channel_webhook_failure', array['uuid'],
  'bump_channel_webhook_failure(uuid) existe'
);
select is(
  (select p.prosecdef
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'bump_channel_webhook_failure'),
  true,
  'bump_channel_webhook_failure é SECURITY DEFINER'
);

-- =============================================================================
-- 5. O nome do parâmetro é contrato, não detalhe: a edge function chama
-- `admin.rpc("bump_channel_webhook_failure", { p_channel_id: ch.id })`, e
-- PostgREST casa as chaves do JSON com o NOME dos parâmetros. Renomear
-- p_channel_id deixaria has_function (que só olha tipo) verde e quebraria a
-- chamada real: PostgREST não acha a função, `bumpError` é setado,
-- consecutiveFailures fica 0, o webhook devolve 200 e a mensagem some sem
-- retry — exatamente o bug que a migration existe para fechar.
-- =============================================================================
select is(
  (select p.proargnames[1]
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'bump_channel_webhook_failure'),
  'p_channel_id',
  'parâmetro se chama p_channel_id (nome que admin.rpc envia)'
);

-- =============================================================================
-- 6-8. Superfície de exposição da RPC: só service_role.
-- =============================================================================
select is(
  has_function_privilege('anon', 'public.bump_channel_webhook_failure(uuid)', 'execute'),
  false,
  'anon NÃO pode executar bump_channel_webhook_failure'
);
select is(
  has_function_privilege('authenticated', 'public.bump_channel_webhook_failure(uuid)', 'execute'),
  false,
  'authenticated NÃO pode executar bump_channel_webhook_failure'
);
select is(
  has_function_privilege('service_role', 'public.bump_channel_webhook_failure(uuid)', 'execute'),
  true,
  'service_role pode executar bump_channel_webhook_failure'
);

-- 9. A ACL é explícita. `proacl` nulo significa ACL default do Postgres, em que
-- PUBLIC executa — os spot-checks por role acima passariam do mesmo jeito se
-- alguém recriasse a função sem nenhum revoke/grant, então este assert é o que
-- impede esse falso verde.
select isnt(
  (select p.proacl::text
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'bump_channel_webhook_failure'),
  null,
  'bump_channel_webhook_failure tem ACL explícita (proacl não nulo)'
);

-- 10. Allowlist fechada: nenhuma role fora de owner/service_role/sandbox_exec
-- tem EXECUTE. Pega grant que os spot-checks por nome não previram — inclusive
-- PUBLIC, que aparece em aclexplode com grantee 0.
-- `sandbox_exec` é o executor de SQL do Lovable: tem login e bypassrls, mas
-- `authenticator` (role de login do PostgREST) não é membro dela, então não há
-- caminho de API até essa role.
select is(
  (select array_agg(distinct coalesce(r.rolname::text, 'PUBLIC')
                    order by coalesce(r.rolname::text, 'PUBLIC'))
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     cross join lateral aclexplode(p.proacl) a
     left join pg_roles r on r.oid = a.grantee
    where n.nspname = 'public'
      and p.proname = 'bump_channel_webhook_failure'
      and a.privilege_type = 'EXECUTE'
      and coalesce(r.rolname::text, 'PUBLIC') not in
          ('postgres', 'supabase_admin', 'service_role', 'sandbox_exec')),
  null::text[],
  'nenhuma role fora da allowlist tem EXECUTE em bump_channel_webhook_failure'
);

-- Fixture: tenant via handle_new_user (mesmo padrão das demais suites de schema).
insert into auth.users (id, email) values
  ('66666666-6666-6666-6666-666666666666', 'admin-hardening@test.local');

insert into public.channels (tenant_id, type, provider_slug, status)
select tenant_id, 'whatsapp', 'evolution-hardening', 'pending'
from public.profiles where id = '66666666-6666-6666-6666-666666666666';

-- =============================================================================
-- 11-12. Comportamento: cada chamada devolve o NOVO valor do contador. É o valor de
-- retorno que a edge function usa para decidir 5xx (pede retry) vs 200 (teto
-- estourado) — se ela devolvesse o valor antigo, o teto atrasaria uma volta.
-- =============================================================================
select is(
  (select public.bump_channel_webhook_failure(id)
     from public.channels where provider_slug = 'evolution-hardening'),
  1,
  'primeira chamada devolve 1 (novo valor, não o antigo)'
);
select is(
  (select public.bump_channel_webhook_failure(id)
     from public.channels where provider_slug = 'evolution-hardening'),
  2,
  'segunda chamada devolve 2 (incremento acumula)'
);

-- =============================================================================
-- 13. Canal inexistente devolve 0, não NULL — a edge function compara o retorno
-- com o teto, e NULL faria a comparação virar unknown (nunca pediria retry).
-- =============================================================================
select is(
  public.bump_channel_webhook_failure('00000000-0000-0000-0000-000000000000'::uuid),
  0,
  'canal inexistente devolve 0 (coalesce), não NULL'
);

-- =============================================================================
-- 14-15. Endpoint público de formulários: anon não escreve direto na tabela.
-- Todo o rate limit vive em lead-form-submit (service_role); com INSERT direto,
-- bastava estourar RATE_LIMIT_MAX_TOTAL_PER_FORM (a constante em
-- supabase/functions/lead-form-submit/index.ts) para derrubar o formulário de
-- qualquer tenant.
-- =============================================================================
select is(
  has_table_privilege('anon', 'public.lead_form_submissions', 'insert'),
  false,
  'anon NÃO tem INSERT em lead_form_submissions'
);
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'lead_form_submissions'
      and policyname = 'lead_form_submissions public insert'),
  0,
  'policy de insert público em lead_form_submissions não existe mais'
);

-- =============================================================================
-- 16. O caminho legítimo do formulário público continua de pé: a página /f/<id>
-- lê o formulário com a anon key via get_public_lead_form.
-- =============================================================================
select is(
  has_function_privilege('anon', 'public.get_public_lead_form(uuid)', 'execute'),
  true,
  'anon ainda pode executar get_public_lead_form (leitura do formulário público)'
);

select * from finish();
rollback;
