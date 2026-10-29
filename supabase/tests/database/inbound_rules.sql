-- v2 Task 1: regras de entrada (inbound_rules, inbound_events), segredo no vault,
-- validação da configuração, RPCs de gestão com developer.manage e grants por coluna.
-- Rodar: pnpm test:db.
begin;
create extension if not exists pgtap;

select plan(73);

-- Fixture: admin A e admin B (tenants próprios via handle_new_user) e agente C (convite no tenant A).
insert into auth.users (id, email) values
  ('e1000000-0000-4000-8000-00000000000a', 'inbound-adm-a@test.local'),
  ('e1000000-0000-4000-8000-00000000000b', 'inbound-adm-b@test.local');
insert into public.invites (tenant_id, email, role, token, expires_at)
select tenant_id, 'inbound-agente-c@test.local', 'agent', 'inbound-agent-token', now() + interval '1 day'
from public.profiles where id = 'e1000000-0000-4000-8000-00000000000a';
insert into auth.users (id, email, raw_user_meta_data) values
  ('e1000000-0000-4000-8000-00000000000c', 'inbound-agente-c@test.local',
   '{"invite_token":"inbound-agent-token"}');

-- Tenant A: funil A1 (Novo, Proposta, Pago=is_won, Perdido=is_lost), A2 (Outra), A3 (Apagar).
-- Tenant B: funil B1 (Etapa B).
insert into public.boards (id, tenant_id, name)
select v.id::uuid, p.tenant_id, v.name
  from public.profiles p,
       (values ('e1000000-0000-4000-8000-0000000000a1', 'Funil A1'),
               ('e1000000-0000-4000-8000-0000000000a2', 'Funil A2'),
               ('e1000000-0000-4000-8000-0000000000a3', 'Funil A3')) as v(id, name)
 where p.id = 'e1000000-0000-4000-8000-00000000000a';
insert into public.boards (id, tenant_id, name)
select 'e1000000-0000-4000-8000-0000000000b1', tenant_id, 'Funil B1'
  from public.profiles where id = 'e1000000-0000-4000-8000-00000000000b';
insert into public.board_stages (id, board_id, name, position, is_won, is_lost) values
  ('e1000000-0000-4000-8000-000000000a11', 'e1000000-0000-4000-8000-0000000000a1', 'Novo', 0, false, false),
  ('e1000000-0000-4000-8000-000000000a12', 'e1000000-0000-4000-8000-0000000000a1', 'Proposta', 1, false, false),
  ('e1000000-0000-4000-8000-000000000a13', 'e1000000-0000-4000-8000-0000000000a1', 'Pago', 2, true, false),
  ('e1000000-0000-4000-8000-000000000a14', 'e1000000-0000-4000-8000-0000000000a1', 'Perdido', 3, false, true),
  ('e1000000-0000-4000-8000-000000000a21', 'e1000000-0000-4000-8000-0000000000a2', 'Outra', 0, false, false),
  ('e1000000-0000-4000-8000-000000000a31', 'e1000000-0000-4000-8000-0000000000a3', 'Apagar', 0, false, false),
  ('e1000000-0000-4000-8000-000000000b11', 'e1000000-0000-4000-8000-0000000000b1', 'Etapa B', 0, false, false);
-- Campo personalizado "pedido" só no tenant A; "pedido_b" só no tenant B.
insert into public.custom_field_definitions (tenant_id, entity, key, label, field_type)
select tenant_id, 'deal', 'pedido', 'Pedido', 'text'
  from public.profiles where id = 'e1000000-0000-4000-8000-00000000000a';
insert into public.custom_field_definitions (tenant_id, entity, key, label, field_type)
select tenant_id, 'deal', 'pedido_b', 'Pedido B', 'text'
  from public.profiles where id = 'e1000000-0000-4000-8000-00000000000b';
-- Regra do tenant B (como dono do banco) para os testes de isolamento.
insert into public.inbound_rules (id, tenant_id, name, verification_mode, board_id, allowed_stage_ids,
  action, action_config, match_field, match_path, event_id_path)
