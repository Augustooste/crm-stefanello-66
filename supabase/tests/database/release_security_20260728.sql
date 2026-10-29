-- T13: regressões de segurança bloqueantes para a aprovação da release.
-- Roda somente no banco local recriado por `pnpm test:db`.
begin;
create extension if not exists pgtap;

select plan(25);

-- Superfície estrutural: todas as tabelas públicas usam RLS e os papéis da API
-- não conservam privilégios que RLS não intercepta.
select is(
  (
    select count(*)::int
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and not c.relrowsecurity
  ),
  0,
  'todas as tabelas públicas têm RLS'
);

select is(
  (
    select count(*)::int
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join (values ('REFERENCES'), ('TRIGGER'), ('TRUNCATE')) p(privilege)
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and has_table_privilege('anon', c.oid, p.privilege)
  ),
  0,
  'anon não possui REFERENCES, TRIGGER ou TRUNCATE em tabelas públicas'
);

select is(
  (
    select count(*)::int
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join (values ('REFERENCES'), ('TRIGGER'), ('TRUNCATE')) p(privilege)
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and has_table_privilege('authenticated', c.oid, p.privilege)
  ),
  0,
  'authenticated não possui REFERENCES, TRIGGER ou TRUNCATE em tabelas públicas'
);

select is(
  (
    select count(*)::int
    from pg_policies
    where schemaname = 'public'
      and policyname in (
        'ai_processing_log service role only',
        'billing_webhook_events service role only',
        'integration_secrets service role only',
        'kb_chunks service role only',
        'rate_limits service role only'
      )
      and cmd = 'ALL'
      and roles = array['service_role']::name[]
  ),
  5,
  'as cinco tabelas operacionais declaram policy service_role-only'
);

-- QR de pareamento: coluna separada, sem SELECT direto, exposta apenas pela
-- RPC tenant-scoped e admin-only.
select has_column('public', 'channels', 'qr_code', 'channels.qr_code existe');
select has_column(
  'public',
  'channels',
  'qr_code_expires_at',
  'channels.qr_code_expires_at existe'
);
select ok(
  has_column_privilege('authenticated', 'public.channels', 'config', 'select'),
  'authenticated continua lendo metadados não sensíveis de channels.config'
);
select ok(
  not has_column_privilege('authenticated', 'public.channels', 'qr_code', 'select'),
  'authenticated não lê channels.qr_code diretamente'
);
select ok(
  not has_column_privilege('authenticated', 'public.channels', 'qr_code_expires_at', 'select'),
  'authenticated não lê expiração do QR diretamente'
);

-- Doutore saiu do produto (20260928220000): catálogo indisponível.
select is(
  (select available from public.integrations where slug = 'doutore'),
  false,
  'Doutore fica indisponível no catálogo'
);

select has_function('public', 'get_channel_qr_codes', 'get_channel_qr_codes existe');
select has_function(
  'public',
  'set_tenant_plugin_override',
  array['text', 'boolean'],
  'set_tenant_plugin_override(text, boolean) existe'
);
select has_function(
  'public',
  'enroll_manual_nurture_sequence',
  array['uuid', 'timestamptz'],
  'enroll_manual_nurture_sequence(uuid, timestamptz) existe'
);

select is(
  (
    with target(signature) as (
      values
        ('public.get_channel_qr_codes()'),
        ('public.set_tenant_plugin_override(text,boolean)'),
        ('public.enroll_manual_nurture_sequence(uuid,timestamptz)')
    )
    select count(*)::int
    from target t
    join pg_proc p on p.oid = t.signature::regprocedure
    where p.prosecdef
  ),
  3,
  'as três RPCs novas são SECURITY DEFINER'
);

select is(
  (
    with target(signature) as (
      values
        ('public.get_channel_qr_codes()'),
        ('public.set_tenant_plugin_override(text,boolean)'),
        ('public.enroll_manual_nurture_sequence(uuid,timestamptz)')
    )
    select count(*)::int
    from target t
    join pg_proc p on p.oid = t.signature::regprocedure
    where p.proconfig is not null
      and exists (
        select 1
        from unnest(p.proconfig) c
        where c like 'search_path=%'
      )
  ),
  3,
  'as três RPCs novas fixam search_path'
);

select is(
  (
    with target(signature) as (
      values
        ('public.get_channel_qr_codes()'),
        ('public.set_tenant_plugin_override(text,boolean)'),
        ('public.enroll_manual_nurture_sequence(uuid,timestamptz)')
    )
    select count(*)::int
    from target
    where has_function_privilege('anon', signature, 'execute')
  ),
  0,
  'anon não executa nenhuma das três RPCs'
);

