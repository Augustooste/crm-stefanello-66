-- v2 Task 2: motor de mapeamento (inbound_extract, inbound_render, inbound_resolve) e
-- dry run (preview_inbound_rule). Rodar: pnpm test:db.
begin;
create extension if not exists pgtap;

select plan(53);

-- Fixture: admin A e admin B (tenants próprios via handle_new_user) e agente C (convite no tenant A).
insert into auth.users (id, email) values
  ('e2000000-0000-4000-8000-00000000000a', 'engine-adm-a@test.local'),
  ('e2000000-0000-4000-8000-00000000000b', 'engine-adm-b@test.local');
insert into public.invites (tenant_id, email, role, token, expires_at)
select tenant_id, 'engine-agente-c@test.local', 'agent', 'engine-agent-token', now() + interval '1 day'
from public.profiles where id = 'e2000000-0000-4000-8000-00000000000a';
insert into auth.users (id, email, raw_user_meta_data) values
  ('e2000000-0000-4000-8000-00000000000c', 'engine-agente-c@test.local',
   '{"invite_token":"engine-agent-token"}');

create temp table fx(k text primary key, v uuid);
insert into fx select 'ta', tenant_id from public.profiles where id = 'e2000000-0000-4000-8000-00000000000a';
insert into fx select 'tb', tenant_id from public.profiles where id = 'e2000000-0000-4000-8000-00000000000b';
grant select on fx to public;

-- Tenant A: funil A1 (Novo, Proposta, Pago=is_won, Perdido=is_lost) e A2 (Outra). Tenant B: B1.
insert into public.boards (id, tenant_id, name) values
  ('e2000000-0000-4000-8000-0000000000a1', (select v from fx where k = 'ta'), 'Funil A1'),
  ('e2000000-0000-4000-8000-0000000000a2', (select v from fx where k = 'ta'), 'Funil A2'),
  ('e2000000-0000-4000-8000-0000000000b1', (select v from fx where k = 'tb'), 'Funil B1');
insert into public.board_stages (id, board_id, name, position, is_won, is_lost) values
  ('e2000000-0000-4000-8000-000000000a11', 'e2000000-0000-4000-8000-0000000000a1', 'Novo', 0, false, false),
  ('e2000000-0000-4000-8000-000000000a12', 'e2000000-0000-4000-8000-0000000000a1', 'Proposta', 1, false, false),
  ('e2000000-0000-4000-8000-000000000a13', 'e2000000-0000-4000-8000-0000000000a1', 'Pago', 2, true, false),
  ('e2000000-0000-4000-8000-000000000a14', 'e2000000-0000-4000-8000-0000000000a1', 'Perdido', 3, false, true),
  ('e2000000-0000-4000-8000-000000000a21', 'e2000000-0000-4000-8000-0000000000a2', 'Outra', 0, false, false),
  ('e2000000-0000-4000-8000-000000000b11', 'e2000000-0000-4000-8000-0000000000b1', 'Etapa B', 0, false, false);

-- Contatos. c2 mesclado em c1 (só merged_into_id, sem deleted_at: isola o filtro).
insert into public.contacts (id, tenant_id, name, email, phone) values
  ('e2000000-0000-4000-8000-0000000000c1', (select v from fx where k = 'ta'), 'Ana', 'Ana@Example.com', '+5511988887777'),
  ('e2000000-0000-4000-8000-0000000000c3', (select v from fx where k = 'ta'), 'Dup', 'dup@x.com', null),
  ('e2000000-0000-4000-8000-0000000000c4', (select v from fx where k = 'ta'), 'Ganho', 'won@x.com', null),
  ('e2000000-0000-4000-8000-0000000000c5', (select v from fx where k = 'ta'), 'Sem email', '', null),
  ('e2000000-0000-4000-8000-0000000000c6', (select v from fx where k = 'ta'), 'Na etapa', 'stage@x.com', null),
  ('e2000000-0000-4000-8000-0000000000c7', (select v from fx where k = 'ta'), 'Outro funil', 'other@x.com', null),
  ('e2000000-0000-4000-8000-0000000000cb', (select v from fx where k = 'tb'), 'So B', 'onlyb@x.com', null);