select 'e1000000-0000-4000-8000-0000000e00b1', tenant_id, 'Regra B', 'aceleraflow_hmac',
       'e1000000-0000-4000-8000-0000000000b1', array['e1000000-0000-4000-8000-000000000b11']::uuid[],
       'add_note', '{"text":"nota"}', 'email', 'email', 'id'
  from public.profiles where id = 'e1000000-0000-4000-8000-00000000000b';

-- Atalho de criação com defaults válidos (move_stage para Proposta no funil A1).
create function pg_temp.mk(
  p_action text default 'move_stage',
  p_cfg jsonb default '{"to_stage_id":"e1000000-0000-4000-8000-000000000a12"}',
  p_stages uuid[] default array['e1000000-0000-4000-8000-000000000a11', 'e1000000-0000-4000-8000-000000000a12',
                                'e1000000-0000-4000-8000-000000000a13', 'e1000000-0000-4000-8000-000000000a14']::uuid[],
  p_board uuid default 'e1000000-0000-4000-8000-0000000000a1',
  p_match_field text default 'email',
  p_match_path text default 'customer.email',
  p_key text default null,
  p_event_path text default 'id',
  p_conditions jsonb default '[]',
  p_mode text default 'aceleraflow_hmac',
  p_header text default null,
  p_secret text default null,
  p_name text default 'Regra'
) returns table(id uuid, secret text)
language sql as $$
  select * from public.create_inbound_rule(p_name, p_mode, p_header, p_secret, p_board, p_stages, p_action,
    p_cfg, p_match_field, p_match_path, p_key, p_event_path, p_conditions, 'ignore')
$$;
grant execute on function pg_temp.mk(text, jsonb, uuid[], uuid, text, text, text, text, jsonb, text, text, text, text) to public;

-- 1-4. Estrutura.
select has_table('public', 'inbound_rules', 'tabela inbound_rules existe');
select has_table('public', 'inbound_events', 'tabela inbound_events existe');
select col_is_unique('public', 'inbound_events', array['rule_id', 'external_event_id'],
  'unique (rule_id, external_event_id) existe');
select has_index('public', 'inbound_events', 'inbound_events_tenant_received_idx',
  'índice (tenant_id, received_at desc) existe');

