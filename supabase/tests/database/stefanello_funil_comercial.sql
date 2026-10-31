-- Funil comercial Stefanello: roteamento RS/SC/PR, fora da área, prazos (mesmo dia 23h59 SP,
-- dias úteis), tarefa Keiti, amostra -> Jaime -> follow-up D+3, perda sem motivo bloqueada,
-- sem_contato -> retorno em 75 dias + rotina, ganho -> pós-venda, visita -> transferência,
-- ativação, mark_out_of_area, demanda por UF e reactivate_region. Rodar: pnpm test:db.
begin;
create extension if not exists pgtap;
select plan(1);
select lives_ok($stef$ do $t$
declare
  r text := '';
  ok_n int := 0; fail_n int := 0;
  ua uuid := 'f5000000-0000-4000-8000-00000000000a';
  uv uuid := 'f5000000-0000-4000-8000-00000000000b';
  us uuid := 'f5000000-0000-4000-8000-00000000000c';
  uj uuid := 'f5000000-0000-4000-8000-00000000000d';
  uk uuid := 'f5000000-0000-4000-8000-00000000000e';
  ue uuid := 'f5000000-0000-4000-8000-00000000000f';
  t uuid; bm uuid; bp uuid; reg uuid;
  s_new uuid; s_ct uuid; s_q uuid; s_pr uuid; s_cc uuid; s_won uuid; s_lost uuid;
  p_ent uuid; p_ag uuid; p_at uuid; p_vis uuid;
  c_rs uuid; c_sc uuid; c_pr uuid; d_rs uuid; d_sc uuid; d_pr uuid; d_pos uuid;
  v_txt text; v_ts timestamptz; v_int int; v_bool boolean; v_uuid uuid;
  procedure_ok boolean;
begin
  -- fixtures
  insert into auth.users (id, email) values (ua,'stef-a@test.local'),(uv,'stef-viv@test.local'),(us,'stef-sc@test.local'),
    (uj,'stef-jaime@test.local'),(uk,'stef-keiti@test.local'),(ue,'stef-ext@test.local');
  insert into public.tenants (name) values ('Stef test') returning id into t;
  insert into public.profiles (id, tenant_id, name, role) select u, t, 'P', 'admin' from unnest(array[ua,uv,us,uj,uk,ue]) u
    on conflict (id) do nothing;
  if exists (select 1 from public.profiles where id = ua and tenant_id <> t) then
    select tenant_id into t from public.profiles where id = ua;
  end if;
  insert into public.boards (tenant_id, name, board_key) values (t,'Funil principal','main') returning id into bm;
  insert into public.boards (tenant_id, name, board_key) values (t,'Pós-venda','pos_venda') returning id into bp;
  insert into public.board_stages (board_id,name,position,stage_key,sla_days,sla_business_days,max_attempts,is_won,is_lost) values
    (bm,'Lead novo',0,'lead_novo',0,false,null,false,false) returning id into s_new;
  insert into public.board_stages (board_id,name,position,stage_key,sla_days,max_attempts) values (bm,'Em contato',1,'em_contato',5,3) returning id into s_ct;
  insert into public.board_stages (board_id,name,position,stage_key,sla_days) values (bm,'Qualificado',2,'qualificado',3) returning id into s_q;
  insert into public.board_stages (board_id,name,position,stage_key,sla_days) values (bm,'Proposta',3,'proposta',7) returning id into s_pr;
  insert into public.board_stages (board_id,name,position,stage_key,sla_days,sla_business_days) values (bm,'Cadastro e crédito',4,'cadastro_credito',2,true) returning id into s_cc;
  insert into public.board_stages (board_id,name,position,stage_key,is_won) values (bm,'Ganho',5,'ganho',true) returning id into s_won;
  insert into public.board_stages (board_id,name,position,stage_key,is_lost) values (bm,'Perdido',6,'perdido',true) returning id into s_lost;
  insert into public.board_stages (board_id,name,position,stage_key,sla_days) values (bp,'1ª entrega',0,'primeira_entrega',2) returning id into p_ent;
  insert into public.board_stages (board_id,name,position,stage_key,sla_days) values (bp,'Aguardando 2º pedido',1,'aguardando_2o_pedido',15) returning id into p_ag;
  insert into public.board_stages (board_id,name,position,stage_key,is_won) values (bp,'Cliente ativado',2,'cliente_ativado',true) returning id into p_at;
  insert into public.board_stages (board_id,name,position,stage_key) values (bp,'Pediu visita',3,'visita_presencial') returning id into p_vis;
  insert into public.uf_routing_rules (tenant_id,uf,owner_id) values (t,'RS',uv),(t,'SC',us);
  insert into public.tenant_commercial_settings values (t, uk, uj, uv, null);
  insert into public.service_regions (tenant_id,name,uf,external_seller_id) values (t,'Serra','RS',ue) returning id into reg;
  insert into public.service_route_cities (tenant_id,uf,city,region_id) values (t,'RS','Caxias do Sul',reg);

  insert into public.contacts (tenant_id,name,address_city,address_state,monthly_volume_kg) values (t,'Pizzaria RS','CAXIAS DO SUL','RS',100) returning id into c_rs;
  insert into public.contacts (tenant_id,name,address_city,address_state) values (t,'Mercado SC','Joinville','SC') returning id into c_sc;
  insert into public.contacts (tenant_id,name,address_city,address_state,monthly_volume_kg) values (t,'Padaria PR','Curitiba','PR',250) returning id into c_pr;
  insert into public.deals (tenant_id,board_id,stage_id,contact_id,title) values (t,bm,s_new,c_rs,'RS') returning id into d_rs;
  insert into public.deals (tenant_id,board_id,stage_id,contact_id,title) values (t,bm,s_new,c_sc,'SC') returning id into d_sc;
  insert into public.deals (tenant_id,board_id,stage_id,contact_id,title) values (t,bm,s_new,c_pr,'PR') returning id into d_pr;

  -- 1-4 roteamento
  select owner_id into v_uuid from public.deals where id = d_rs;
  if v_uuid = uv then ok_n:=ok_n+1; else fail_n:=fail_n+1; r:=r||'FAIL RS->Viviane; '; end if;
  select owner_id into v_uuid from public.contacts where id = c_sc;
  if v_uuid = us then ok_n:=ok_n+1; else fail_n:=fail_n+1; r:=r||'FAIL SC->Rep; '; end if;
  select out_of_area into v_bool from public.contacts where id = c_pr;
  if v_bool then ok_n:=ok_n+1; else fail_n:=fail_n+1; r:=r||'FAIL PR fora da area; '; end if;
  select region_id into v_uuid from public.contacts where id = c_rs;
  if v_uuid = reg then ok_n:=ok_n+1; else fail_n:=fail_n+1; r:=r||'FAIL regiao por cidade sem acento; '; end if;
  select (select count(*) from public.deal_sla_status where deal_id = d_pr) into v_int;
  if v_int = 0 then ok_n:=ok_n+1; else fail_n:=fail_n+1; r:=r||'FAIL fora da area no funil ativo; '; end if;

  -- 5 prazo mesmo dia 23h59 SP
  select stage_due_at into v_ts from public.deals where id = d_rs;
  if v_ts = ((now() at time zone 'America/Sao_Paulo')::date + time '23:59:59') at time zone 'America/Sao_Paulo' then ok_n:=ok_n+1; else fail_n:=fail_n+1; r:=r||'FAIL prazo mesmo dia; '; end if;
  -- 6-7 dias uteis e corridos
  if private.stef_compute_due('2026-10-30 12:00-03', 2, true) = '2026-11-03 12:00-03'::timestamptz then ok_n:=ok_n+1; else fail_n:=fail_n+1; r:=r||'FAIL dias uteis sex->ter; '; end if;
  if private.stef_compute_due('2026-10-30 12:00-03', 3, false) = '2026-11-02 12:00-03'::timestamptz then ok_n:=ok_n+1; else fail_n:=fail_n+1; r:=r||'FAIL dias corridos; '; end if;

  -- 8 tentativas
  perform private.stef_move_deal(d_rs, s_ct, 't');
  update public.deals set contact_attempts = 3 where id = d_rs;
  select count(*) into v_int from public.activities where deal_id = d_rs and metadata->>'kind' = 'attempts_limit';
  if v_int = 1 then ok_n:=ok_n+1; else fail_n:=fail_n+1; r:=r||'FAIL tarefa 3 tentativas; '; end if;

  -- 9-10 amostra
  perform private.stef_move_deal(d_rs, s_pr, 't');
  update public.deals set sample_requested = true where id = d_rs;
  select owner_id into v_uuid from public.activities where deal_id = d_rs and metadata->>'kind' = 'sample_approval';
  if v_uuid = uj then ok_n:=ok_n+1; else fail_n:=fail_n+1; r:=r||'FAIL tarefa Jaime; '; end if;
  update public.deals set sample_status = 'aprovada', sample_delivered_at = '2026-11-02 10:00-03' where id = d_rs;
  select scheduled_at into v_ts from public.deal_followups where deal_id = d_rs and description like '[sample_followup]%';
  if v_ts = '2026-11-05 10:00-03'::timestamptz then ok_n:=ok_n+1; else fail_n:=fail_n+1; r:=r||'FAIL followup D+3; '; end if;

  -- 11 cadastro e credito
  perform private.stef_move_deal(d_rs, s_cc, 't');
  select owner_id, due_at into v_uuid, v_ts from public.activities where deal_id = d_rs and metadata->>'kind' = 'credit_review';
  if v_uuid = uk and v_ts = private.stef_compute_due(now(), 2, true) and v_ts > now() + interval '47 hours' then ok_n:=ok_n+1; else fail_n:=fail_n+1; r:=r||'FAIL tarefa Keiti; '; end if;

  -- 12 ganho exige 1º pedido
  procedure_ok := false;
  begin perform private.stef_move_deal(d_rs, s_won, 't'); exception when check_violation then procedure_ok := true; end;
  if procedure_ok then ok_n:=ok_n+1; else fail_n:=fail_n+1; r:=r||'FAIL ganho sem 1o pedido; '; end if;
  -- 13-14 ganho -> pos-venda + carteira
  update public.deals set first_order_at = now() - interval '2 days', first_order_value = 850, first_order_mix = '{mussarela,requeijao}' where id = d_rs;
  perform private.stef_move_deal(d_rs, s_won, 't');
  select id into d_pos from public.deals where source_deal_id = d_rs and stage_id = p_ent;
  if d_pos is not null then ok_n:=ok_n+1; else fail_n:=fail_n+1; r:=r||'FAIL card pos-venda; '; end if;
  select portfolio_owner_id into v_uuid from public.contacts where id = c_rs;
  if v_uuid = uv then ok_n:=ok_n+1; else fail_n:=fail_n+1; r:=r||'FAIL carteira Viviane; '; end if;

  -- 15 entrega D+2
  update public.deals set first_delivery_at = '2026-11-02 09:00-03' where id = d_pos;
  select scheduled_at into v_ts from public.deal_followups where deal_id = d_pos and description like '[delivery_d2]%';
  if v_ts = '2026-11-04 09:00-03'::timestamptz then ok_n:=ok_n+1; else fail_n:=fail_n+1; r:=r||'FAIL followup D+2; '; end if;

  -- 16 visita presencial
  perform private.stef_move_deal(d_pos, p_vis, 't');
  select (portfolio_owner_id = ue and follow_up_owner_id = uv and portfolio_transferred_at is not null) into v_bool from public.contacts where id = c_rs;
  if v_bool then ok_n:=ok_n+1; else fail_n:=fail_n+1; r:=r||'FAIL transferencia visita; '; end if;

  -- 17 ativacao
  perform private.stef_move_deal(d_pos, p_ag, 't');
  update public.deals set second_order_at = now() where id = d_pos;
  select stage_id into v_uuid from public.deals where id = d_pos;
  if v_uuid = p_at then ok_n:=ok_n+1; else fail_n:=fail_n+1; r:=r||'FAIL cliente ativado; '; end if;

  -- 18 perda sem motivo bloqueada
  procedure_ok := false;
  begin perform private.stef_move_deal(d_sc, s_lost, 't'); exception when check_violation then procedure_ok := true; end;
  if procedure_ok then ok_n:=ok_n+1; else fail_n:=fail_n+1; r:=r||'FAIL perda sem motivo; '; end if;
  -- 19 sem_contato -> 75 dias
  update public.deals set lost_reason_code = 'sem_contato' where id = d_sc;
  perform private.stef_move_deal(d_sc, s_lost, 't');
  select nurture_return_at into v_ts from public.deals where id = d_sc;
  if abs(extract(epoch from v_ts - (now() + interval '75 days'))) < 5 then ok_n:=ok_n+1; else fail_n:=fail_n+1; r:=r||'FAIL retorno 75 dias; '; end if;
  -- 20 rotina de retorno
  update public.deals set nurture_return_at = now() - interval '1 minute' where id = d_sc;
  v_int := public.process_nurture_returns();
  select (stage_id = s_new and status = 'open' and lost_reason_code is null) into v_bool from public.deals where id = d_sc;
  if v_int >= 1 and v_bool and exists (select 1 from public.contacts where id = c_sc and 'Retorno nutrição' = any(tags))
     and exists (select 1 from public.activities where deal_id = d_sc and metadata->>'kind' = 'nurture_return' and owner_id = us)
  then ok_n:=ok_n+1; else fail_n:=fail_n+1; r:=r||'FAIL retorno nutricao; '; end if;

  -- 21 fora da area manual
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  perform public.mark_out_of_area(d_sc, 'cidade sem rota');
  select (out_of_area and out_of_area_note = 'cidade sem rota') into v_bool from public.contacts where id = c_sc;
  if v_bool then ok_n:=ok_n+1; else fail_n:=fail_n+1; r:=r||'FAIL mark_out_of_area; '; end if;
  -- 22 demanda por UF
  select kg_month into v_int from public.v_stef_out_of_area_demand where tenant_id = t and group_level = 'uf' and uf = 'PR';
  if v_int = 250 then ok_n:=ok_n+1; else fail_n:=fail_n+1; r:=r||'FAIL demanda por UF; '; end if;
  -- 23 reativar regiao
  v_int := public.reactivate_region(null, array['CURITIBA'], ua);
  select (not c.out_of_area and c.owner_id = ua and d.owner_id = ua and d.stage_id = s_new) into v_bool
  from public.contacts c join public.deals d on d.contact_id = c.id where c.id = c_pr;
  if v_int = 1 and v_bool then ok_n:=ok_n+1; else fail_n:=fail_n+1; r:=r||'FAIL reactivate_region; '; end if;

  raise notice 'RESULTADO: % ok, % falhas', ok_n, fail_n;
  if fail_n > 0 then raise exception 'Falhas: %', r; end if;
end
 $t$ $stef$, 'regras do funil Stefanello (24 verificações)');
select * from finish();
rollback;