insert into public.contacts (id, tenant_id, name, email, merged_into_id) values
  ('e2000000-0000-4000-8000-0000000000c2', (select v from fx where k = 'ta'), 'Mesclado', 'merged@x.com',
   'e2000000-0000-4000-8000-0000000000c1');
-- c8 apagado (só deleted_at, sem merged_into_id: isola o filtro).
insert into public.contacts (id, tenant_id, name, email, deleted_at) values
  ('e2000000-0000-4000-8000-0000000000c8', (select v from fx where k = 'ta'), 'Apagado', 'deleted@x.com', now());

insert into public.deals (id, tenant_id, board_id, stage_id, contact_id, title, status, custom_fields) values
  ('e2000000-0000-4000-8000-0000000000d1', (select v from fx where k = 'ta'), 'e2000000-0000-4000-8000-0000000000a1',
   'e2000000-0000-4000-8000-000000000a11', 'e2000000-0000-4000-8000-0000000000c1', 'Negocio Ana', 'open', '{"pedido":"123"}'),
  ('e2000000-0000-4000-8000-0000000000d2', (select v from fx where k = 'ta'), 'e2000000-0000-4000-8000-0000000000a1',
   'e2000000-0000-4000-8000-000000000a11', 'e2000000-0000-4000-8000-0000000000c3', 'Dup 1', 'open', '{}'),
  ('e2000000-0000-4000-8000-0000000000d3', (select v from fx where k = 'ta'), 'e2000000-0000-4000-8000-0000000000a1',
   'e2000000-0000-4000-8000-000000000a12', 'e2000000-0000-4000-8000-0000000000c3', 'Dup 2', 'open', '{}'),
  ('e2000000-0000-4000-8000-0000000000d4', (select v from fx where k = 'ta'), 'e2000000-0000-4000-8000-0000000000a1',
   'e2000000-0000-4000-8000-000000000a13', 'e2000000-0000-4000-8000-0000000000c4', 'Ganho', 'won', '{}'),
  ('e2000000-0000-4000-8000-0000000000d5', (select v from fx where k = 'ta'), 'e2000000-0000-4000-8000-0000000000a1',
   'e2000000-0000-4000-8000-000000000a11', 'e2000000-0000-4000-8000-0000000000c5', 'Sem email', 'open', '{}'),
  ('e2000000-0000-4000-8000-0000000000d6', (select v from fx where k = 'ta'), 'e2000000-0000-4000-8000-0000000000a1',
   'e2000000-0000-4000-8000-000000000a12', 'e2000000-0000-4000-8000-0000000000c6', 'Na etapa', 'open', '{}'),
  ('e2000000-0000-4000-8000-0000000000d7', (select v from fx where k = 'ta'), 'e2000000-0000-4000-8000-0000000000a1',
   'e2000000-0000-4000-8000-000000000a11', 'e2000000-0000-4000-8000-0000000000c2', 'Do mesclado', 'open', '{}'),
  ('e2000000-0000-4000-8000-0000000000d8', (select v from fx where k = 'ta'), 'e2000000-0000-4000-8000-0000000000a2',
   'e2000000-0000-4000-8000-000000000a21', 'e2000000-0000-4000-8000-0000000000c7', 'Outro funil', 'open', '{}'),
  ('e2000000-0000-4000-8000-0000000000db', (select v from fx where k = 'tb'), 'e2000000-0000-4000-8000-0000000000b1',
   'e2000000-0000-4000-8000-000000000b11', 'e2000000-0000-4000-8000-0000000000cb', 'Negocio B', 'open', '{"pedido":"777"}'),
  ('e2000000-0000-4000-8000-0000000000d9', (select v from fx where k = 'ta'), 'e2000000-0000-4000-8000-0000000000a1',
   'e2000000-0000-4000-8000-000000000a11', 'e2000000-0000-4000-8000-0000000000c8', 'Do apagado', 'open', '{}');