-- 5-9. Grants de tabela e coluna (lição I5: conferir coluna, não só tabela).
select ok(
  not exists (select 1 from information_schema.column_privileges
               where table_schema = 'public' and table_name = 'inbound_rules' and grantee = 'authenticated'
                 and column_name in ('vault_secret_id', 'previous_vault_secret_id')),
  'authenticated sem privilégio nas colunas de vault'
);
select ok(
  has_column_privilege('authenticated', 'public.inbound_rules', 'name', 'SELECT')
  and has_column_privilege('authenticated', 'public.inbound_events', 'status', 'SELECT')
  and not has_table_privilege('authenticated', 'public.inbound_rules', 'INSERT')
  and not has_table_privilege('authenticated', 'public.inbound_events', 'UPDATE'),
  'controle positivo: authenticated lê por coluna e não escreve'
);
select ok(
  not has_table_privilege('anon', 'public.inbound_rules', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
  and not has_table_privilege('anon', 'public.inbound_events', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
  'anon sem privilégio de tabela nas 2 tabelas'
);
select ok(
  not has_any_column_privilege('anon', 'public.inbound_rules', 'SELECT, INSERT, UPDATE, REFERENCES')
  and not has_any_column_privilege('anon', 'public.inbound_events', 'SELECT, INSERT, UPDATE, REFERENCES'),
  'anon sem privilégio de coluna nas 2 tabelas'
);
select ok(
  (select bool_and(c.relrowsecurity) from pg_class c
    where c.oid in ('public.inbound_rules'::regclass, 'public.inbound_events'::regclass)),
  'RLS ligado nas 2 tabelas'
);

-- 10-13. EXECUTE das funções.
select ok(
  not has_function_privilege('anon', 'public.create_inbound_rule(text,text,text,text,uuid,uuid[],text,jsonb,text,text,text,text,jsonb,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.update_inbound_rule(uuid,text,text,uuid,uuid[],text,jsonb,text,text,text,text,jsonb,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.set_inbound_rule_active(uuid,boolean)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.rotate_inbound_rule_secret(uuid,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.delete_inbound_rule(uuid)', 'EXECUTE'),
  'anon não executa nenhuma RPC de gestão'
);
select ok(
  has_function_privilege('authenticated', 'public.create_inbound_rule(text,text,text,text,uuid,uuid[],text,jsonb,text,text,text,text,jsonb,text)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.update_inbound_rule(uuid,text,text,uuid,uuid[],text,jsonb,text,text,text,text,jsonb,text)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.set_inbound_rule_active(uuid,boolean)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.rotate_inbound_rule_secret(uuid,text)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.delete_inbound_rule(uuid)', 'EXECUTE'),
  'authenticated executa as RPCs de gestão'
);
select ok(
  not has_function_privilege('authenticated', 'private.assert_inbound_rule_config(uuid,uuid,uuid[],text,jsonb,text,text,text,text,jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'private.assert_inbound_rule_config(uuid,uuid,uuid[],text,jsonb,text,text,text,text,jsonb)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.assert_inbound_verification(text,text,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.inbound_path_is_valid(text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.inbound_rules_delete_secrets()', 'EXECUTE'),
  'funções privadas sem EXECUTE para authenticated/anon'
);
-- Remix: GUC de extensão no cabeçalho aborta o pg_dump; só search_path é permitido.
select is(
  (select coalesce(string_agg(p.proname, ', ' order by p.proname), '')
     from pg_proc p
    where p.proname in ('create_inbound_rule', 'update_inbound_rule', 'set_inbound_rule_active',
                        'rotate_inbound_rule_secret', 'delete_inbound_rule', 'assert_inbound_rule_config',
                        'assert_inbound_verification', 'inbound_path_is_valid', 'inbound_rules_delete_secrets')
      and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c not like 'search_path=%')),
  '', 'nenhuma função nova tem SET além de search_path'
);

-- Admin A.
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-00000000000a","role":"authenticated"}', false);
set local role authenticated;

-- 14-16. Criação HMAC: segredo whin_ devolvido uma vez.
create temp table t_hmac on commit drop as select * from pg_temp.mk(p_name => 'Stripe pago');
grant all on t_hmac to public;
select ok((select secret ~ '^whin_[0-9a-f]{64}$' from t_hmac), 'HMAC devolve segredo whin_ + 32 bytes hex');
select is((select count(*)::int from public.inbound_rules r where r.id = (select id from t_hmac)), 1,
  'admin A lê a própria regra');
select throws_ok($$ select vault_secret_id from public.inbound_rules $$, '42501', null,
  'authenticated não lê vault_secret_id');

-- 17-20. Modos externos.
create temp table t_stripe on commit drop as
  select * from pg_temp.mk(p_mode => 'stripe_signature', p_secret => 'whsec_segredo_externo_teste');
grant all on t_stripe to public;
select ok((select id is not null and secret is null from t_stripe), 'stripe_signature cria e não devolve o segredo colado');
select throws_ok($$ select * from pg_temp.mk(p_mode => 'stripe_signature', p_secret => 'curto') $$,
  '22023', null, 'segredo externo com menos de 8 caracteres recusado');
select throws_ok($$ select * from pg_temp.mk(p_mode => 'header_token', p_secret => 'token-asaas-123') $$,
  '22023', null, 'header_token sem nome de header recusado');
create temp table t_header on commit drop as
  select * from pg_temp.mk(p_mode => 'header_token', p_header => 'asaas-access-token', p_secret => 'token-asaas-123');
grant all on t_header to public;
select ok((select id is not null and secret is null from t_header), 'header_token com header válido cria');
-- 20a-20c. Header reservado (Task 6, item D): mesma lista de RESERVED_TOKEN_HEADERS da edge.
select throws_ok($$ select * from pg_temp.mk(p_mode => 'header_token', p_header => 'Authorization', p_secret => 'token-asaas-123') $$,
  '22023', 'header do token reservado: escolha outro nome (ex.: asaas-access-token)',
  'header_token com Authorization recusado na criação');
select throws_ok($$ select * from pg_temp.mk(p_mode => 'header_token', p_header => 'content-length', p_secret => 'token-asaas-123') $$,
  '22023', 'header do token reservado: escolha outro nome (ex.: asaas-access-token)',
  'header_token com content-length recusado na criação');
select throws_ok($$ select public.update_inbound_rule((select id from t_header), 'x', 'Cookie',
       'e1000000-0000-4000-8000-0000000000a1', array['e1000000-0000-4000-8000-000000000a13']::uuid[],
       'add_note', '{"text":"x"}', 'email', 'email', null, 'id', '[]', 'ignore') $$,
  '22023', 'header do token reservado: escolha outro nome (ex.: asaas-access-token)',
  'update com Cookie recusado');

-- 21-36. Validação: 22023.
select throws_ok($$ select * from pg_temp.mk(p_board => 'e1000000-0000-4000-8000-0000000000b1',
       p_stages => array['e1000000-0000-4000-8000-000000000b11']::uuid[],
       p_action => 'add_note', p_cfg => '{"text":"x"}') $$,
  '22023', 'funil invalido', 'funil do tenant B recusado');
select throws_ok($$ select * from pg_temp.mk(p_board => gen_random_uuid(),
       p_stages => array['e1000000-0000-4000-8000-000000000a11']::uuid[],
       p_action => 'add_note', p_cfg => '{"text":"x"}') $$,
  '22023', 'funil invalido', 'funil inexistente dá a mesma mensagem do funil de outro tenant');
select throws_ok($$ select * from pg_temp.mk(p_stages => array['e1000000-0000-4000-8000-000000000a12',
       'e1000000-0000-4000-8000-000000000a21']::uuid[]) $$,
  '22023', 'etapas invalidas', 'etapa de outro funil do mesmo tenant recusada');
select throws_ok($$ select * from pg_temp.mk(p_stages => array['e1000000-0000-4000-8000-000000000a12',
       'e1000000-0000-4000-8000-000000000b11']::uuid[]) $$,
  '22023', 'etapas invalidas', 'etapa do tenant B recusada');
select throws_ok($$ select * from pg_temp.mk(p_stages => array['e1000000-0000-4000-8000-000000000a11']::uuid[]) $$,
  '22023', 'destino invalido', 'destino da ação fora de allowed_stage_ids recusado');
select throws_ok($$ select * from pg_temp.mk(p_action => 'mark_won',
       p_cfg => '{"to_stage_id":"e1000000-0000-4000-8000-000000000a12"}') $$,
  '22023', 'destino invalido', 'mark_won com destino que não é is_won recusado');
select throws_ok($$ select * from pg_temp.mk(p_action => 'mark_lost',
       p_cfg => '{"to_stage_id":"e1000000-0000-4000-8000-000000000a14"}') $$,
  '22023', 'motivo obrigatorio', 'mark_lost sem motivo recusado');
select throws_ok($$ select * from pg_temp.mk(p_action => 'mark_lost',
       p_cfg => '{"to_stage_id":"e1000000-0000-4000-8000-000000000a14","reason_path":5}') $$,
  '22023', 'motivo invalido', 'reason_path numérico recusado');
select throws_ok($$ select * from pg_temp.mk(p_cfg => '{"to_stage_id":"e1000000-0000-4000-8000-000000000a13"}') $$,
  '22023', 'destino invalido', 'move_stage para etapa de ganho recusado (ganho tem ação própria)');
select throws_ok($$ select * from pg_temp.mk(p_match_path => 'customer..email') $$,
  '22023', 'caminho invalido', 'caminho com segmento vazio recusado');
select throws_ok($$ select * from pg_temp.mk(p_event_path => 'a.b.c.d.e.f.g.h.i.j.k') $$,
  '22023', 'caminho invalido', 'caminho com mais de 10 segmentos recusado');
select throws_ok($$ select * from pg_temp.mk(p_match_path => 'customer.e$mail') $$,
  '22023', 'caminho invalido', 'caminho com caractere fora de letras, dígitos, _ e - recusado');
select throws_ok($$ select * from pg_temp.mk(p_conditions => '[{"path":"data object","equals":"x"}]') $$,
  '22023', 'caminho invalido', 'condição com caminho inválido recusada');
select throws_ok($$ select * from pg_temp.mk(p_cfg => '{"to_stage_id":"e1000000-0000-4000-8000-000000000a12","match_transform":"upper"}') $$,
  '22023', 'transformacao invalida', 'transformação fora da lista recusada');
select throws_ok($$ select * from pg_temp.mk(p_conditions => '[{"path":"type","equals":"x","transform":"eval"}]') $$,
  '22023', 'transformacao invalida', 'transformação de condição fora da lista recusada');
select throws_ok($$ select * from pg_temp.mk(p_match_field => 'deal_custom_field', p_key => 'pedido_b') $$,
  '22023', 'campo personalizado invalido', 'deal_custom_field sem definição no tenant recusado (chave do tenant B)');
select throws_ok($$ select * from pg_temp.mk(p_cfg => '{"to_stage_id":"e1000000-0000-4000-8000-000000000a12","script":"x"}') $$,
  '22023', 'configuracao da acao invalida', 'chave desconhecida em action_config recusada');
select throws_ok($$ select * from pg_temp.mk(p_conditions =>
       '[{"path":"a","equals":"1"},{"path":"a","equals":"1"},{"path":"a","equals":"1"},{"path":"a","equals":"1"},{"path":"a","equals":"1"},{"path":"a","equals":"1"}]') $$,
  '22023', 'condicoes invalidas', '6 condições recusadas');

-- 37-39. Configurações válidas das demais ações.
select lives_ok($$ select * from pg_temp.mk(p_match_field => 'deal_custom_field', p_key => 'pedido',
       p_match_path => 'externalReference', p_action => 'mark_won',
       p_cfg => '{"to_stage_id":"e1000000-0000-4000-8000-000000000a13"}',
       p_conditions => '[{"path":"event","equals":"PAYMENT_RECEIVED"}]') $$,
  'deal_custom_field com definição do tenant + mark_won + condição aceitos');
select lives_ok($$ select * from pg_temp.mk(p_match_field => 'phone', p_match_path => 'customer.phone',
       p_action => 'mark_lost',
       p_cfg => '{"to_stage_id":"e1000000-0000-4000-8000-000000000a14","reason_text":"Pagamento recusado","match_transform":"digits","match_prefix":"+55"}') $$,
  'mark_lost com motivo fixo, telefone com digits e prefixo aceitos');
select lives_ok($$ select * from pg_temp.mk(p_action => 'create_activity',
       p_cfg => '{"title":"Ligar para {{customer.name}}","due_in_hours":24}') $$,
  'create_activity com título e prazo aceito');

-- 40-42. RLS e isolamento entre tenants.
select is((select count(*)::int from public.inbound_rules r where r.id = 'e1000000-0000-4000-8000-0000000e00b1'), 0,
  'admin A não vê regra do tenant B');
select throws_ok($$ select public.update_inbound_rule('e1000000-0000-4000-8000-0000000e00b1', 'x', null,
       'e1000000-0000-4000-8000-0000000000b1', array['e1000000-0000-4000-8000-000000000b11']::uuid[],
       'add_note', '{"text":"x"}', 'email', 'email', null, 'id', '[]', 'ignore') $$,
  'P0002', 'regra nao encontrada', 'admin A não edita regra do tenant B');
select throws_ok($$ select public.delete_inbound_rule('e1000000-0000-4000-8000-0000000e00b1') $$,
  'P0002', 'regra nao encontrada', 'admin A não apaga regra do tenant B');
select throws_ok($$ select public.rotate_inbound_rule_secret('e1000000-0000-4000-8000-0000000e00b1', null) $$,
  'P0002', 'regra nao encontrada', 'admin A não rotaciona segredo de regra do tenant B');
select throws_ok($$ select public.set_inbound_rule_active('e1000000-0000-4000-8000-0000000e00b1', false) $$,
  'P0002', 'regra nao encontrada', 'admin A não pausa regra do tenant B');

-- 43-44. update e pausa.
select lives_ok($$ select public.update_inbound_rule((select id from t_hmac), 'Stripe editada', null,
       'e1000000-0000-4000-8000-0000000000a1', array['e1000000-0000-4000-8000-000000000a13']::uuid[],
       'mark_won', '{"to_stage_id":"e1000000-0000-4000-8000-000000000a13"}', 'email', 'data.object.customer_details.email',
       null, 'id', '[{"path":"type","equals":"checkout.session.completed"}]', 'record') $$,
  'admin A edita a própria regra');
select public.set_inbound_rule_active((select id from t_hmac), false);
select is(
  (select row(r.name, r.action, r.not_found_mode, r.active, r.disabled_reason, r.verification_mode)::text
     from public.inbound_rules r where r.id = (select id from t_hmac)),
  row('Stripe editada', 'mark_won', 'record', false, 'manual', 'aceleraflow_hmac')::text,
  'update grava os campos, modo não muda e pausa grava disabled_reason manual'
);

-- 45-47. Rotação: segredo novo whin_, anterior por 24 h; modo externo exige segredo e devolve null.
create temp table t_rot on commit drop as select public.rotate_inbound_rule_secret((select id from t_hmac), null) as secret;
grant all on t_rot to public;
select ok((select r.secret ~ '^whin_[0-9a-f]{64}$' and r.secret <> (select h.secret from t_hmac h) from t_rot r),
  'rotação HMAC devolve segredo novo');
select ok(
  (select r.previous_secret_expires_at between now() + interval '23 hours 59 minutes' and now() + interval '24 hours 1 minute'
     from public.inbound_rules r where r.id = (select id from t_hmac)),
  'anterior vale 24 h');
select throws_ok($$ select public.rotate_inbound_rule_secret((select id from t_stripe), null) $$,
  '22023', null, 'rotação de modo externo sem segredo novo recusada');

-- 48. 21ª regra: 54000.
do $$
begin
  while (select count(*) from public.inbound_rules) < 20 loop
    perform * from pg_temp.mk();
  end loop;
end $$;
select throws_ok($$ select * from pg_temp.mk() $$, '54000', null, '21ª regra do tenant recusada');

-- 49-50. Agente C (sem developer.manage).
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-00000000000c","role":"authenticated"}', false);
select throws_ok($$ select * from pg_temp.mk() $$, '42501', 'permission denied', 'agente sem developer.manage não cria');
select throws_ok($$ select public.rotate_inbound_rule_secret((select id from t_stripe), 'whsec_segredo_novo_teste') $$,
  '42501', 'permission denied', 'agente sem developer.manage não rotaciona');
select throws_ok($$ select public.set_inbound_rule_active((select id from t_stripe), false) $$,
  '42501', 'permission denied', 'agente sem developer.manage não pausa');
select throws_ok($$ select public.update_inbound_rule((select id from t_stripe), 'x', null,
       'e1000000-0000-4000-8000-0000000000a1', array['e1000000-0000-4000-8000-000000000a12']::uuid[],
       'move_stage', '{"to_stage_id":"e1000000-0000-4000-8000-000000000a12"}', 'email', 'email', null, 'id', '[]', 'ignore') $$,
  '42501', 'permission denied', 'agente sem developer.manage não edita');
select throws_ok($$ select public.delete_inbound_rule((select id from t_stripe)) $$,
  '42501', 'permission denied', 'agente sem developer.manage não apaga');
select is((select count(*)::int from public.inbound_rules), 0, 'agente sem developer.manage não lê regras (RLS)');

-- Dono do banco: vault, eventos e cascata.
reset role;

select is(
  (select row(r.vault_secret_id, r.active, r.disabled_reason)::text from public.inbound_rules r
    where r.id = 'e1000000-0000-4000-8000-0000000e00b1'),
  row(null::uuid, true, null::text)::text,
  'regra do tenant B intacta (segredo e active iguais aos da fixture)');
select is((select count(*)::int from public.inbound_rules r
            where r.id = (select id from t_stripe) and r.active and r.disabled_reason is null), 1,
  'tentativas do agente C não alteraram a regra do tenant A');
select throws_ok($$ update public.inbound_rules set active = false, disabled_reason = 'qualquer'
       where id = 'e1000000-0000-4000-8000-0000000e00b1' $$,
  '23514', null, 'disabled_reason fora do domínio (manual, daily_limit) recusado');

-- 51-52. Vault: segredo HMAC gravado; rotação manteve o anterior.
select is(
  (select s.decrypted_secret from vault.decrypted_secrets s
     join public.inbound_rules r on r.previous_vault_secret_id = s.id
    where r.id = (select id from t_hmac)),
  (select secret from t_hmac), 'vault guarda o segredo original como anterior após a rotação');
select is(
  (select s.decrypted_secret from vault.decrypted_secrets s
     join public.inbound_rules r on r.vault_secret_id = s.id
    where r.id = (select id from t_hmac)),
  (select secret from t_rot), 'vault guarda o segredo novo como atual');

-- 53. delete pelo RPC apaga os 2 segredos do vault.
create temp table t_vault on commit drop as
  select r.vault_secret_id as cur, r.previous_vault_secret_id as prev
    from public.inbound_rules r where r.id = (select id from t_hmac);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-00000000000a","role":"authenticated"}', false);
set local role authenticated;
select public.delete_inbound_rule((select id from t_hmac));
reset role;
select is((select count(*)::int from vault.secrets s where s.id in (select cur from t_vault union select prev from t_vault)), 0,
  'delete pelo RPC remove os 2 segredos do vault');

-- 54. Cascata: apagar o funil apaga a regra e o segredo dela.
insert into public.inbound_rules (id, tenant_id, name, verification_mode, vault_secret_id, board_id, allowed_stage_ids,
  action, action_config, match_field, match_path, event_id_path)
select 'e1000000-0000-4000-8000-0000000e00a3', tenant_id, 'Regra A3', 'aceleraflow_hmac',
       vault.create_secret('whin_cascata', 'inbound_rule:teste-cascata'),
       'e1000000-0000-4000-8000-0000000000a3', array['e1000000-0000-4000-8000-000000000a31']::uuid[],
       'add_note', '{"text":"nota"}', 'email', 'email', 'id'
  from public.profiles where id = 'e1000000-0000-4000-8000-00000000000a';
delete from public.boards where id = 'e1000000-0000-4000-8000-0000000000a3';
select is((select count(*)::int from vault.secrets where name = 'inbound_rule:teste-cascata'), 0,
  'funil apagado: regra sai em cascata e o segredo sai do vault');

-- 55-57. inbound_events: dedupe e tenant amarrado à regra.
insert into public.inbound_events (tenant_id, rule_id, external_event_id, status)
select r.tenant_id, r.id, 'evt_1', 'processed' from public.inbound_rules r where r.id = (select id from t_stripe);
select throws_ok($$ insert into public.inbound_events (tenant_id, rule_id, external_event_id)
       select r.tenant_id, r.id, 'evt_1' from public.inbound_rules r where r.id = (select id from t_stripe) $$,
  '23505', null, 'mesmo external_event_id na mesma regra recusado');
select throws_ok($$ insert into public.inbound_events (tenant_id, rule_id, external_event_id)
       select r.tenant_id, (select id from t_stripe), 'evt_2' from public.inbound_rules r
        where r.id = 'e1000000-0000-4000-8000-0000000e00b1' $$,
  '23503', null, 'evento com tenant diferente do da regra recusado (fk composta)');
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-00000000000b","role":"authenticated"}', false);
set local role authenticated;
select is((select count(*)::int from public.inbound_rules r where r.id = 'e1000000-0000-4000-8000-0000000e00b1'), 1,
  'controle positivo: admin B vê a própria regra');
select is((select count(*)::int from public.inbound_events), 0, 'admin B não vê eventos do tenant A');

-- 58. Admin A vê o próprio evento.
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-00000000000a","role":"authenticated"}', false);
select is((select count(*)::int from public.inbound_events), 1, 'admin A vê o próprio evento');

select * from finish();
rollback;
