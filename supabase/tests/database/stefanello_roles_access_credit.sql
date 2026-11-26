-- Papéis comerciais: escopo real por RLS, criação própria, crédito e Ganho.
begin;
create extension if not exists pgtap;
select plan(27);

set session_replication_role = replica;
do $fixture$
declare
  t uuid := 'f6000000-0000-4000-8000-000000000001';
  ua uuid := 'f6000000-0000-4000-8000-00000000000a';
  uv uuid := 'f6000000-0000-4000-8000-00000000000b';
  us uuid := 'f6000000-0000-4000-8000-00000000000c';
  uj uuid := 'f6000000-0000-4000-8000-00000000000d';
  uk uuid := 'f6000000-0000-4000-8000-00000000000e';
  ue uuid := 'f6000000-0000-4000-8000-00000000000f';
  bm uuid := 'f6000000-0000-4000-8000-000000000100';
  bp uuid := 'f6000000-0000-4000-8000-000000000101';
  s_new uuid := 'f6000000-0000-4000-8000-000000000110';
  s_credit uuid := 'f6000000-0000-4000-8000-000000000111';
  s_won uuid := 'f6000000-0000-4000-8000-000000000112';
  p_visit uuid := 'f6000000-0000-4000-8000-000000000113';
  r_admin uuid; r_manager uuid; r_finance uuid; r_agent uuid; v_channel uuid;