-- Regras como dono do banco (a validação da criação já é coberta pela Task 1).
insert into public.inbound_rules (id, tenant_id, name, verification_mode, board_id, allowed_stage_ids,
  action, action_config, match_field, match_path, match_custom_field_key, event_id_path, conditions) values
  ('e2000000-0000-4000-8000-0000000e00a1', (select v from fx where k = 'ta'), 'Email', 'aceleraflow_hmac',
   'e2000000-0000-4000-8000-0000000000a1', array['e2000000-0000-4000-8000-000000000a12']::uuid[],
   'move_stage', '{"to_stage_id":"e2000000-0000-4000-8000-000000000a12"}', 'email', 'customer.email', null, 'id',
   '[{"path":"type","equals":"paid"}]'),
  ('e2000000-0000-4000-8000-0000000e00a2', (select v from fx where k = 'ta'), 'Telefone', 'aceleraflow_hmac',
   'e2000000-0000-4000-8000-0000000000a1', array['e2000000-0000-4000-8000-000000000a12']::uuid[],
   'add_note', '{"text":"Pago {{amount}} por {{customer.name}}","match_transform":"digits","match_prefix":"+55"}',
   'phone', 'phone', null, 'id', '[]'),
  ('e2000000-0000-4000-8000-0000000e00a3', (select v from fx where k = 'ta'), 'Pedido', 'aceleraflow_hmac',
   'e2000000-0000-4000-8000-0000000000a1', array['e2000000-0000-4000-8000-000000000a13']::uuid[],
   'mark_won', '{"to_stage_id":"e2000000-0000-4000-8000-000000000a13"}', 'deal_custom_field', 'order.ref', 'pedido',
   'id', '[]'),
  ('e2000000-0000-4000-8000-0000000e00a4', (select v from fx where k = 'ta'), 'Perda', 'aceleraflow_hmac',
   'e2000000-0000-4000-8000-0000000000a1', array['e2000000-0000-4000-8000-000000000a14']::uuid[],
   'mark_lost', '{"to_stage_id":"e2000000-0000-4000-8000-000000000a14","reason_path":"reason","reason_text":"Sem motivo {{id}}"}',
   'email', 'email', null, 'id', '[]'),
  ('e2000000-0000-4000-8000-0000000e00b1', (select v from fx where k = 'tb'), 'Regra B', 'aceleraflow_hmac',
   'e2000000-0000-4000-8000-0000000000b1', array['e2000000-0000-4000-8000-000000000b11']::uuid[],
   'add_note', '{"text":"nota"}', 'email', 'email', null, 'id', '[]');

-- Atalho: resolve uma regra (como service_role) para um corpo.
create function pg_temp.res(p_rule uuid, p_payload jsonb) returns jsonb
language sql as $$
  select private.inbound_resolve(r, p_payload) from public.inbound_rules r where r.id = p_rule
$$;
select set_config('request.jwt.claims', '{"role":"service_role"}', false);

-- 1-10. inbound_extract.
select is(private.inbound_extract('{"a":{"b":"x"}}', 'a.b'), 'x', 'extract: objeto aninhado');
select is(private.inbound_extract('{"items":[{"email":"p@x.com"}]}', 'items.0.email'), 'p@x.com',
  'extract: índice de array');
select is(private.inbound_extract('{"a":1}', 'a.b.c'), null, 'extract: caminho inexistente = null');
select is(private.inbound_extract('{"a":"  x  "}', 'a', 'trim'), 'x', 'extract: trim');
select is(private.inbound_extract('{"a":"AbC"}', 'a', 'lower'), 'abc', 'extract: lower');
select is(private.inbound_extract('{"a":"(11) 98888-7777"}', 'a', 'digits'), '11988887777', 'extract: digits');
select is(private.inbound_extract('{"a":"12990"}', 'a', 'cents_to_decimal'), '129.90', 'extract: cents_to_decimal');
select is(private.inbound_extract('{"a":"12,9x"}', 'a', 'cents_to_decimal'), null,
  'extract: cents_to_decimal com texto não numérico = null');
