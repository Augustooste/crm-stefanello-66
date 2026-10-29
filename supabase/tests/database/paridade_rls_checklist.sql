-- Checklist automático de RLS, GRANTs e políticas — schema `public` inteiro.
--
-- Orientado a dados de propósito: nenhuma asserção nomeia tabela uma a uma
-- (exceto as allowlists explícitas abaixo). Tabela nova entra no radar sozinha
-- na primeira execução, sem ninguém lembrar de atualizar o teste.
--
-- Cada asserção compara a lista de ofensores com string vazia, para que a
-- falha já diga QUAL tabela/função quebrou a regra — `ok(count = 0)` só diria
-- que algo quebrou.
--
-- Roda no shadow DB local (`pnpm test:db`). O ACL do projeto hospedado NÃO é
-- reproduzido fielmente pelo local; a conferência equivalente contra o backend
-- real é `node scripts/paridade-status.mjs`, que gera docs/paridade-aceleraflow.md.

begin;
create extension if not exists pgtap;

select plan(12);

-- ---------------------------------------------------------------------------
-- Controle positivo: sonda negativa sem controle positivo não prova nada.
-- ---------------------------------------------------------------------------
select ok(
  (select relrowsecurity from pg_class where oid = 'public.contacts'::regclass),
  'controle positivo: contacts tem RLS habilitada'
);

-- ---------------------------------------------------------------------------
-- 1. RLS habilitada em toda tabela de `public`.
--
-- A allowlist é de catálogo GLOBAL (mesmo conteúdo para todos os tenants,
-- somente leitura pelo app, escrita só por migration/service_role). Qualquer
-- tabela com dado de tenant fora dela é falha.
-- ---------------------------------------------------------------------------
select is(
  (
    select coalesce(string_agg(c.relname, ', ' order by c.relname), '')
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and not c.relrowsecurity
  ),
  '',
  'toda tabela de public tem RLS habilitada'
);

-- ---------------------------------------------------------------------------
-- 2. RLS sem política = tabela trancada. Falha silenciosa clássica: o app
--    simplesmente devolve zero linha e ninguém entende por quê.
-- ---------------------------------------------------------------------------
select is(
  (
    select coalesce(string_agg(c.relname, ', ' order by c.relname), '')
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and c.relrowsecurity
      and not exists (
        select 1 from pg_policies p
        where p.schemaname = 'public' and p.tablename = c.relname
      )
  ),
  '',
  'nenhuma tabela com RLS ficou sem política (tabela trancada)'
);

-- ---------------------------------------------------------------------------
-- 3. Toda policy de UPDATE precisa de WITH CHECK idêntico ao USING. Sem ele a
--    linha pode ser reescrita para OUTRO tenant — vazamento por escrita.
-- ---------------------------------------------------------------------------
select is(
  (
    select coalesce(string_agg(tablename || '.' || policyname, ', ' order by tablename, policyname), '')
    from pg_policies
    where schemaname = 'public'
      and cmd = 'UPDATE'
      and with_check is null
  ),
  '',
  'toda política de UPDATE declara WITH CHECK'
);

-- ---------------------------------------------------------------------------
-- 4. Sem GRANT não existe acesso, por mais correta que a policy seja: o
--    PostgREST devolve permission denied antes de RLS ser avaliada.
--    `domain_event_subscriptions` é exceção deliberada — só service_role lê.
--    `channels` também: o SELECT ali é coluna a coluna (webhook_token e
--    qr_code ficam de fora), então não há privilégio de tabela inteira.
--    `api_keys` idem: `key_hash` fica fora do SELECT coluna a coluna.
--    `webhook_endpoints` e `webhook_deliveries` idem: vault ids e lease do
--    worker (locked_by/locked_at) ficam fora do SELECT coluna a coluna.
--    `profiles` idem: `email` fica fora do SELECT coluna a coluna; admin
--    enxerga e-mail apenas pela RPC get_tenant_team (SECURITY DEFINER).
select is(
  (
    select coalesce(string_agg(c.relname, ', ' order by c.relname), '')
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      -- Só service_role (20260728130000 release_security_review_fixes e
      -- 20260811121412): segredos, telemetria, billing, RAG e rate limit são
      -- lidos por edge function; o front não os consulta direto.
      and c.relname not in ('domain_event_subscriptions', 'channels', 'profiles', 'api_keys',
        'ai_insights', 'ai_processing_log', 'billing_webhook_events', 'integration_secrets',
        'kb_chunks', 'kb_documents', 'rate_limits',
        -- webhooks de saída: SELECT por coluna (sem vault_secret_id nem lease do worker)
        'webhook_endpoints', 'webhook_deliveries',
        -- regras de entrada (v2): SELECT por coluna (sem vault_secret_id nem previous_vault_secret_id)
        'inbound_rules', 'inbound_events',
        -- provedor de agentes: só a edge function agent-platform-proxy (agent_platform_integration_schema.sql)
        'agent_platform_agent_links', 'agent_platform_channel_links',
        'agent_platform_audit_log', 'agent_platform_training_events')
      and not has_table_privilege('authenticated', c.oid, 'SELECT')
  ),
  '',
  'toda tabela de public concede SELECT a authenticated (exceto domain_event_subscriptions, channels, api_keys, webhook_endpoints, webhook_deliveries, inbound_rules, inbound_events e profiles)'
);

