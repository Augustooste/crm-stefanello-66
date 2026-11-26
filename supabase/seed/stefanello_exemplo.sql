-- Carga de exemplo Laticínios Stefanello (etapa 2). Rodar uma única vez, em transação.
DO $$
declare
  t uuid := '55219bbe-7a56-440e-9500-1ae717ac12c2';
  u_viv uuid := '2680a623-8cad-43a0-8a0c-08277e22e071';
  u_sc  uuid := '705066fa-dee1-401c-95ab-6043f9f5a0d9';
  u_jai uuid := '7131f7d2-b02a-48c8-85f9-beaed2155c1d';
  u_kei uuid := '411ada22-2008-401b-88b6-76ed12794604';
  u_ext uuid := '52c79a7a-e9a0-43a8-8b65-da700624fa43';
  b_main uuid; b_pos uuid; r_mau uuid; r_pf uuid; r_serra uuid; r_scl uuid;
  r record; v_c uuid; v_d uuid; v_p uuid; v_path text[]; v_k text; v_i int; v_n int;
  v_start timestamptz; v_entered timestamptz; v_hist record;
begin
  if exists (select 1 from public.boards where tenant_id = t) then raise exception 'Carga já executada'; end if;
  perform set_config('app.deal_stage_transition_context',
    '{"actor_type":"system","reason":"Carga de dados de exemplo","trigger_event":"seed"}', true);

  -- Modelo de funil: troca o funil antigo pelo novo
  update public.niche_templates set stages = '[
    {"name":"Lead novo","position":0,"is_won":false,"is_lost":false},
    {"name":"Em contato","position":1,"is_won":false,"is_lost":false},
    {"name":"Qualificado","position":2,"is_won":false,"is_lost":false},
    {"name":"Proposta / negociação","position":3,"is_won":false,"is_lost":false},
    {"name":"Cadastro e crédito","position":4,"is_won":false,"is_lost":false},
    {"name":"Ganho","position":5,"is_won":true,"is_lost":false},
    {"name":"Perdido","position":6,"is_won":false,"is_lost":true}]'::jsonb
  where slug = 'distribuidora-laticinios';

  insert into public.boards (tenant_id, name, is_default, position, board_key)
    values (t, 'Funil comercial', true, 0, 'main') returning id into b_main;
  insert into public.boards (tenant_id, name, is_default, position, board_key)
    values (t, 'Pós-venda (ativação)', false, 1, 'pos_venda') returning id into b_pos;
  insert into public.board_stages (board_id, name, position, is_won, is_lost, stage_key, sla_days, sla_business_days, max_attempts) values
    (b_main,'Lead novo',0,false,false,'lead_novo',0,false,null),
    (b_main,'Em contato',1,false,false,'em_contato',5,false,3),
    (b_main,'Qualificado',2,false,false,'qualificado',3,false,null),
    (b_main,'Proposta / negociação',3,false,false,'proposta',7,false,null),
    (b_main,'Cadastro e crédito',4,false,false,'cadastro_credito',2,true,null),
    (b_main,'Ganho',5,true,false,'ganho',null,false,null),
    (b_main,'Perdido',6,false,true,'perdido',null,false,null),
    (b_pos,'1ª entrega confirmada',0,false,false,'primeira_entrega',2,false,null),
    (b_pos,'Aguardando 2º pedido',1,false,false,'aguardando_2o_pedido',15,false,null),
    (b_pos,'Cliente ativado',2,true,false,'cliente_ativado',null,false,null),
    (b_pos,'Pediu visita presencial',3,false,false,'visita_presencial',null,false,null);

  insert into public.service_regions (tenant_id, name, uf, external_seller_id) values (t,'Médio e Alto Uruguai','RS',u_ext) returning id into r_mau;
  insert into public.service_regions (tenant_id, name, uf, external_seller_id) values (t,'Passo Fundo e região','RS',u_ext) returning id into r_pf;
  insert into public.service_regions (tenant_id, name, uf, external_seller_id) values (t,'Serra Gaúcha','RS',u_ext) returning id into r_serra;
  insert into public.service_regions (tenant_id, name, uf, external_seller_id) values (t,'Litoral','SC',null) returning id into r_scl;
  insert into public.service_route_cities (tenant_id, uf, city, region_id)
  select t, 'RS', c, r_mau from unnest(array['Frederico Westphalen','Erechim','Três Passos','Palmitinho','Iraí']) c
  union all select t, 'RS', c, r_pf from unnest(array['Passo Fundo','Carazinho','Marau','Soledade']) c
  union all select t, 'RS', c, r_serra from unnest(array['Caxias do Sul','Bento Gonçalves','Farroupilha','Garibaldi']) c
  union all select t, 'SC', c, r_scl from unnest(array['Florianópolis','São José','Balneário Camboriú','Itajaí','Itapema']) c;

  insert into public.uf_routing_rules (tenant_id, uf, owner_id) values (t,'RS',u_viv),(t,'SC',u_sc);
  insert into public.tenant_commercial_settings (tenant_id, finance_profile_id, sales_manager_profile_id, televendas_rs_profile_id, external_seller_rs_profile_id)
    values (t, u_kei, u_jai, u_viv, u_ext);
  insert into public.marketing_spend (tenant_id, month, channel, amount) values
    (t,'2026-09-01','trafego_pago',4500),(t,'2026-10-01','trafego_pago',5200),(t,'2026-11-01','trafego_pago',6000);

  -- name, city, uf, segment, origin, kg, supplier, products, client_origin, alvo, dias atrás (criação), dias na etapa atual
  for r in select * from (values
    ('Pizzaria Bella Massa','Passo Fundo','RS','pizzaria','trafego_pago_site',180,'Laticínios Serra','{mussarela,provolone}','lead_empresa','lead_novo',3,3),
    ('Mercado Bom Preço','Carazinho','RS','mercado','whatsapp_instagram',400,'Distribuidora Sul','{mussarela,requeijão,presunto}','lead_empresa','lead_novo',2,2),
    ('Restaurante Sabor Caseiro','Erechim','RS','restaurante','trafego_pago_site',120,'Atacado Erechim','{mussarela,parmesão}','lead_empresa','lead_novo',1,1),
    ('Hamburgueria Brasa SC','Itajaí','SC','hamburgueria','whatsapp_instagram',150,'Laticínios Vale','{cheddar,mussarela}','lead_empresa','lead_novo',4,4),
    ('Padaria Pão Quente','Marau','RS','padaria','trafego_pago_site',90,'Padaria compra no atacado','{requeijão,mussarela}','lead_empresa','lead_novo',0,0),
    ('Pizzaria Forno a Lenha','Florianópolis','SC','pizzaria','trafego_pago_site',220,'Queijos Ilha','{mussarela,calabresa}','lead_empresa','lead_novo',0,0),
    ('Mercado Central Caxias','Caxias do Sul','RS','mercado','whatsapp_instagram',600,'Distribuidora Serra','{mussarela,presunto,salame}','lead_empresa','em_contato',12,8),
    ('Restaurante Galeto & Cia','Farroupilha','RS','restaurante','eventos_chefs',140,'Fornecedor local','{mussarela,provolone}','lead_empresa','em_contato',10,7),
    ('Pizzaria Napolitana','Bento Gonçalves','RS','pizzaria','trafego_pago_site',260,'Laticínios Serra','{mussarela,gorgonzola}','lead_empresa','em_contato:3',6,3),
    ('Lanchonete do Porto','Balneário Camboriú','SC','hamburgueria','whatsapp_instagram',100,'Atacadão','{cheddar,presunto}','lead_empresa','em_contato',5,2),
    ('Padaria Trigo de Ouro','Garibaldi','RS','padaria','indicacao_prospeccao',80,'Sem fornecedor fixo','{requeijão,mussarela}','prospeccao_propria','em_contato',4,1),
    ('Mercado Família SC','São José','SC','mercado','trafego_pago_site',350,'Distribuidora Litoral','{mussarela,requeijão}','lead_empresa','em_contato',3,1),
    ('Distribuidora Norte Gaúcho','Frederico Westphalen','RS','distribuidor','indicacao_prospeccao',1500,'Laticínio regional','{mussarela,provolone,requeijão}','prospeccao_propria','qualificado',20,5),
    ('Pizzaria Dom Giovanni','Soledade','RS','pizzaria','trafego_pago_site',200,'Laticínios Serra','{mussarela,calabresa}','lead_empresa','qualificado',15,6),
    ('Restaurante Mar Azul','Itapema','SC','restaurante','eventos_chefs',160,'Queijos Ilha','{parmesão,mussarela}','lead_empresa','qualificado',9,2),
    ('Hamburgueria Smash RS','Passo Fundo','RS','hamburgueria','whatsapp_instagram',130,'Atacado Passo Fundo','{cheddar,bacon}','lead_empresa','qualificado',7,1),
    ('Mercado Três Passos','Três Passos','RS','mercado','trafego_pago_site',300,'Distribuidora Sul','{mussarela,salame}','lead_empresa','qualificado',5,1),
    ('Pizzaria Sabor da Serra','Caxias do Sul','RS','pizzaria','trafego_pago_site',300,'Laticínios Serra','{mussarela,provolone}','lead_empresa','proposta',25,10),
    ('Restaurante Fogo de Chão SC','Florianópolis','SC','restaurante','eventos_chefs',250,'Queijos Ilha','{mussarela,parmesão}','lead_empresa','proposta:amostra',18,4),
    ('Padaria Doce Lar','Erechim','RS','padaria','whatsapp_instagram',110,'Atacado Erechim','{requeijão}','lead_empresa','proposta:amostra_ok',16,5),
    ('Mercado Palmitinho','Palmitinho','RS','mercado','indicacao_prospeccao',280,'Laticínio regional','{mussarela,presunto}','prospeccao_propria','proposta',12,3),
    ('Hamburgueria Burger Itajaí','Itajaí','SC','hamburgueria','trafego_pago_site',120,'Laticínios Vale','{cheddar}','lead_empresa','proposta',10,2),
    ('Pizzaria Iraí','Iraí','RS','pizzaria','trafego_pago_site',170,'Laticínio regional','{mussarela}','lead_empresa','cadastro_credito',22,6),
    ('Restaurante Parrilla Marau','Marau','RS','restaurante','whatsapp_instagram',150,'Distribuidora Sul','{provolone,mussarela}','lead_empresa','cadastro_credito',14,1),
    ('Mercado Litoral Norte','Balneário Camboriú','SC','mercado','trafego_pago_site',450,'Distribuidora Litoral','{mussarela,requeijão,presunto}','lead_empresa','cadastro_credito',11,0),
    ('Pizzaria Vila Itália','Passo Fundo','RS','pizzaria','trafego_pago_site',240,'Laticínios Serra','{mussarela,calabresa}','lead_empresa','pos:primeira',40,5),
    ('Restaurante Bom Gosto','Carazinho','RS','restaurante','trafego_pago_site',160,'Atacado Passo Fundo','{mussarela,parmesão}','lead_empresa','pos:primeira_hoje',30,1),
    ('Mercado Garibaldi','Garibaldi','RS','mercado','whatsapp_instagram',380,'Distribuidora Serra','{mussarela,salame}','lead_empresa','pos:aguardando',45,6),
    ('Pizzaria Ilha Bela','São José','SC','pizzaria','trafego_pago_site',210,'Queijos Ilha','{mussarela}','lead_empresa','pos:aguardando',38,4),
    ('Hamburgueria Rústica','Erechim','RS','hamburgueria','trafego_pago_site',140,'Atacado Erechim','{cheddar,mussarela}','lead_empresa','pos:ativado',58,10),
    ('Padaria Real','Caxias do Sul','RS','padaria','eventos_chefs',100,'Fornecedor local','{requeijão,presunto}','lead_empresa','pos:ativado',55,8),
    ('Distribuidora Litoral Food','Itajaí','SC','distribuidor','indicacao_prospeccao',1200,'Laticínios Vale','{mussarela,provolone}','prospeccao_propria','pos:ativado',60,12),
    ('Restaurante Costela Fogo','Frederico Westphalen','RS','restaurante','indicacao_prospeccao',200,'Laticínio regional','{mussarela,provolone}','prospeccao_propria','pos:visita',50,7),
    ('Pizzaria Rapidinha','Farroupilha','RS','pizzaria','trafego_pago_site',150,'Laticínios Serra','{mussarela}','lead_empresa','perdido:sem_contato',50,45),
    ('Mercado Econômico','Soledade','RS','mercado','whatsapp_instagram',320,'Distribuidora Sul','{mussarela,presunto}','lead_empresa','perdido:preco',35,20),
    ('Restaurante Tradição','Florianópolis','SC','restaurante','eventos_chefs',180,'Contrato com Queijos Ilha','{parmesão}','lead_empresa','perdido:ja_tem_fornecedor',30,15),
    ('Lanchonete Esquina','Bento Gonçalves','RS','hamburgueria','trafego_pago_site',90,'Atacadão','{cheddar}','lead_empresa','perdido:credito_reprovado',28,10),
    ('Pizzaria Curitibana','Curitiba','PR','pizzaria','trafego_pago_site',250,'Laticínio PR','{mussarela,calabresa}','lead_empresa','fora',20,20),
    ('Mercado Londrina','Londrina','PR','mercado','trafego_pago_site',500,'Distribuidora PR','{mussarela,requeijão}','lead_empresa','fora',15,15),
    ('Restaurante Cascavel','Cascavel','PR','restaurante','whatsapp_instagram',180,'Laticínio PR','{mussarela}','lead_empresa','fora',8,8),
    ('Hamburgueria Paulista','São Paulo','SP','hamburgueria','trafego_pago_site',300,'Atacado SP','{cheddar,bacon}','lead_empresa','fora',12,12),
    ('Pizzaria Campinas','Campinas','SP','pizzaria','trafego_pago_site',220,'Atacado SP','{mussarela}','lead_empresa','fora',6,6),
    ('Padaria Mineira','Belo Horizonte','MG','padaria','whatsapp_instagram',140,'Laticínio MG','{requeijão}','lead_empresa','fora',4,4),
    ('Mercado Santa Maria','Santa Maria','RS','mercado','trafego_pago_site',350,'Distribuidora Centro','{mussarela,presunto}','lead_empresa','fora_manual',10,6),
    ('Restaurante Chapecó','Chapecó','SC','restaurante','eventos_chefs',200,'Laticínio Oeste','{mussarela,provolone}','lead_empresa','fora_manual',9,5)
  ) as x(name, city, uf, seg, orig, kg, supplier, products, corig, alvo, dias, dias_etapa)
  loop
    v_start := date_trunc('hour', now()) - make_interval(days => r.dias) - interval '2 hours';
    v_entered := case when r.dias_etapa = 0 then now() - interval '1 hour'
                      else date_trunc('hour', now()) - make_interval(days => r.dias_etapa) end;
    insert into public.contacts (tenant_id, name, phone, source, address_city, address_state, lead_origin, segment,
      monthly_volume_kg, current_supplier, products_interest, client_origin, created_at)
    values (t, r.name, '+55549' || lpad((floor(random()*100000000))::text, 8, '0'), r.orig, r.city, r.uf,
      r.orig::public.lead_origin_type, r.seg::public.customer_segment_type, r.kg, r.supplier, r.products::text[],
      r.corig::public.client_origin_type, v_start)
    returning id into v_c;
    insert into public.deals (tenant_id, board_id, stage_id, contact_id, title, value, created_at, stage_entered_at)
    values (t, b_main, private.stef_stage_id(t,'main','lead_novo'), v_c, r.name, r.kg * 32, v_start,
            case when r.alvo = 'lead_novo' or r.alvo like 'fora%' then v_entered else v_start end)
    returning id into v_d;
    update public.contacts set opened_by = coalesce(owner_id, u_viv),
      owner_id = coalesce(owner_id, case when r.alvo like 'fora%' then u_jai end) where id = v_c;
    update public.deals d set owner_id = c.owner_id from public.contacts c where c.id = v_c and d.id = v_d and d.owner_id is null;

    if r.alvo = 'fora_manual' then
      update public.contacts set out_of_area = true, out_of_area_at = v_entered,
        out_of_area_note = 'Cidade sem rota de entrega' where id = v_c;
    elsif r.alvo like 'fora%' then
      update public.contacts set out_of_area_at = v_entered, out_of_area_note = 'UF fora da área (automático)' where id = v_c;
    end if;
    continue when r.alvo = 'lead_novo' or r.alvo like 'fora%';

    v_k := split_part(r.alvo, ':', 1);
    v_path := case
      when v_k = 'em_contato' then array['em_contato']
      when v_k = 'qualificado' then array['em_contato','qualificado']
      when v_k = 'proposta' then array['em_contato','qualificado','proposta']
      when v_k = 'cadastro_credito' then array['em_contato','qualificado','proposta','cadastro_credito']
      when v_k = 'pos' then array['em_contato','qualificado','proposta','cadastro_credito','ganho']
      when v_k = 'perdido' then case split_part(r.alvo, ':', 2) when 'sem_contato' then array['em_contato','perdido']
                                 when 'credito_reprovado' then array['em_contato','qualificado','proposta','cadastro_credito','perdido']
                                 else array['em_contato','qualificado','proposta','perdido'] end
    end;
    foreach v_k in array v_path loop
      if v_k = 'ganho' then
        update public.deals set first_order_at = v_entered, first_order_value = 300 + r.kg * 3,
          first_order_mix = r.products::text[] where id = v_d;
      elsif v_k = 'perdido' then
        update public.deals set lost_reason_code = split_part(r.alvo, ':', 2)::public.lost_reason_code_type where id = v_d;
      end if;
      update public.deals set stage_id = private.stef_stage_id(t, 'main', v_k) where id = v_d;
    end loop;

    -- reescreve datas do histórico (espalhado entre a criação e a entrada na etapa atual)
    v_n := array_length(v_path, 1); v_i := 0;
    for v_hist in select id from public.deal_stage_history where deal_id = v_d order by created_at, id loop
      v_i := v_i + 1;
      update public.deal_stage_history set created_at = case when v_i = v_n then v_entered
        else v_start + (v_entered - v_start) * v_i / v_n end where id = v_hist.id;
    end loop;
    update public.deals d set stage_entered_at = v_entered,
      closed_at = case when d.status <> 'open' then v_entered end,
      nurture_return_at = case when d.lost_reason_code = 'sem_contato' then v_entered + interval '75 days' end,
      stage_due_at = private.stef_compute_due(v_entered, s.sla_days, s.sla_business_days)
    from public.board_stages s where s.id = d.stage_id and d.id = v_d;

    if r.alvo = 'em_contato:3' then update public.deals set contact_attempts = 3 where id = v_d;
    elsif v_k = 'em_contato' then update public.deals set contact_attempts = 1 + (r.dias % 2) where id = v_d;
    elsif r.alvo = 'proposta:amostra' then update public.deals set sample_requested = true, sample_status = 'pendente' where id = v_d;
    elsif r.alvo = 'proposta:amostra_ok' then
      update public.deals set sample_requested = true where id = v_d;
      update public.deals set sample_status = 'aprovada', sample_delivered_at = now() - interval '1 day' where id = v_d;
    end if;

    if v_k = 'perdido' or r.alvo like 'proposta%' or v_k <> 'ganho' then
      if v_k <> 'ganho' then continue; end if;
    end if;

    -- pós-venda
    select id into v_p from public.deals where source_deal_id = v_d;
    update public.deals set created_at = v_entered where id = v_p;
    if r.alvo = 'pos:primeira' then
      update public.deals set first_delivery_at = v_entered + interval '1 day' where id = v_p;
      update public.deals set stage_entered_at = v_entered + interval '1 day',
        stage_due_at = private.stef_compute_due(v_entered + interval '1 day', 2, false) where id = v_p;
    elsif r.alvo = 'pos:primeira_hoje' then
      update public.deals set first_delivery_at = now() - interval '2 hours' where id = v_p;
      update public.deals set stage_entered_at = now() - interval '2 hours',
        stage_due_at = private.stef_compute_due(now() - interval '2 hours', 2, false) where id = v_p;
    elsif r.alvo = 'pos:aguardando' then
      update public.deals set first_delivery_at = v_entered + interval '2 days' where id = v_p;
      update public.deals set stage_id = private.stef_stage_id(t,'pos_venda','aguardando_2o_pedido') where id = v_p;
      update public.deals set stage_entered_at = v_entered + interval '3 days',
        stage_due_at = private.stef_compute_due(v_entered + interval '3 days', 15, false) where id = v_p;
    elsif r.alvo = 'pos:ativado' then
      update public.deals set first_delivery_at = v_entered + interval '2 days' where id = v_p;
      update public.deals set stage_id = private.stef_stage_id(t,'pos_venda','aguardando_2o_pedido') where id = v_p;
      update public.deals set second_order_at = v_entered + interval '20 days', value = value * 1.2 where id = v_p;
      update public.deals set stage_entered_at = v_entered + interval '20 days', closed_at = v_entered + interval '20 days' where id = v_p;
    elsif r.alvo = 'pos:visita' then
      update public.deals set first_delivery_at = v_entered + interval '2 days' where id = v_p;
      update public.deals set stage_id = private.stef_stage_id(t,'pos_venda','visita_presencial') where id = v_p;
      update public.deals set stage_entered_at = now() - interval '2 days' where id = v_p;
      update public.contacts set portfolio_transferred_at = now() - interval '2 days' where id = v_c;
    end if;
    update public.deal_stage_history set created_at = least(created_at,
      (select stage_entered_at from public.deals where id = v_p)) where deal_id = v_p;
  end loop;
end $$;