select is(private.inbound_extract('{"a":"   "}', 'a', 'trim'), null, 'extract: string vazia vira null');
select is(private.inbound_extract('{"a":12990}', 'a', 'cents_to_decimal'), '129.90',
  'extract: cents_to_decimal aceita número JSON');

-- 11-22. resolve por e-mail.
select is(
  (select jsonb_build_object('o', r ->> 'outcome', 'd', r ->> 'deal_id', 'f', r ->> 'from_stage_id',
                             't', r ->> 'target_stage_id', 'n', r ->> 'deal_title', 'e', r ->> 'external_event_id',
                             'c', r -> 'conditions_ok', 'i', r ->> 'identifier')
     from pg_temp.res('e2000000-0000-4000-8000-0000000e00a1',
       '{"id":"evt_1","type":"paid","customer":{"email":"  ANA@Example.COM "}}') r),
  jsonb_build_object('o', 'act', 'd', 'e2000000-0000-4000-8000-0000000000d1',
                     'f', 'e2000000-0000-4000-8000-000000000a11', 't', 'e2000000-0000-4000-8000-000000000a12',
                     'n', 'Negocio Ana', 'e', 'evt_1', 'c', true, 'i', 'ana@example.com'),
  'resolve: e-mail com maiúsculas e espaços casa o contato (plano completo)'
);
select is(pg_temp.res('e2000000-0000-4000-8000-0000000e00a1',
    '{"id":"e2","type":"paid","customer":{"email":"merged@x.com"}}') ->> 'outcome', 'not_found',
  'resolve: contato com merged_into_id não casa');
select is(pg_temp.res('e2000000-0000-4000-8000-0000000e00a1',
    '{"id":"e2b","type":"paid","customer":{"email":"deleted@x.com"}}') ->> 'outcome', 'not_found',
  'resolve: contato com deleted_at não casa');
select is(
  (select jsonb_build_object('o', r ->> 'outcome', 'd', r -> 'deal_id')
     from pg_temp.res('e2000000-0000-4000-8000-0000000e00a1',
       '{"id":"e3","type":"paid","customer":{"email":"onlyb@x.com"}}') r),
  jsonb_build_object('o', 'not_found', 'd', null),
  'resolve: e-mail do tenant B dá not_found sem deal_id'
);
select is(
  (select jsonb_build_object('o', r ->> 'outcome', 'd', r -> 'deal_id')
     from pg_temp.res('e2000000-0000-4000-8000-0000000e00a1',
       '{"id":"e4","type":"paid","customer":{"email":"dup@x.com"}}') r),
  jsonb_build_object('o', 'ambiguous', 'd', null),
  'resolve: 2 negócios abertos no funil dá ambiguous sem deal_id'
);
select is(pg_temp.res('e2000000-0000-4000-8000-0000000e00a1',
    '{"id":"e5","type":"paid","customer":{"email":"won@x.com"}}') ->> 'outcome', 'deal_not_open',
  'resolve: negócio won dá deal_not_open');
select is(pg_temp.res('e2000000-0000-4000-8000-0000000e00a1',
    '{"id":"e6","type":"paid","customer":{"email":""}}') ->> 'outcome', 'not_found',
  'resolve: identificador vazio dá not_found (existe negócio de contato com e-mail vazio)');
select is(pg_temp.res('e2000000-0000-4000-8000-0000000e00a1',
    '{"id":"e7","type":"paid"}') ->> 'outcome', 'not_found',
  'resolve: identificador ausente dá not_found');
select is(
  (select jsonb_build_object('o', r ->> 'outcome', 'c', r -> 'conditions_ok')
     from pg_temp.res('e2000000-0000-4000-8000-0000000e00a1',
       '{"id":"e8","type":"refunded","customer":{"email":"ana@example.com"}}') r),
  jsonb_build_object('o', 'ignored', 'c', false),
  'resolve: condição type diferente dá ignored'
);
select is(pg_temp.res('e2000000-0000-4000-8000-0000000e00a1',
    '{"type":"paid","customer":{"email":"ana@example.com"}}') ->> 'outcome', 'missing_event_id',
  'resolve: id do evento ausente dá missing_event_id');