select is(
  (
    with target(signature) as (
      values
        ('public.get_channel_qr_codes()'),
        ('public.set_tenant_plugin_override(text,boolean)'),
        ('public.enroll_manual_nurture_sequence(uuid,timestamptz)')
    )
    select count(*)::int
    from target
    where has_function_privilege('authenticated', signature, 'execute')
  ),
  3,
  'authenticated executa as três RPCs com autorização interna'
);

-- Fixtures para validar isolamento real das RPCs.
insert into auth.users (id, email)
values
  ('a2800000-0000-4000-8000-000000000001', 'release-security-a@test.local'),
  ('b2800000-0000-4000-8000-000000000001', 'release-security-b@test.local');

insert into public.channels (
  id,
  tenant_id,
  type,
  provider_slug,
  status,
  config,
  qr_code,
  qr_code_expires_at
)
select
  'a2800000-0000-4000-8000-000000000011',
  tenant_id,
  'whatsapp',
  'evolution-review-a',
  'waiting_qr',
  '{"instance_name":"a"}',
  'QR-A',
  now() + interval '10 minutes'
from public.profiles
where id = 'a2800000-0000-4000-8000-000000000001';

insert into public.channels (
  id,
  tenant_id,
  type,
  provider_slug,
  status,
  config,
  qr_code,
  qr_code_expires_at
)
select
  'a2800000-0000-4000-8000-000000000012',
  tenant_id,
  'whatsapp',
  'evolution-review-expired',
  'waiting_qr',
  '{"instance_name":"expired"}',
  'QR-EXPIRADO',
  now() - interval '1 minute'
from public.profiles
where id = 'a2800000-0000-4000-8000-000000000001';

insert into public.channels (
  id,
  tenant_id,
  type,
  provider_slug,
  status,
  config,
  qr_code,
  qr_code_expires_at
)
select
  'b2800000-0000-4000-8000-000000000011',
  tenant_id,
  'whatsapp',
  'evolution-review-b',
  'waiting_qr',
  '{"instance_name":"b"}',
  'QR-B',
  now() + interval '10 minutes'
from public.profiles
where id = 'b2800000-0000-4000-8000-000000000001';

insert into public.nurture_sequences (id, tenant_id, name, trigger_type, is_active)
select
  'a2800000-0000-4000-8000-000000000021',
  tenant_id,
  'Manual release review',
  'manual',
  true
from public.profiles
where id = 'a2800000-0000-4000-8000-000000000001';

insert into public.contacts (id, tenant_id, name)
select
  'a2800000-0000-4000-8000-000000000031',
  tenant_id,
  'Contato A'
from public.profiles
where id = 'a2800000-0000-4000-8000-000000000001';

insert into public.contacts (id, tenant_id, name)
select
  'b2800000-0000-4000-8000-000000000031',
  tenant_id,
  'Contato B'
from public.profiles
where id = 'b2800000-0000-4000-8000-000000000001';

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',
    'a2800000-0000-4000-8000-000000000001',
    'role',
    'authenticated'
  )::text,
  true
);
set local role authenticated;

select throws_ok(
  $$select qr_code from public.channels limit 1$$,
  '42501',
  null,
  'authenticated não consegue selecionar QR diretamente'
);
select is(
  (select count(*)::int from public.get_channel_qr_codes()),
  1,
  'RPC retorna somente o QR vigente do tenant ativo'
);
select is(
  (select qr_code from public.get_channel_qr_codes()),
  'QR-A',
  'RPC não vaza QR expirado nem QR de outro tenant'
);

select is(
  (public.set_tenant_plugin_override('agenda', true)->'plugin_overrides'->>'agenda')::boolean,
  true,
  'admin altera plugin por mutação atômica'
);
select throws_ok(
  $$select public.set_tenant_plugin_override('../invalido', true)$$,
  'P0001',
  'invalid_plugin_slug',
  'slug de plugin inválido é rejeitado'
);

select is(
  public.enroll_manual_nurture_sequence(
    'a2800000-0000-4000-8000-000000000031',
    '2026-08-01 15:00:00+00'
  ),
  true,
  'contato do tenant ativo entra na sequência manual'
);
select is(
  public.enroll_manual_nurture_sequence(
    'a2800000-0000-4000-8000-000000000031',
    '2026-08-01 15:00:00+00'
  ),
  false,
  'segunda inscrição ativa é idempotente'
);
select throws_ok(
  $$select public.enroll_manual_nurture_sequence(
    'b2800000-0000-4000-8000-000000000031',
    '2026-08-01 15:00:00+00'
  )$$,
  'P0001',
  'invalid_contact',
  'contato de outro tenant é rejeitado'
);

reset role;
select * from finish();
rollback;