begin
  perform set_config('roles.tenant', t::text, false);
  perform set_config('roles.admin', ua::text, false);
  perform set_config('roles.viviane', uv::text, false);
  perform set_config('roles.junior', us::text, false);
  perform set_config('roles.jaime', uj::text, false);
  perform set_config('roles.keiti', uk::text, false);
  perform set_config('roles.externo', ue::text, false);
  perform set_config('roles.board', bm::text, false);
  perform set_config('roles.new', s_new::text, false);
  perform set_config('roles.credit_stage', s_credit::text, false);
  perform set_config('roles.won', s_won::text, false);
  perform set_config('roles.contact_viviane', 'f6000000-0000-4000-8000-000000000200', false);
  perform set_config('roles.contact_junior', 'f6000000-0000-4000-8000-000000000201', false);
  perform set_config('roles.contact_unassigned', 'f6000000-0000-4000-8000-000000000202', false);
  perform set_config('roles.contact_transfer', 'f6000000-0000-4000-8000-000000000203', false);
  perform set_config('roles.contact_credit', 'f6000000-0000-4000-8000-000000000204', false);
  perform set_config('roles.contact_win', 'f6000000-0000-4000-8000-000000000205', false);
  perform set_config('roles.deal_viviane', 'f6000000-0000-4000-8000-000000000300', false);
  perform set_config('roles.deal_junior', 'f6000000-0000-4000-8000-000000000301', false);
  perform set_config('roles.deal_unassigned', 'f6000000-0000-4000-8000-000000000302', false);
  perform set_config('roles.deal_transfer', 'f6000000-0000-4000-8000-000000000303', false);
  perform set_config('roles.deal_credit', 'f6000000-0000-4000-8000-000000000304', false);
  perform set_config('roles.deal_win', 'f6000000-0000-4000-8000-000000000305', false);

  insert into auth.users(id,email) values
    (ua,'roles-admin@test.local'),(uv,'roles-viviane@test.local'),(us,'roles-junior@test.local'),
    (uj,'roles-jaime@test.local'),(uk,'roles-keiti@test.local'),(ue,'roles-externo@test.local');
  insert into public.tenants(id,name) values(t,'Roles Stefanello');
  insert into public.permissions(permission_key,description) values
    ('tenant.settings.manage','Configurações'),('analytics.read','Relatórios'),
    ('crm.contacts.read','Ler contatos'),('crm.contacts.write','Editar contatos'),
    ('crm.pipeline.read','Ler funil'),('crm.pipeline.write','Editar funil'),
    ('crm.deals.credit.write','Editar crédito')
  on conflict(permission_key) do nothing;
  insert into public.roles(tenant_id,role_key,name,is_system) values
    (t,'admin','Administrador',true),(t,'manager','Gestor',true),
    (t,'finance','Financeiro',true),(t,'agent','Vendedor',true)
  returning id into r_admin;
  select id into r_admin from public.roles where tenant_id=t and role_key='admin';
  select id into r_manager from public.roles where tenant_id=t and role_key='manager';
  select id into r_finance from public.roles where tenant_id=t and role_key='finance';
  select id into r_agent from public.roles where tenant_id=t and role_key='agent';
  insert into public.role_permissions(role_id,permission_id)
    select r_admin,id from public.permissions;
  insert into public.role_permissions(role_id,permission_id)
    select r_manager,id from public.permissions where permission_key in
      ('analytics.read','crm.contacts.read','crm.contacts.write','crm.pipeline.read','crm.pipeline.write','crm.deals.credit.write');
  insert into public.role_permissions(role_id,permission_id)
    select r_finance,id from public.permissions where permission_key in
      ('crm.contacts.read','crm.pipeline.read','crm.deals.credit.write');
  insert into public.role_permissions(role_id,permission_id)
    select r_agent,id from public.permissions where permission_key in
      ('crm.contacts.read','crm.contacts.write','crm.pipeline.read','crm.pipeline.write');
  insert into public.profiles(id,tenant_id,name,role) values
    (ua,t,'Admin','admin'),(uv,t,'Viviane','agent'),(us,t,'Júnior','agent'),
    (uj,t,'Jaime','manager'),(uk,t,'Keiti','finance'),(ue,t,'Externo','agent');
  insert into public.tenant_memberships(tenant_id,user_id,role_id,status) values
    (t,ua,r_admin,'active'),(t,uv,r_agent,'active'),(t,us,r_agent,'active'),
    (t,uj,r_manager,'active'),(t,uk,r_finance,'active'),(t,ue,r_agent,'active');
  insert into public.contact_statuses(tenant_id,slug,label,color,sort_order)
    values(t,'lead','Lead','#64748b',1);
  insert into public.boards(id,tenant_id,name,board_key) values
    (bm,t,'Funil','main'),(bp,t,'Pós-venda','pos_venda');
  insert into public.board_stages(id,board_id,name,position,stage_key,is_won) values
    (s_new,bm,'Lead novo',0,'lead_novo',false),
    (s_credit,bm,'Cadastro e crédito',1,'cadastro_credito',false),
    (s_won,bm,'Ganho',2,'ganho',true),
    (p_visit,bp,'Pediu visita',0,'visita_presencial',false);
  insert into public.uf_routing_rules(tenant_id,uf,owner_id) values(t,'RS',us);
  insert into public.tenant_commercial_settings(tenant_id,finance_profile_id,sales_manager_profile_id,televendas_rs_profile_id)
    values(t,uk,uj,uv);

  insert into public.contacts(id,tenant_id,name,owner_id,portfolio_owner_id,follow_up_owner_id) values
    ('f6000000-0000-4000-8000-000000000200',t,'Viviane',uv,null,null),
    ('f6000000-0000-4000-8000-000000000201',t,'Júnior',us,null,null),
    ('f6000000-0000-4000-8000-000000000202',t,'Sem responsável',null,null,null),
    ('f6000000-0000-4000-8000-000000000203',t,'Transferido',ue,ue,uv),
    ('f6000000-0000-4000-8000-000000000204',t,'Crédito',uv,null,null),
    ('f6000000-0000-4000-8000-000000000205',t,'Ganho',uv,null,null);
  insert into public.deals(id,tenant_id,board_id,stage_id,contact_id,title,owner_id,first_order_at) values
    ('f6000000-0000-4000-8000-000000000300',t,bm,s_new,'f6000000-0000-4000-8000-000000000200','Viviane',uv,null),
    ('f6000000-0000-4000-8000-000000000301',t,bm,s_new,'f6000000-0000-4000-8000-000000000201','Júnior',us,null),
    ('f6000000-0000-4000-8000-000000000302',t,bm,s_new,'f6000000-0000-4000-8000-000000000202','Sem responsável',null,null),
    ('f6000000-0000-4000-8000-000000000303',t,bp,p_visit,'f6000000-0000-4000-8000-000000000203','Transferido',ue,null),
    ('f6000000-0000-4000-8000-000000000304',t,bm,s_credit,'f6000000-0000-4000-8000-000000000204','Crédito',uv,null),
    ('f6000000-0000-4000-8000-000000000305',t,bm,s_credit,'f6000000-0000-4000-8000-000000000205','Ganho',uv,now());
  insert into public.channels(tenant_id,type,provider_slug) values(t,'simulator','simulator') returning id into v_channel;
  insert into public.conversations(id,tenant_id,channel_id,contact_id) values
    ('f6000000-0000-4000-8000-000000000400',t,v_channel,'f6000000-0000-4000-8000-000000000201'),
    ('f6000000-0000-4000-8000-000000000401',t,v_channel,'f6000000-0000-4000-8000-000000000203');
  insert into public.messages(tenant_id,conversation_id,direction,sender,content) values
    (t,'f6000000-0000-4000-8000-000000000400','in','contact','Júnior'),
    (t,'f6000000-0000-4000-8000-000000000401','in','contact','Transferido');
  insert into public.activities(tenant_id,title,type,owner_id,deal_id,metadata) values
    (t,'Atribuída','call',uv,null,'{}'),
    (t,'Ligada ao negócio','call',us,'f6000000-0000-4000-8000-000000000300','{}'),
    (t,'Outra','call',us,null,'{}'),
    (t,'Avaliar crédito','task',uk,'f6000000-0000-4000-8000-000000000304','{"kind":"credit_review"}');