select is(pg_temp.res('e2000000-0000-4000-8000-0000000e00a1',
    jsonb_build_object('id', repeat('x', 201), 'type', 'paid', 'customer', '{"email":"ana@example.com"}'::jsonb))
    ->> 'outcome', 'missing_event_id',
  'resolve: id do evento acima de 200 caracteres dá missing_event_id');
select is(pg_temp.res('e2000000-0000-4000-8000-0000000e00a1',
    '{"id":"e9","type":"paid","customer":{"email":"stage@x.com"}}') ->> 'outcome', 'already_in_stage',
  'resolve: negócio já na etapa destino dá already_in_stage');
select is(pg_temp.res('e2000000-0000-4000-8000-0000000e00a1',
    '{"id":"e10","type":"paid","customer":{"email":"other@x.com"}}') ->> 'outcome', 'not_found',
  'resolve: negócio só em outro funil dá not_found');

-- 23-27. telefone e modelos.
select is(
  (select jsonb_build_object('o', r ->> 'outcome', 'd', r ->> 'deal_id', 'i', r ->> 'identifier')
     from pg_temp.res('e2000000-0000-4000-8000-0000000e00a2', '{"id":"p1","phone":"(11) 98888-7777"}') r),
  jsonb_build_object('o', 'act', 'd', 'e2000000-0000-4000-8000-0000000000d1', 'i', '+5511988887777'),
  'resolve: telefone (11) 98888-7777 com digits e prefixo casa +5511988887777'
);
select is(pg_temp.res('e2000000-0000-4000-8000-0000000e00a2', '{"id":"p2","phone":"+55 11 98888-7777"}')
    ->> 'identifier', '+5511988887777',
  'resolve: telefone já em E.164 não ganha o prefixo de novo');
select is(pg_temp.res('e2000000-0000-4000-8000-0000000e00a2',
    '{"id":"p3","phone":"11988887777","amount":129,"customer":{"name":"Ana"}}') ->> 'note_text', 'Pago 129 por Ana',
  'resolve: nota com {{caminho}} substituído');
select is(pg_temp.res('e2000000-0000-4000-8000-0000000e00a2',
    '{"id":"p4","phone":"11988887777","amount":"{{id}}","customer":{"name":"{{phone}}"}}') ->> 'note_text',
  'Pago {{id}} por {{phone}}',
  'resolve: valor extraído com {{x}} não é substituído de novo (sem avaliação)');
select is(char_length(pg_temp.res('e2000000-0000-4000-8000-0000000e00a2',
    jsonb_build_object('id', 'p5', 'phone', '11988887777', 'customer', jsonb_build_object('name', repeat('a', 600))))
    ->> 'note_text'), 500,
  'resolve: nota cortada em 500 caracteres');

-- 28-29. campo personalizado do negócio.
select is(
  (select jsonb_build_object('o', r ->> 'outcome', 'd', r ->> 'deal_id', 't', r ->> 'target_stage_id')
     from pg_temp.res('e2000000-0000-4000-8000-0000000e00a3', '{"id":"o1","order":{"ref":"123"}}') r),
  jsonb_build_object('o', 'act', 'd', 'e2000000-0000-4000-8000-0000000000d1', 't', 'e2000000-0000-4000-8000-000000000a13'),
  'resolve: custom_fields ->> pedido = 123 casa'
);
select is(pg_temp.res('e2000000-0000-4000-8000-0000000e00a3', '{"id":"o2","order":{"ref":"777"}}') ->> 'outcome',
  'not_found', 'resolve: pedido que só existe no tenant B dá not_found');

