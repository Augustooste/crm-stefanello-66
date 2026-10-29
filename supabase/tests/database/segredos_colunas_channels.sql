-- Segredos de canal (webhook_token, qr_code) não são legíveis coluna a coluna
-- por membros comuns do tenant: só via RPCs admin-only
-- (get_channel_webhook_tokens / get_channel_qr_codes) ou service_role.
--
-- Regressão do finding "channels_webhook_token_exposure": a policy de SELECT
-- por tenant permitia a QUALQUER atendente ler a linha inteira, inclusive o
-- token do webhook. Aqui travamos a superfície no nível de GRANT de coluna.
begin;
create extension if not exists pgtap;

select plan(6);

select is(
  (select count(*)::int
     from pg_attribute a
     cross join lateral aclexplode(a.attacl) x
     join pg_roles r on r.oid = x.grantee
    where a.attrelid = 'public.channels'::regclass
      and a.attname in ('webhook_token', 'qr_code')
      and r.rolname in ('anon', 'authenticated')),
  0,
  'anon/authenticated não têm privilégio nas colunas webhook_token/qr_code de channels'
);

select ok(
  has_column_privilege('authenticated', 'public.channels', 'id', 'select'),
  'authenticated ainda lê colunas não sensíveis de channels (id)'
);
select ok(
  has_column_privilege('authenticated', 'public.channels', 'status', 'select'),
  'authenticated ainda lê colunas não sensíveis de channels (status)'
);
select ok(
  not has_column_privilege('authenticated', 'public.channels', 'webhook_token', 'select'),
  'authenticated NÃO lê channels.webhook_token'
);
select ok(
  not has_column_privilege('authenticated', 'public.channels', 'qr_code', 'select'),
  'authenticated NÃO lê channels.qr_code'
);

-- lead_form_submissions: escrita só pela edge function (service_role).
select is(
  (select count(*)::int
     from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name = 'lead_form_submissions'
      and grantee in ('anon', 'authenticated')
      and privilege_type in ('INSERT', 'UPDATE', 'DELETE')),
  0,
  'anon/authenticated não escrevem em lead_form_submissions'
);

select * from finish();
rollback;
