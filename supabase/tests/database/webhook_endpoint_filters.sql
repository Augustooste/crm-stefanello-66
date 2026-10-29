-- v1.1: filtro por funil e etapa em webhook_endpoints.
-- Colunas board_ids/stage_ids (vazio = todos), validação por tenant, sobrecarga de
-- create_webhook_endpoint com 5 parâmetros, update_webhook_endpoint, grants por coluna,
-- desativação ao apagar funil/etapa referenciado e board_id no deal.stage_changed.
-- Rodar: pnpm test:db.
begin;
create extension if not exists pgtap;

select plan(46);

-- Fixture: admin A e admin B (tenants próprios via handle_new_user) e agente C (convite no tenant A).
insert into auth.users (id, email) values
  ('f1000000-0000-4000-8000-00000000000a', 'filtro-adm-a@test.local'),
  ('f1000000-0000-4000-8000-00000000000b', 'filtro-adm-b@test.local');
insert into public.invites (tenant_id, email, role, token, expires_at)
select tenant_id, 'filtro-agente-c@test.local', 'agent', 'filtro-agent-token', now() + interval '1 day'
from public.profiles where id = 'f1000000-0000-4000-8000-00000000000a';
insert into auth.users (id, email, raw_user_meta_data) values
  ('f1000000-0000-4000-8000-00000000000c', 'filtro-agente-c@test.local',
   '{"invite_token":"filtro-agent-token"}');

-- Tenant A: funil A1 (Novo, Proposta, Pago=is_won, Extra) e funil A2 (Outra). Tenant B: funil B1 (Etapa B).
insert into public.boards (id, tenant_id, name)
select v.id::uuid, p.tenant_id, v.name
  from public.profiles p,
       (values ('f1000000-0000-4000-8000-0000000000a1', 'Funil A1'),
               ('f1000000-0000-4000-8000-0000000000a2', 'Funil A2')) as v(id, name)
 where p.id = 'f1000000-0000-4000-8000-00000000000a';
insert into public.boards (id, tenant_id, name)
select 'f1000000-0000-4000-8000-0000000000b1', tenant_id, 'Funil B1'
  from public.profiles where id = 'f1000000-0000-4000-8000-00000000000b';
insert into public.board_stages (id, board_id, name, position, is_won) values
  ('f1000000-0000-4000-8000-000000000a11', 'f1000000-0000-4000-8000-0000000000a1', 'Novo', 0, false),
  ('f1000000-0000-4000-8000-000000000a12', 'f1000000-0000-4000-8000-0000000000a1', 'Proposta', 1, false),
  ('f1000000-0000-4000-8000-000000000a13', 'f1000000-0000-4000-8000-0000000000a1', 'Pago', 2, true),
  ('f1000000-0000-4000-8000-000000000a14', 'f1000000-0000-4000-8000-0000000000a1', 'Extra', 3, false),
  ('f1000000-0000-4000-8000-000000000a21', 'f1000000-0000-4000-8000-0000000000a2', 'Outra', 0, false),
  ('f1000000-0000-4000-8000-000000000b11', 'f1000000-0000-4000-8000-0000000000b1', 'Etapa B', 0, false);
insert into public.deals (id, tenant_id, board_id, stage_id, title, status)
select 'f1000000-0000-4000-8000-0000000d0001', tenant_id, 'f1000000-0000-4000-8000-0000000000a1',
       'f1000000-0000-4000-8000-000000000a11', 'Negócio filtro', 'open'
  from public.profiles where id = 'f1000000-0000-4000-8000-00000000000a';

-- Endpoint do tenant B (como dono do banco) para o teste de isolamento do update.
insert into public.webhook_endpoints (id, tenant_id, url, event_types)
select 'f1000000-0000-4000-8000-0000000e00b1', tenant_id, 'https://b.example.com/hook', array['deal.won']
  from public.profiles where id = 'f1000000-0000-4000-8000-00000000000b';
-- Tenant B filtrado pela PRÓPRIA etapa (b11) e outro que cita a etapa a14 de A (só por
-- insert direto): apagar a14 não pode alterar nenhum dos dois (escopo de tenant do trigger).
insert into public.webhook_endpoints (id, tenant_id, url, event_types, stage_ids)
select v.id::uuid, p.tenant_id, 'https://b.example.com/' || v.n, array['deal.stage_changed'], array[v.s::uuid]
  from public.profiles p,
       (values ('f1000000-0000-4000-8000-0000000e00b2', 'own', 'f1000000-0000-4000-8000-000000000b11'),
               ('f1000000-0000-4000-8000-0000000e00b3', 'cross', 'f1000000-0000-4000-8000-000000000a14')) as v(id, n, s)
 where p.id = 'f1000000-0000-4000-8000-00000000000b';
