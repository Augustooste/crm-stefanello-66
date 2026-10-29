-- T15 production inventory.
-- SELECT-only. Emits one JSON object per line, aggregate operational counts,
-- and never emits business-row contents.

select jsonb_build_object(
  'section', 'migrations',
  'rows', coalesce(
    jsonb_agg(
      jsonb_build_object('version', version, 'name', name)
      order by version
    ),
    '[]'::jsonb
  )
)
from supabase_migrations.schema_migrations;

select jsonb_build_object(
  'section', 'extensions',
  'rows', coalesce(
    jsonb_agg(
      jsonb_build_object('name', extname, 'version', extversion)
      order by extname
    ),
    '[]'::jsonb
  )
)
from pg_extension;

select jsonb_build_object(
  'section', 'tables',
  'rows', coalesce(
    jsonb_agg(
      jsonb_build_object(
        'schema', n.nspname,
        'name', c.relname,
        'rls', c.relrowsecurity,
        'force_rls', c.relforcerowsecurity
      )
      order by n.nspname, c.relname
    ),
    '[]'::jsonb
  )
)
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind in ('r', 'p');

select jsonb_build_object(
  'section', 'functions',
  'rows', coalesce(
    jsonb_agg(
      jsonb_build_object(
        'schema', n.nspname,
        'name', p.proname,
        'identity_args', pg_get_function_identity_arguments(p.oid),
        'security_definer', p.prosecdef,
        'search_path_fixed',
          coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=%',
        'definition_md5', md5(pg_get_functiondef(p.oid))
      )
      order by n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)
    ),
    '[]'::jsonb
  )
)
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname in ('public', 'private');

select jsonb_build_object(
  'section', 'triggers',
  'rows', coalesce(
    jsonb_agg(
      jsonb_build_object(
        'schema', n.nspname,
        'table', c.relname,
        'name', t.tgname,
        'enabled', t.tgenabled,
        'definition_md5', md5(pg_get_triggerdef(t.oid, true))
      )
      order by n.nspname, c.relname, t.tgname
    ),
    '[]'::jsonb
  )
)
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and not t.tgisinternal;

select jsonb_build_object(
  'section', 'policies',
  'rows', coalesce(
    jsonb_agg(
      jsonb_build_object(
        'schema', schemaname,
        'table', tablename,
        'name', policyname,
        'permissive', permissive,
        'roles', roles,
        'command', cmd,
        'using_md5', md5(coalesce(qual, '')),
        'check_md5', md5(coalesce(with_check, ''))
      )
      order by schemaname, tablename, policyname
    ),
    '[]'::jsonb
  )
)
from pg_policies
where schemaname = 'public';

select jsonb_build_object(
  'section', 'grants',
  'rows', coalesce(
    jsonb_agg(
      jsonb_build_object(
        'schema', table_schema,
        'table', table_name,
        'grantee', grantee,
        'privilege', privilege_type
      )
      order by table_schema, table_name, grantee, privilege_type
    ),
    '[]'::jsonb
  )
)
from information_schema.role_table_grants
where table_schema = 'public'
  and grantee in ('anon', 'authenticated', 'service_role');

select (to_regclass('cron.job') is not null) as t15_cron_available \gset
\if :t15_cron_available
select jsonb_build_object(
  'section', 'cron',
  'available', true,
  'rows', coalesce(
    jsonb_agg(
      jsonb_build_object(
        'job_id', jobid,
        'name', jobname,
        'schedule', schedule,
        'active', active,
        'command_md5', md5(command)
      )
      order by jobname
    ),
    '[]'::jsonb
  )
)
from cron.job;
\else
select jsonb_build_object(
  'section', 'cron',
  'available', false,
  'rows', '[]'::jsonb
);
\endif

select (
  to_regclass('public.ai_feature_catalog') is not null
  and to_regclass('public.tenant_ai_features') is not null
) as t15_feature_flags_available \gset
\if :t15_feature_flags_available
select jsonb_build_object(
  'section', 'feature_flags',
  'available', true,
  'rows', coalesce(
    jsonb_agg(
      jsonb_build_object(
        'feature_key', c.feature_key,
        'default_enabled', c.default_enabled,
        'toggle_authority', c.toggle_authority,
        'tenant_overrides', c.tenant_overrides,
        'enabled_overrides', c.enabled_overrides
      )
      order by c.feature_key
    ),
    '[]'::jsonb
  )
)
from (
  select
    catalog.feature_key,
    catalog.default_enabled,
    catalog.toggle_authority,
    count(features.tenant_id)::integer as tenant_overrides,
    count(features.tenant_id) filter (where features.enabled)::integer
      as enabled_overrides
  from public.ai_feature_catalog catalog
  left join public.tenant_ai_features features
    on features.feature_key = catalog.feature_key
  where catalog.feature_key in (
    'durable_ai_response_queue',
    'knowledge_rag'
  )
  group by
    catalog.feature_key,
    catalog.default_enabled,
    catalog.toggle_authority
) c;
\else
select jsonb_build_object(
  'section', 'feature_flags',
  'available', false,
  'rows', '[]'::jsonb
);
\endif

select (
  to_regclass('public.job_queue') is not null
  and to_regclass('public.ai_processing_log') is not null
) as t15_backlog_available \gset
\if :t15_backlog_available
select jsonb_build_object(
  'section', 'backlog',
  'available', true,
  'rows', coalesce(
    jsonb_agg(
      jsonb_build_object(
        'source', source,
        'status', status,
        'count', total
      )
      order by source, status
    ),
    '[]'::jsonb
  )
)
from (
  select 'job_queue'::text as source, status, count(*)::integer as total
  from public.job_queue
  where job_type = 'ai_respond'
  group by status

  union all

  select 'ai_processing_log'::text, status, count(*)::integer
  from public.ai_processing_log
  group by status
) counts;
\else
select jsonb_build_object(
  'section', 'backlog',
  'available', false,
  'rows', '[]'::jsonb
);
\endif

select (
  to_regclass('public.system_events') is not null
  and to_regclass('public.ai_failure_logs') is not null
) as t15_telemetry_available \gset
\if :t15_telemetry_available
select jsonb_build_object(
  'section', 'telemetry_last_hour',
  'available', true,
  'rows', jsonb_build_array(
    jsonb_build_object(
      'source', 'system_events',
      'count', (
        select count(*)::integer
        from public.system_events
        where ts >= now() - interval '1 hour'
      )
    ),
    jsonb_build_object(
      'source', 'ai_failure_logs',
      'count', (
        select count(*)::integer
        from public.ai_failure_logs
        where created_at >= now() - interval '1 hour'
      )
    )
  )
);
\else
select jsonb_build_object(
  'section', 'telemetry_last_hour',
  'available', false,
  'rows', '[]'::jsonb
);
\endif