-- 30-31. motivo de perda.
select is(pg_temp.res('e2000000-0000-4000-8000-0000000e00a4',
    '{"id":"l1","email":"ana@example.com","reason":"  Cliente desistiu "}') ->> 'reason', 'Cliente desistiu',
  'resolve: motivo pelo caminho');
select is(pg_temp.res('e2000000-0000-4000-8000-0000000e00a4',
    '{"id":"l2","email":"ana@example.com"}') ->> 'reason', 'Sem motivo l2',
  'resolve: motivo ausente usa o texto padrão com {{caminho}}');

-- 32-33. Guarda dentro de inbound_resolve (remix não herda REVOKE). Como dono do banco
-- (tem EXECUTE), com claims de usuário: só o admin do tenant da regra passa.
select set_config('request.jwt.claims', '{"sub":"e2000000-0000-4000-8000-00000000000b","role":"authenticated"}', false);
select throws_ok(
  $$select pg_temp.res('e2000000-0000-4000-8000-0000000e00a1', '{"id":"g1","type":"paid","customer":{"email":"ana@example.com"}}')$$,
  '42501', 'permission denied', 'resolve: admin B não resolve regra do tenant A');
select set_config('request.jwt.claims', '{"sub":"e2000000-0000-4000-8000-00000000000a","role":"authenticated"}', false);
select is(pg_temp.res('e2000000-0000-4000-8000-0000000e00a1',
    '{"id":"g2","type":"paid","customer":{"email":"ana@example.com"}}') ->> 'outcome', 'act',
  'resolve: controle positivo, admin A resolve a própria regra');

-- 34-40. Catálogo: volatilidade, SET só search_path, EXECUTE.
select is((select provolatile::text from pg_proc where oid = 'private.inbound_resolve(public.inbound_rules,jsonb)'::regprocedure),
  's', 'inbound_resolve é stable');
select is((select provolatile::text from pg_proc where oid = 'public.preview_inbound_rule(uuid,jsonb)'::regprocedure),
  's', 'preview_inbound_rule é stable');
select is((select provolatile::text from pg_proc where oid = 'private.inbound_extract(jsonb,text,text)'::regprocedure),
  'i', 'inbound_extract é immutable');