-- Tenant A: endpoints filtrados pela etapa a14 já desligados (pausa manual e 410 gone).
insert into public.webhook_endpoints (id, tenant_id, url, event_types, stage_ids, active, disabled_reason)
select v.id::uuid, p.tenant_id, 'https://a.example.com/' || v.r, array['deal.stage_changed'],
       array['f1000000-0000-4000-8000-000000000a14']::uuid[], false, v.r
  from public.profiles p,
       (values ('f1000000-0000-4000-8000-0000000e00a1', 'manual'),
               ('f1000000-0000-4000-8000-0000000e00a2', 'gone')) as v(id, r)
 where p.id = 'f1000000-0000-4000-8000-00000000000a';

-- 1-4. Colunas e assinaturas.
select has_column('public', 'webhook_endpoints', 'board_ids', 'coluna board_ids existe');
select has_column('public', 'webhook_endpoints', 'stage_ids', 'coluna stage_ids existe');
select has_function('public', 'create_webhook_endpoint', array['text', 'text[]', 'text'],
  'sobrecarga de 3 parâmetros continua');
select has_function('public', 'create_webhook_endpoint', array['text', 'text[]', 'text', 'uuid[]', 'uuid[]'],
  'sobrecarga de 5 parâmetros existe');

-- 5-8. Grants: anon sem EXECUTE nas RPCs; authenticated executa; validador privado fechado.
select ok(
  not has_function_privilege('anon', 'public.create_webhook_endpoint(text,text[],text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.create_webhook_endpoint(text,text[],text,uuid[],uuid[])', 'EXECUTE')
  and not has_function_privilege('anon', 'public.update_webhook_endpoint(uuid,text,text[],text,uuid[],uuid[])', 'EXECUTE'),
  'anon não executa nenhuma das RPCs de criação/edição'
);
select ok(
  has_function_privilege('authenticated', 'public.create_webhook_endpoint(text,text[],text,uuid[],uuid[])', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.update_webhook_endpoint(uuid,text,text[],text,uuid[],uuid[])', 'EXECUTE'),
  'authenticated executa as RPCs novas'
);
select ok(
  not has_function_privilege('authenticated', 'private.assert_webhook_filters(uuid,uuid[],uuid[])', 'EXECUTE')
  and not has_function_privilege('anon', 'private.assert_webhook_filters(uuid,uuid[],uuid[])', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.disable_webhooks_on_filter_target_delete()', 'EXECUTE'),
  'funções privadas sem EXECUTE para authenticated/anon'
);
select ok(
  (select bool_and(pg_get_functiondef(p.oid) like '%developer.manage%'
                   and pg_get_functiondef(p.oid) not like '%is_admin%')
     from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('create_webhook_endpoint', 'update_webhook_endpoint')),
  'RPCs de criação/edição exigem developer.manage'
);

-- 9-12. Grants por coluna (lição I5: role_column_grants, não só role_table_grants).
select column_privs_are('public', 'webhook_endpoints', 'board_ids', 'authenticated', array['SELECT'],
  'authenticated lê board_ids (só SELECT)');
select column_privs_are('public', 'webhook_endpoints', 'stage_ids', 'authenticated', array['SELECT'],
  'authenticated lê stage_ids (só SELECT)');
select ok(
  not exists (select 1 from information_schema.role_column_grants
               where table_schema = 'public' and table_name = 'webhook_endpoints'
                 and column_name in ('board_ids', 'stage_ids') and grantee in ('anon', 'PUBLIC')),
  'anon/PUBLIC sem privilégio nas colunas novas'
);
select ok(
  not exists (select 1 from information_schema.column_privileges
               where table_schema = 'public' and table_name = 'webhook_endpoints' and grantee = 'authenticated'
                 and column_name in ('vault_secret_id', 'previous_vault_secret_id')),
  'authenticated continua sem SELECT nos ids do vault'
);

-- Admin A.
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-00000000000a","role":"authenticated"}', false);
set local role authenticated;

-- 13. Sobrecarga de 3 parâmetros grava arrays vazios.
create temp table t_plain on commit drop as
  select * from public.create_webhook_endpoint('https://a.example.com/plain', array['deal.won']);
grant all on t_plain to public;
select is(
  (select array[cardinality(e.board_ids), cardinality(e.stage_ids)] from public.webhook_endpoints e
    where e.id = (select id from t_plain)),
  array[0, 0], 'sobrecarga de 3 parâmetros grava board_ids/stage_ids vazios'
);

-- 14. Sobrecarga de 5 parâmetros grava os filtros na mesma instrução.
create temp table t_pago on commit drop as
  select * from public.create_webhook_endpoint('https://a.example.com/pago', array['deal.won', 'deal.stage_changed'],
    'só Pago', array['f1000000-0000-4000-8000-0000000000a1']::uuid[], array['f1000000-0000-4000-8000-000000000a13']::uuid[]);
grant all on t_pago to public;
select is(
  (select array[e.board_ids[1], e.stage_ids[1]] from public.webhook_endpoints e where e.id = (select id from t_pago)),
  array['f1000000-0000-4000-8000-0000000000a1', 'f1000000-0000-4000-8000-000000000a13']::uuid[],
  'sobrecarga de 5 parâmetros grava funil e etapa'
);

-- 15-16. Endpoints para os testes de exclusão: só etapa Extra; só funil A2.
create temp table t_extra on commit drop as
  select * from public.create_webhook_endpoint('https://a.example.com/extra', array['deal.stage_changed'],
    null, '{}'::uuid[], array['f1000000-0000-4000-8000-000000000a14']::uuid[]);
grant all on t_extra to public;
create temp table t_a2 on commit drop as
  select * from public.create_webhook_endpoint('https://a.example.com/a2', array['deal.won'],
    null, array['f1000000-0000-4000-8000-0000000000a2']::uuid[], '{}'::uuid[]);
grant all on t_a2 to public;
select ok((select id is not null from t_extra), 'etapa sem funil escolhido é aceita (etapa do tenant)');
select ok((select id is not null from t_a2), 'só funil, sem etapa, é aceito');

-- 17-23. Validação: 22023 com a mesma mensagem, sem revelar se o id existe.
select throws_ok(
  $$ select * from public.create_webhook_endpoint('https://a.example.com/x', array['deal.won'], null,
       array['f1000000-0000-4000-8000-0000000000b1']::uuid[], '{}'::uuid[]) $$,
  '22023', 'filtro invalido', 'funil do tenant B recusado');
select throws_ok(
  $$ select * from public.create_webhook_endpoint('https://a.example.com/x', array['deal.won'], null,
       '{}'::uuid[], array['f1000000-0000-4000-8000-000000000b11']::uuid[]) $$,
  '22023', 'filtro invalido', 'etapa do tenant B recusada');
select throws_ok(
  $$ select * from public.create_webhook_endpoint('https://a.example.com/x', array['deal.won'], null,
       array['f1000000-0000-4000-8000-0000000000a1']::uuid[], array['f1000000-0000-4000-8000-000000000a21']::uuid[]) $$,
  '22023', 'filtro invalido', 'etapa de outro funil que não o escolhido recusada');
select throws_ok(
  $$ select * from public.create_webhook_endpoint('https://a.example.com/x', array['deal.won'], null,
       array[null]::uuid[], '{}'::uuid[]) $$,
  '22023', 'filtro invalido', 'id nulo no array recusado');
select throws_ok(
  $$ select * from public.create_webhook_endpoint('https://a.example.com/x', array['deal.won'], null,
       (select array_agg(gen_random_uuid()) from generate_series(1, 21)), '{}'::uuid[]) $$,
  '22023', 'filtro invalido', '21 funis recusados');
select throws_ok(
  $$ select * from public.create_webhook_endpoint('https://a.example.com/x', array['deal.won'], null,
       array['f1000000-0000-4000-8000-0000000000a1', 'f1000000-0000-4000-8000-0000000000a1']::uuid[], '{}'::uuid[]) $$,
  '22023', 'filtro invalido', 'funil duplicado recusado');
select throws_ok(
  $$ select * from public.create_webhook_endpoint('https://a.example.com/x', array['deal.won'], null,
       null, '{}'::uuid[]) $$,
  '22023', 'filtro invalido', 'array nulo recusado (não vira "todos")');

-- 24-26. update_webhook_endpoint: troca filtros; outro tenant P0002; filtro inválido 22023.
select lives_ok(
  $$ select public.update_webhook_endpoint((select id from t_plain), 'https://a.example.com/plain2',
       array['deal.lost'], 'editado', array['f1000000-0000-4000-8000-0000000000a1']::uuid[],
       array['f1000000-0000-4000-8000-000000000a12']::uuid[]) $$,
  'admin A edita url, eventos, descrição e filtros');
select is(
  (select row(e.url, e.event_types, e.description, e.board_ids, e.stage_ids)::text
     from public.webhook_endpoints e where e.id = (select id from t_plain)),
  row('https://a.example.com/plain2', array['deal.lost'], 'editado',
      array['f1000000-0000-4000-8000-0000000000a1']::uuid[], array['f1000000-0000-4000-8000-000000000a12']::uuid[])::text,
  'update grava todos os campos'
);
select throws_ok(
  $$ select public.update_webhook_endpoint('f1000000-0000-4000-8000-0000000e00b1', 'https://a.example.com/x',
       array['deal.won'], null, '{}'::uuid[], '{}'::uuid[]) $$,
  'P0002', 'endpoint nao encontrado', 'endpoint do outro tenant: P0002');
select throws_ok(
  $$ select public.update_webhook_endpoint((select id from t_plain), 'https://a.example.com/x',
       array['deal.won'], null, '{}'::uuid[], array['f1000000-0000-4000-8000-000000000b11']::uuid[]) $$,
  '22023', 'filtro invalido', 'update com etapa de outro tenant: 22023');

-- 28. Agente C (sem developer.manage).
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-00000000000c","role":"authenticated"}', false);
select throws_ok(
  $$ select * from public.create_webhook_endpoint('https://c.example.com/x', array['deal.won'], null,
       '{}'::uuid[], '{}'::uuid[]) $$,
  '42501', 'permission denied', 'agente sem developer.manage não cria (5 parâmetros)');
select throws_ok(
  $$ select public.update_webhook_endpoint((select id from t_plain), 'https://c.example.com/x',
       array['deal.won'], null, '{}'::uuid[], '{}'::uuid[]) $$,
  '42501', 'permission denied', 'agente sem developer.manage não edita');

-- 30. board_id no deal.stage_changed (movimento humano pelo comando único).
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-00000000000a","role":"authenticated"}', false);
select is(
  public.transition_deal_stage(
    'f1000000-0000-4000-8000-0000000d0001', 'f1000000-0000-4000-8000-000000000a11',
    'f1000000-0000-4000-8000-000000000a12', 'human', null, 'Proposta enviada', '{"source":"pgtap"}', null,
    'filtro-move-1') ->> 'status',
  'accepted', 'movimento humano aceito');
reset role;
select is(
  (select array[ev.payload ->> 'board_id', ev.payload ->> 'to_stage_id', ev.payload ->> 'deal_id',
                (ev.payload ? 'history_id')::text]
     from public.domain_events ev
    where ev.event_type = 'deal.stage_changed' and ev.aggregate_id = 'f1000000-0000-4000-8000-0000000d0001'
    order by ev.occurred_at desc limit 1),
  array['f1000000-0000-4000-8000-0000000000a1', 'f1000000-0000-4000-8000-000000000a12',
        'f1000000-0000-4000-8000-0000000d0001', 'true'],
  'deal.stage_changed carrega board_id e mantém to_stage_id, deal_id, history_id'
);
select is(
  (select ev.idempotency_key from public.domain_events ev
    where ev.event_type = 'deal.stage_changed' and ev.aggregate_id = 'f1000000-0000-4000-8000-0000000d0001'
    order by ev.occurred_at desc limit 1),
  (select 'deal.stage_changed:v1:' || h.id from public.deal_stage_history h
    where h.deal_id = 'f1000000-0000-4000-8000-0000000d0001' order by h.created_at desc limit 1),
  'chave de idempotência inalterada'
);

-- 33-37. Apagar etapa filtrada: ativo vira filter_target_deleted; outros tenants e motivos anteriores intactos.
delete from public.board_stages where id = 'f1000000-0000-4000-8000-000000000a14';
select is(
  (select row(e.active, e.disabled_reason, e.stage_ids)::text from public.webhook_endpoints e
    where e.id = (select id from t_extra)),
  row(false, 'filter_target_deleted', array['f1000000-0000-4000-8000-000000000a14']::uuid[])::text,
  'etapa apagada: endpoint desativado com motivo e stage_ids intacto'
);
select is(
  (select row(e.active, e.disabled_reason, e.stage_ids)::text from public.webhook_endpoints e
    where e.id = 'f1000000-0000-4000-8000-0000000e00b2'),
  row(true, null::text, array['f1000000-0000-4000-8000-000000000b11']::uuid[])::text,
  'endpoint de B filtrado por OUTRA etapa não muda quando a etapa de A é apagada'
);
select is(
  (select row(e.active, e.disabled_reason)::text from public.webhook_endpoints e
    where e.id = 'f1000000-0000-4000-8000-0000000e00b3'),
  row(true, null::text)::text,
  'trigger escopado por tenant: endpoint de B que cita o id de A não é tocado'
);
select is(
  (select array_agg(e.disabled_reason order by e.disabled_reason) from public.webhook_endpoints e
    where e.id in ('f1000000-0000-4000-8000-0000000e00a1', 'f1000000-0000-4000-8000-0000000e00a2')
      and not e.active),
  array['gone', 'manual'],
  'endpoint já desligado (manual, gone) mantém o motivo ao apagar a etapa do filtro'
);
select is(
  (select e.active from public.webhook_endpoints e where e.id = (select id from t_pago)),
  true, 'endpoint filtrado por outra etapa segue ativo'
);

-- 36. Apagar funil filtrado (cascade apaga as etapas): endpoint desativado.
delete from public.boards where id = 'f1000000-0000-4000-8000-0000000000a2';
select is(
  (select row(e.active, e.disabled_reason, e.board_ids)::text from public.webhook_endpoints e
    where e.id = (select id from t_a2)),
  row(false, 'filter_target_deleted', array['f1000000-0000-4000-8000-0000000000a2']::uuid[])::text,
  'funil apagado: endpoint desativado com motivo e board_ids intacto'
);

-- 37-38. update com filtro válido reativa o endpoint desativado por filter_target_deleted.
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-00000000000a","role":"authenticated"}', false);
set local role authenticated;
select lives_ok(
  $$ select public.update_webhook_endpoint((select id from t_extra), 'https://a.example.com/extra',
       array['deal.stage_changed'], null, '{}'::uuid[], array['f1000000-0000-4000-8000-000000000a12']::uuid[]) $$,
  'admin corrige o filtro do endpoint desativado');
select is(
  (select row(e.active, e.disabled_reason)::text from public.webhook_endpoints e where e.id = (select id from t_extra)),
  row(true, null::text)::text,
  'update com filtro válido reativa endpoint desativado por filter_target_deleted'
);
select lives_ok(
  $$ select public.update_webhook_endpoint('f1000000-0000-4000-8000-0000000e00a1', 'https://a.example.com/manual',
       array['deal.stage_changed'], null, '{}'::uuid[], array['f1000000-0000-4000-8000-000000000a12']::uuid[]) $$,
  'admin corrige o filtro do endpoint pausado manualmente');
select lives_ok(
  $$ select public.update_webhook_endpoint('f1000000-0000-4000-8000-0000000e00a2', 'https://a.example.com/gone',
       array['deal.stage_changed'], null, '{}'::uuid[], array['f1000000-0000-4000-8000-000000000a12']::uuid[]) $$,
  'admin corrige o filtro do endpoint desligado por 410');
select is(
  (select row(e.active, e.disabled_reason)::text from public.webhook_endpoints e
    where e.id = 'f1000000-0000-4000-8000-0000000e00a1'),
  row(false, 'manual')::text,
  'editar o filtro não religa endpoint pausado manualmente'
);
select is(
  (select row(e.active, e.disabled_reason)::text from public.webhook_endpoints e
    where e.id = 'f1000000-0000-4000-8000-0000000e00a2'),
  row(false, 'gone')::text,
  'editar o filtro não religa endpoint desligado por 410 gone'
);

-- 39-40. apply_niche_template sobre o funil filtrado apaga as etapas antigas: endpoint desativado.
reset role;
revoke usage on schema private from authenticated;
set local role authenticated;
select lives_ok(
  $$ select public.apply_niche_template('f1000000-0000-4000-8000-0000000000a1', t.slug, t.base_prompt, t.stages, t.stage_prompts)
       from public.niche_templates t where t.slug = 'generico' $$,
  'admin aplica modelo de nicho no funil filtrado (ACL de produção)');
reset role;
select is(
  (select row(e.active, e.disabled_reason)::text from public.webhook_endpoints e where e.id = (select id from t_pago)),
  row(false, 'filter_target_deleted')::text,
  'apply_niche_template trocou as etapas: endpoint filtrado desativado, nunca vira "todos"'
);

select * from finish();
rollback;