end $fixture$;
set session_replication_role = default;

create or replace function pg_temp.assume(p_user text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object(
    'sub', current_setting('roles.' || p_user), 'role', 'authenticated',
    'app_metadata', json_build_object('active_tenant_id', current_setting('roles.tenant'))
  )::text, true)::void;
$$;
set role authenticated;

-- 1–3: Gestor vê tudo, tem Relatórios e não tem Configurações.
select pg_temp.assume('jaime');
select is((select count(*)::int from public.contacts),6,'Jaime, como Gestor, vê todos os contatos');
select is('tenant.settings.manage' = any(public.get_my_permissions()),false,'Gestor não tem permissão de Configurações');
select is('analytics.read' = any(public.get_my_permissions()),true,'Gestor tem permissão de Relatórios');
select pg_temp.assume('admin');
select is('tenant.settings.manage' = any(public.get_my_permissions()),true,'Administrador mantém Configurações');

-- 5–12: Viviane vê sua carteira e acompanhamento, nunca a do Júnior ou sem dono.
select pg_temp.assume('viviane');
select is((select count(*)::int from public.contacts),4,'Viviane vê somente próprios contatos e acompanhamento');
select is((select count(*)::int from public.contacts where id='f6000000-0000-4000-8000-000000000201'),0,'Viviane não vê contato do Júnior');
select is((select count(*)::int from public.contacts where id='f6000000-0000-4000-8000-000000000202'),0,'Lead sem responsável é invisível para Vendedor');
select is((select count(*)::int from public.contacts where id='f6000000-0000-4000-8000-000000000203'),1,'Após visita presencial Viviane continua vendo o transferido');
select is((select count(*)::int from public.deals),4,'Viviane vê somente negócios próprios e acompanhados');
select is((select count(*)::int from public.conversations where id='f6000000-0000-4000-8000-000000000401'),1,'Vendedor lê conversa do contato acompanhado');
select is((select count(*)::int from public.conversations where id='f6000000-0000-4000-8000-000000000400'),0,'Vendedor não lê conversa do contato do Júnior');
select is((select count(*)::int from public.activities),3,'Atividades visíveis: atribuídas ou ligadas aos negócios visíveis');

-- 13–16: criação própria não é roteada por UF; fora da área continua automático.
select lives_ok($q$insert into public.contacts(id,tenant_id,name,address_state,owner_id,opened_by,client_origin)
  values('f6000000-0000-4000-8000-000000000206','f6000000-0000-4000-8000-000000000001','Próprio RS','RS',
  'f6000000-0000-4000-8000-00000000000c','f6000000-0000-4000-8000-00000000000c','lead_empresa')$q$,'Vendedor cria lead do RS');