select ok(
  (select bool_and(prosecdef) from pg_proc
    where oid in ('private.inbound_resolve(public.inbound_rules,jsonb)'::regprocedure,
                  'public.preview_inbound_rule(uuid,jsonb)'::regprocedure)),
  'resolve e preview são security definer'
);
select is(
  (select count(*)::int from pg_proc p, unnest(p.proconfig) c
    where p.oid in ('private.inbound_extract(jsonb,text,text)'::regprocedure,
                    'private.inbound_render(text,jsonb)'::regprocedure,
                    'private.inbound_resolve(public.inbound_rules,jsonb)'::regprocedure,
                    'public.preview_inbound_rule(uuid,jsonb)'::regprocedure)
      and c not like 'search\_path=%'),
  0, 'nenhuma função nova tem SET além de search_path'
);
select ok(
  not has_function_privilege('anon', 'private.inbound_extract(jsonb,text,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.inbound_extract(jsonb,text,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'private.inbound_render(text,jsonb)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.inbound_render(text,jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'private.inbound_resolve(public.inbound_rules,jsonb)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.inbound_resolve(public.inbound_rules,jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.preview_inbound_rule(uuid,jsonb)', 'EXECUTE'),
  'anon e authenticated sem EXECUTE nas funções privadas; anon sem EXECUTE no preview'
);
select ok(
  has_function_privilege('authenticated', 'public.preview_inbound_rule(uuid,jsonb)', 'EXECUTE')
  and has_function_privilege('service_role', 'private.inbound_resolve(public.inbound_rules,jsonb)', 'EXECUTE'),
  'controle positivo: authenticated executa o preview e service_role o resolve'
);

-- 41-47. Dry run: contagens como dono (sem RLS) antes e depois do preview do admin A.
create temp table counts_before as
  select (select count(*) from public.deals) as deals,
         (select count(*) from public.deal_stage_history) as history,
         (select count(*) from public.domain_events) as events,
         (select count(*) from public.inbound_events) as inbound,
         (select count(*) from public.activities) as activities;
select ok((select deals from counts_before) > 0, 'controle positivo: há negócios para contar');

set local role authenticated;
select is(
  (select count(*)::int from (
     select public.preview_inbound_rule('e2000000-0000-4000-8000-0000000e00a1',
       '{"id":"pv1","type":"paid","customer":{"email":"ana@example.com"}}') as r
     union all
     select public.preview_inbound_rule('e2000000-0000-4000-8000-0000000e00a3', '{"id":"pv2","order":{"ref":"123"}}')
     union all
     select public.preview_inbound_rule('e2000000-0000-4000-8000-0000000e00a2', '{"id":"pv3","phone":"11988887777"}')
   ) s where r ->> 'outcome' = 'act'),
  3, 'preview: admin A recebe o plano (act) das 3 regras');
select is(
  (select jsonb_build_object('o', r ->> 'outcome', 'd', r -> 'deal_id')
     from (select public.preview_inbound_rule('e2000000-0000-4000-8000-0000000e00a1',
             '{"id":"pv4","type":"paid","customer":{"email":"onlyb@x.com"}}') as r) s),
  jsonb_build_object('o', 'not_found', 'd', null),
  'preview: e-mail do tenant B não devolve deal_id de outro tenant'
);
reset role;

select is(
  (select row(deals, history, events, inbound, activities)::text from counts_before),
  (select row((select count(*) from public.deals), (select count(*) from public.deal_stage_history),
              (select count(*) from public.domain_events), (select count(*) from public.inbound_events),
              (select count(*) from public.activities))::text),
  'dry run: deals, deal_stage_history, domain_events, inbound_events e activities sem mudança'
);
select is((select stage_id from public.deals where id = 'e2000000-0000-4000-8000-0000000000d1'),
  'e2000000-0000-4000-8000-000000000a11'::uuid, 'dry run: negócio continua na etapa de origem');

set local role authenticated;
select throws_ok(
  $$select public.preview_inbound_rule('e2000000-0000-4000-8000-0000000e00b1', '{"id":"x"}')$$,
  'P0002', 'regra nao encontrada', 'preview: regra do outro tenant dá P0002');
select throws_ok(
  $$select public.preview_inbound_rule('e2000000-0000-4000-8000-0000000e00a1',
      jsonb_build_object('id', 'big', 'pad', repeat('x', 65536)))$$,
  '22023', 'amostra invalida (maximo 64 KB)', 'preview: amostra acima de 64 KB recusada');
select throws_ok(
  $$select public.preview_inbound_rule('e2000000-0000-4000-8000-0000000e00a1', null)$$,
  '22023', 'amostra invalida (maximo 64 KB)', 'preview: amostra nula recusada');
select lives_ok(
  $$select public.preview_inbound_rule('e2000000-0000-4000-8000-0000000e00a1',
      jsonb_build_object('id', 'ok', 'pad', repeat('x', 65000)))$$,
  'preview: amostra logo abaixo de 64 KB aceita');

-- 50-52. Sem permissão (agente C do tenant A) e anon.
select set_config('request.jwt.claims', '{"sub":"e2000000-0000-4000-8000-00000000000c","role":"authenticated"}', false);
select throws_ok(
  $$select public.preview_inbound_rule('e2000000-0000-4000-8000-0000000e00a1', '{"id":"x"}')$$,
  '42501', 'permission denied', 'preview: agente sem developer.manage dá 42501');
select throws_ok(
  $$select private.inbound_resolve(null::public.inbound_rules, '{"id":"x"}'::jsonb)$$,
  '42501', null, 'resolve: authenticated sem EXECUTE');
reset role;
set local role anon;
select throws_ok(
  $$select public.preview_inbound_rule('e2000000-0000-4000-8000-0000000e00a1', '{"id":"x"}')$$,
  '42501', null, 'preview: anon sem EXECUTE');
reset role;

select * from finish();
rollback;