-- `profiles`: nome/papel legíveis pelo time; e-mail não.
select ok(
  has_column_privilege('authenticated', 'public.profiles', 'name', 'SELECT')
    and not has_column_privilege('authenticated', 'public.profiles', 'email', 'SELECT'),
  'profiles expõe nome/papel ao time, mas nunca o e-mail'
);

-- `channel_status_events`: histórico só é escrito por processo interno.
select ok(
  not has_table_privilege('authenticated', 'public.channel_status_events', 'INSERT')
    and not has_table_privilege('authenticated', 'public.channel_status_events', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.channel_status_events', 'DELETE'),
  'channel_status_events é somente leitura para o cliente'
);


select is(
  (
    select coalesce(string_agg(c.relname, ', ' order by c.relname), '')
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and not has_table_privilege('service_role', c.oid, 'SELECT')
  ),
  '',
  'toda tabela de public concede acesso a service_role'
);

-- ---------------------------------------------------------------------------
-- 5. `domain_event_subscriptions` é infraestrutura do despachante: cliente
--    nenhum enxerga. Regressão aqui devolve o roteamento de eventos ao browser.
-- ---------------------------------------------------------------------------
select ok(
  not has_table_privilege('authenticated', 'public.domain_event_subscriptions', 'SELECT')
    and not has_table_privilege('anon', 'public.domain_event_subscriptions', 'SELECT'),
  'domain_event_subscriptions permanece restrita a service_role'
);

-- ---------------------------------------------------------------------------
-- 6. Toda tabela com coluna tenant_id precisa de política que consulte o tenant
--    ativo. Política que ignora tenant_id é política global disfarçada.
--
--    Duas saídas legítimas, ambas verificadas e não presumidas:
--      a) a política referencia tenant (private.get_active_tenant_id & cia);
--      b) a tabela é interna e TODAS as políticas dela são `TO service_role`,
--         caso em que o cliente não alcança linha alguma — hoje:
--         ai_processing_log, integration_secrets, kb_chunks.
-- ---------------------------------------------------------------------------
select is(
  (
    select coalesce(string_agg(distinct c.relname, ', ' order by c.relname), '')
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join information_schema.columns col
      on col.table_schema = 'public' and col.table_name = c.relname and col.column_name = 'tenant_id'
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      -- (b) exclusiva de service_role: fechada para o cliente por definição
      and exists (
        select 1 from pg_policies p
        where p.schemaname = 'public' and p.tablename = c.relname
          and p.roles::text <> '{service_role}'
      )
      -- (a) nenhuma política referencia tenant
      and not exists (
        select 1 from pg_policies p
        where p.schemaname = 'public'
          and p.tablename = c.relname
          and (
            coalesce(p.qual, '') like '%tenant%'
            or coalesce(p.with_check, '') like '%tenant%'
          )
      )
  ),
  '',

  'toda tabela com tenant_id tem política que escopa por tenant'
);

-- ---------------------------------------------------------------------------
-- 7. SECURITY DEFINER: search_path fixo (senão o dono da função vira vetor de
--    injeção de schema) e EXECUTE fora do alcance de anon, salvo a allowlist
--    pública — hoje só `get_public_lead_form`, que serve o formulário embutido.
-- ---------------------------------------------------------------------------
select is(
  (
    select coalesce(string_agg(p.proname, ', ' order by p.proname), '')
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and (
        p.proconfig is null
        or not exists (select 1 from unnest(p.proconfig) cfg where cfg like 'search_path=%')
      )
  ),
  '',
  'toda função SECURITY DEFINER de public fixa search_path'
);

select is(
  (
    select coalesce(string_agg(p.proname, ', ' order by p.proname), '')
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and has_function_privilege('anon', p.oid, 'EXECUTE')
      -- tem_alguma_conta: a tela de entrada do remix vazio decide entre "criar
      -- conta" e "entrar"; devolve só um booleano (20260915195952).
      and p.proname not in ('get_public_lead_form', 'tem_alguma_conta')
  ),
  '',
  'nenhuma função SECURITY DEFINER executável por anon fora da allowlist pública'
);

select * from finish();
rollback;