select is((select owner_id='f6000000-0000-4000-8000-00000000000b' and opened_by='f6000000-0000-4000-8000-00000000000b'
  and client_origin='prospeccao_propria' from public.contacts where id='f6000000-0000-4000-8000-000000000206'),true,
  'Lead criado pelo Vendedor fica com o criador e não é roteado ao Júnior');
select lives_ok($q$insert into public.contacts(id,tenant_id,name,address_state)
  values('f6000000-0000-4000-8000-000000000207','f6000000-0000-4000-8000-000000000001','Próprio PR','PR')$q$,
  'Vendedor cria lead de outra UF');
select is((select out_of_area from public.contacts where id='f6000000-0000-4000-8000-000000000207'),true,
  'Fora da área automático continua valendo para criação própria');

-- 17–18: Gestor criando lead usa roteamento normal.
select pg_temp.assume('jaime');
select lives_ok($q$insert into public.contacts(id,tenant_id,name,address_state)
  values('f6000000-0000-4000-8000-000000000208','f6000000-0000-4000-8000-000000000001','Lead gestor','RS')$q$,
  'Gestor cria lead');
select is((select owner_id='f6000000-0000-4000-8000-00000000000c' and client_origin='lead_empresa'
  from public.contacts where id='f6000000-0000-4000-8000-000000000208'),true,'Lead do Gestor segue roteamento por UF');

-- 19–24: Financeiro vê recorte e só grava crédito.
select pg_temp.assume('keiti');
select is((select count(*)::int from public.deals),3,'Financeiro vê Cadastro e crédito/Ganho e o card de pós-venda');
select throws_ok($q$update public.deals set owner_id='f6000000-0000-4000-8000-00000000000c'
  where id='f6000000-0000-4000-8000-000000000304'$q$,'Financeiro não altera responsável');
select throws_ok($q$update public.deals set stage_id='f6000000-0000-4000-8000-000000000112'
  where id='f6000000-0000-4000-8000-000000000304'$q$,'Financeiro não move etapa');
select throws_ok($q$update public.deals set status='lost',lost_reason_code='preco'
  where id='f6000000-0000-4000-8000-000000000304'$q$,'Financeiro não marca perdido');
select lives_ok($q$update public.deals set credit_condition='credito_aprovado',credit_limit=12000,
  payment_terms_days='{7,14,21}',credit_notes='Cliente aprovado'
  where id='f6000000-0000-4000-8000-000000000304'$q$,'Financeiro grava os campos de crédito');
select is((select credit_evaluated_by='f6000000-0000-4000-8000-00000000000e'
  and exists(select 1 from public.activities where deal_id='f6000000-0000-4000-8000-000000000304'
    and metadata->>'kind'='credit_review' and completed_at is not null)
  and exists(select 1 from public.activities where deal_id='f6000000-0000-4000-8000-000000000304'
    and metadata->>'kind'='credit_evaluated' and owner_id='f6000000-0000-4000-8000-00000000000b')
  from public.deals where id='f6000000-0000-4000-8000-000000000304'),true,
  'Crédito registra avaliador, conclui tarefa da Keiti e avisa o responsável');

-- 25: Ganho sem crédito continua bloqueado mesmo com 1º pedido.
select pg_temp.assume('viviane');
select throws_ok($q$select private.stef_move_deal('f6000000-0000-4000-8000-000000000305',
  'f6000000-0000-4000-8000-000000000112','teste ganho sem crédito')$q$,'23514',null,
  'Ganho sem condição de crédito é bloqueado');

-- 26–27: negócio criado pelo Vendedor também fica com ele.
select lives_ok($q$insert into public.deals(id,tenant_id,board_id,stage_id,contact_id,title,owner_id) values
  ('f6000000-0000-4000-8000-000000000306','f6000000-0000-4000-8000-000000000001',
  'f6000000-0000-4000-8000-000000000100','f6000000-0000-4000-8000-000000000110',
  'f6000000-0000-4000-8000-000000000200','Negócio próprio','f6000000-0000-4000-8000-00000000000c')$q$,
  'Vendedor cria negócio na própria carteira');
select is((select owner_id from public.deals where id='f6000000-0000-4000-8000-000000000306'),
  'f6000000-0000-4000-8000-00000000000b','Negócio criado pelo Vendedor não muda de responsável');

reset role;
select * from finish();
rollback;
