-- Baseline de GRANTs por tabela: o papel `anon` não tem NADA em `public`.
--
-- Contexto: até 11/08/2026 este backend concedia SELECT/INSERT/UPDATE/DELETE a
-- `anon` em 93 das 98 tabelas de `public` (herança do bootstrap). Nenhuma
-- política de RLS em `public` é dirigida a `anon` — o formulário público de
-- leads é servido pela função SECURITY DEFINER `public.get_public_lead_form` —
-- então o baseline correto (igual ao aceleraflow) é zero privilégio.
--
-- Orientado a dados: nenhuma asserção nomeia tabela. Tabela nova entra no radar
-- sozinha. Cada asserção compara a lista de ofensores com string vazia, para
-- que a falha já diga QUAL objeto quebrou a regra.
--
-- Roda no shadow DB local (`pnpm test:db`). O ACL do projeto hospedado NÃO é
-- reproduzido fielmente pelo local; a conferência equivalente contra o backend
-- real é `node scripts/paridade-status.mjs`.

begin;
create extension if not exists pgtap;

select plan(10);

-- ---------------------------------------------------------------------------
-- Controle positivo: sonda negativa sem controle positivo não prova nada.
-- ---------------------------------------------------------------------------
select ok(
  has_table_privilege('authenticated', 'public.contacts', 'SELECT'),
  'controle positivo: authenticated mantém SELECT em contacts'
);
select ok(
  has_table_privilege('service_role', 'public.contacts', 'INSERT'),
  'controle positivo: service_role mantém INSERT em contacts'
);

-- ---------------------------------------------------------------------------
-- 1. Nenhuma tabela de public concede WRITE a anon (ACL declarado).
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
      and a.privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
  ),
  '',
  'nenhuma tabela de public concede escrita a anon (ACL declarado)'
);

-- ---------------------------------------------------------------------------
-- 2. Mesma checagem pelo privilégio EFETIVO (pega herança via PUBLIC, que o
--    filtro por grantee no aclexplode não enxerga). Por OID, nunca por nome:
--    com nome o planner avalia has_table_privilege antes do filtro de schema e
--    estoura em tabela homônima de outro schema.
-- ---------------------------------------------------------------------------
select is(
  (
    select coalesce(string_agg(c.relname, ', ' order by c.relname), '')
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and (
        has_table_privilege('anon', c.oid, 'INSERT') or
        has_table_privilege('anon', c.oid, 'UPDATE') or
        has_table_privilege('anon', c.oid, 'DELETE') or
        has_table_privilege('anon', c.oid, 'TRUNCATE')
      )
  ),
  '',
  'anon não tem privilégio EFETIVO de escrita em nenhuma tabela de public'
);

-- ---------------------------------------------------------------------------
-- 3. Leitura também está fechada: nenhuma política aceita anon hoje, então
--    SELECT concedido seria privilégio sem uso — e superfície de ataque à
--    espera de uma política permissiva escrita por engano.
--    Se algum caminho público de leitura nascer, ele volta com GRANT estreito
--    na migration da própria feature, e este teste ganha a allowlist.
-- ---------------------------------------------------------------------------
select is(
  (
    select coalesce(string_agg(c.relname, ', ' order by c.relname), '')
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and has_table_privilege('anon', c.oid, 'SELECT')
  ),
  '',
  'anon não tem SELECT em nenhuma tabela de public'
);

-- ---------------------------------------------------------------------------
-- 4. Sequência com USAGE/UPDATE para anon devolveria escrita por outra porta.
-- ---------------------------------------------------------------------------
select is(
  (
    select coalesce(string_agg(c.relname, ', ' order by c.relname), '')
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'S'
      and (
        has_sequence_privilege('anon', c.oid, 'USAGE') or
        has_sequence_privilege('anon', c.oid, 'UPDATE')
      )
  ),
  '',
  'nenhuma sequência de public dá USAGE/UPDATE a anon'
);

-- ---------------------------------------------------------------------------
-- 5. A torneira: sem isto, a próxima migration recria o grant em toda tabela
--    nova e o teste acima volta a ficar vermelho semanas depois.
--
--    `supabase_admin` fica de fora porque a plataforma não permite alterar os
--    default privileges dele (42501 na tentativa, medido em 11/08/2026) — e as
--    migrations do projeto rodam como `postgres`, então o default dele é que
--    governa as tabelas que criamos.
-- ---------------------------------------------------------------------------
select is(
  (
    select coalesce(string_agg(distinct a.privilege_type, ', ' order by a.privilege_type), '')
    from pg_default_acl d
    join pg_namespace n on n.oid = d.defaclnamespace
    cross join lateral aclexplode(d.defaclacl) a
    where n.nspname = 'public'
      and d.defaclrole = 'postgres'::regrole
      and d.defaclobjtype in ('r', 'S')
      and a.grantee = 'anon'::regrole
  ),
  '',
  'default privileges de postgres em public não concedem nada a anon'
);

-- ---------------------------------------------------------------------------
-- 6. O REVOKE não pode ter passado do ponto: o app autenticado continua lendo.
--    `domain_event_subscriptions` é exceção deliberada (só service_role) e
--    `channels` lê por coluna (sem webhook_token/qr_code) e `api_keys`
--    também (sem key_hash), assim como `webhook_endpoints` (sem vault ids) e
--    `webhook_deliveries` (sem lease do worker).
-- ---------------------------------------------------------------------------
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
  'authenticated manteve SELECT em toda tabela (exceto domain_event_subscriptions, channels, api_keys, webhook_endpoints, webhook_deliveries, inbound_rules e inbound_events)'
);

-- ---------------------------------------------------------------------------
-- 7. Grant por COLUNA (padrão de api_keys, webhook_endpoints e webhook_deliveries)
--    não aparece em has_table_privilege nem no relacl: conferir também o attacl
--    declarado e o privilégio EFETIVO em qualquer coluna (pega herança via PUBLIC).
-- ---------------------------------------------------------------------------
select is(
  (
    select coalesce(string_agg(distinct c.relname || '.' || at.attname, ', '
             order by c.relname || '.' || at.attname), '')
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute at on at.attrelid = c.oid and at.attnum > 0 and not at.attisdropped
    cross join lateral aclexplode(at.attacl) a
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and a.grantee in ('anon'::regrole::oid, 0)
  ),
  '',
  'nenhuma coluna de public concede privilégio a anon ou PUBLIC (attacl declarado)'
);
select is(
  (
    select coalesce(string_agg(c.relname, ', ' order by c.relname), '')
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and has_any_column_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')
  ),
  '',
  'anon não tem privilégio EFETIVO em coluna nenhuma de public'
);

select * from finish();
rollback;
