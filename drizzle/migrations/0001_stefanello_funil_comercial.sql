-- Funil comercial Laticínios Stefanello — etapa 1: schema, regras e views.

CREATE TYPE public.lead_origin_type AS ENUM ('trafego_pago_site','whatsapp_instagram','indicacao_prospeccao','eventos_chefs');
CREATE TYPE public.customer_segment_type AS ENUM ('pizzaria','restaurante','hamburgueria','mercado','padaria','distribuidor','outro');
CREATE TYPE public.lost_reason_code_type AS ENUM ('sem_contato','preco','ja_tem_fornecedor','pedido_minimo','amostra_nao_aprovada','credito_reprovado','sem_perfil','duplicado_invalido');
CREATE TYPE public.client_origin_type AS ENUM ('lead_empresa','prospeccao_propria');
CREATE TYPE public.sample_status_type AS ENUM ('pendente','aprovada','reprovada');

CREATE OR REPLACE FUNCTION private.stef_norm(p text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  select nullif(btrim(regexp_replace(lower(translate(coalesce(p,''),
    'ÁÀÂÃÄáàâãäÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖóòôõöÚÙÛÜúùûüÇçÑñ',
    'AAAAAaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCcNn')), '\s+', ' ', 'g')), '')
$$;

CREATE TABLE public.service_regions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  uf text NOT NULL CHECK (uf ~ '^[A-Z]{2}$'),
  external_seller_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, uf, name)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.service_regions TO authenticated;
GRANT ALL ON public.service_regions TO service_role;
ALTER TABLE public.service_regions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_regions tenant select" ON public.service_regions FOR SELECT TO authenticated
  USING (tenant_id = (SELECT private.get_user_tenant_id()));
CREATE POLICY "service_regions admin write" ON public.service_regions FOR ALL TO authenticated
  USING ((SELECT private.is_admin()) AND tenant_id = (SELECT private.get_user_tenant_id()))
  WITH CHECK ((SELECT private.is_admin()) AND tenant_id = (SELECT private.get_user_tenant_id()));

CREATE TABLE public.service_route_cities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  uf text NOT NULL CHECK (uf IN ('RS','SC')),
  city text NOT NULL,
  city_norm text GENERATED ALWAYS AS (private.stef_norm(city)) STORED,
  region_id uuid REFERENCES public.service_regions(id) ON DELETE SET NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, uf, city_norm)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.service_route_cities TO authenticated;
GRANT ALL ON public.service_route_cities TO service_role;
ALTER TABLE public.service_route_cities ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_route_cities tenant select" ON public.service_route_cities FOR SELECT TO authenticated
  USING (tenant_id = (SELECT private.get_user_tenant_id()));
CREATE POLICY "service_route_cities admin write" ON public.service_route_cities FOR ALL TO authenticated
  USING ((SELECT private.is_admin()) AND tenant_id = (SELECT private.get_user_tenant_id()))
  WITH CHECK ((SELECT private.is_admin()) AND tenant_id = (SELECT private.get_user_tenant_id()));

CREATE TABLE public.uf_routing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  uf text NOT NULL CHECK (uf ~ '^[A-Z]{2}$'),
  owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, uf)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.uf_routing_rules TO authenticated;
GRANT ALL ON public.uf_routing_rules TO service_role;
ALTER TABLE public.uf_routing_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "uf_routing_rules tenant select" ON public.uf_routing_rules FOR SELECT TO authenticated
  USING (tenant_id = (SELECT private.get_user_tenant_id()));
CREATE POLICY "uf_routing_rules admin write" ON public.uf_routing_rules FOR ALL TO authenticated
  USING ((SELECT private.is_admin()) AND tenant_id = (SELECT private.get_user_tenant_id()))
  WITH CHECK ((SELECT private.is_admin()) AND tenant_id = (SELECT private.get_user_tenant_id()));

CREATE TABLE public.tenant_commercial_settings (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  finance_profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  sales_manager_profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  televendas_rs_profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  external_seller_rs_profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_commercial_settings TO authenticated;
GRANT ALL ON public.tenant_commercial_settings TO service_role;
ALTER TABLE public.tenant_commercial_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_commercial_settings tenant select" ON public.tenant_commercial_settings FOR SELECT TO authenticated
  USING (tenant_id = (SELECT private.get_user_tenant_id()));
CREATE POLICY "tenant_commercial_settings admin write" ON public.tenant_commercial_settings FOR ALL TO authenticated
  USING ((SELECT private.is_admin()) AND tenant_id = (SELECT private.get_user_tenant_id()))
  WITH CHECK ((SELECT private.is_admin()) AND tenant_id = (SELECT private.get_user_tenant_id()));

CREATE TABLE public.marketing_spend (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  month date NOT NULL CHECK (month = date_trunc('month', month)::date),
  channel text NOT NULL DEFAULT 'trafego_pago',
  amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, month, channel)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.marketing_spend TO authenticated;
GRANT ALL ON public.marketing_spend TO service_role;
ALTER TABLE public.marketing_spend ENABLE ROW LEVEL SECURITY;
CREATE POLICY "marketing_spend tenant select" ON public.marketing_spend FOR SELECT TO authenticated
  USING (tenant_id = (SELECT private.get_user_tenant_id()));
CREATE POLICY "marketing_spend admin write" ON public.marketing_spend FOR ALL TO authenticated
  USING ((SELECT private.is_admin()) AND tenant_id = (SELECT private.get_user_tenant_id()))
  WITH CHECK ((SELECT private.is_admin()) AND tenant_id = (SELECT private.get_user_tenant_id()));

CREATE TRIGGER service_regions_set_updated_at BEFORE UPDATE ON public.service_regions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER service_route_cities_set_updated_at BEFORE UPDATE ON public.service_route_cities FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER uf_routing_rules_set_updated_at BEFORE UPDATE ON public.uf_routing_rules FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER tenant_commercial_settings_set_updated_at BEFORE UPDATE ON public.tenant_commercial_settings FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER marketing_spend_set_updated_at BEFORE UPDATE ON public.marketing_spend FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.boards ADD COLUMN board_key text CHECK (board_key IN ('main','pos_venda'));
CREATE UNIQUE INDEX boards_tenant_board_key_uniq ON public.boards (tenant_id, board_key) WHERE board_key IS NOT NULL;

ALTER TABLE public.board_stages
  ADD COLUMN stage_key text,
  ADD COLUMN sla_days integer CHECK (sla_days IS NULL OR sla_days >= 0),
  ADD COLUMN sla_business_days boolean NOT NULL DEFAULT false,
  ADD COLUMN max_attempts integer CHECK (max_attempts IS NULL OR max_attempts > 0);
CREATE UNIQUE INDEX board_stages_board_stage_key_uniq ON public.board_stages (board_id, stage_key) WHERE stage_key IS NOT NULL;

ALTER TABLE public.contacts
  ADD COLUMN lead_origin public.lead_origin_type,
  ADD COLUMN segment public.customer_segment_type,
  ADD COLUMN monthly_volume_kg integer CHECK (monthly_volume_kg IS NULL OR monthly_volume_kg >= 0),
  ADD COLUMN current_supplier text,
  ADD COLUMN products_interest text[] NOT NULL DEFAULT '{}',
  ADD COLUMN client_origin public.client_origin_type,
  ADD COLUMN opened_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN portfolio_owner_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN follow_up_owner_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN portfolio_transferred_at timestamptz,
  ADD COLUMN out_of_area boolean NOT NULL DEFAULT false,
  ADD COLUMN out_of_area_at timestamptz,
  ADD COLUMN out_of_area_note text,
  ADD COLUMN region_id uuid REFERENCES public.service_regions(id) ON DELETE SET NULL;
CREATE INDEX contacts_out_of_area_idx ON public.contacts (tenant_id) WHERE out_of_area;

ALTER TABLE public.deals
  ADD COLUMN contact_attempts integer NOT NULL DEFAULT 0 CHECK (contact_attempts >= 0),
  ADD COLUMN sample_requested boolean NOT NULL DEFAULT false,
  ADD COLUMN sample_status public.sample_status_type,
  ADD COLUMN sample_delivered_at timestamptz,
  ADD COLUMN lost_reason_code public.lost_reason_code_type,
  ADD COLUMN first_order_at timestamptz,
  ADD COLUMN first_order_value numeric(12,2),
  ADD COLUMN first_order_mix text[] NOT NULL DEFAULT '{}',
  ADD COLUMN first_delivery_at timestamptz,
  ADD COLUMN second_order_at timestamptz,
  ADD COLUMN nurture_return_at timestamptz,
  ADD COLUMN stage_due_at timestamptz,
  ADD COLUMN source_deal_id uuid REFERENCES public.deals(id) ON DELETE SET NULL;
CREATE INDEX deals_nurture_return_idx ON public.deals (nurture_return_at) WHERE nurture_return_at IS NOT NULL;

CREATE OR REPLACE FUNCTION private.stef_compute_due(p_entered timestamptz, p_days integer, p_business boolean)
RETURNS timestamptz LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
declare
  v_local timestamp;
  v_i integer := 0;
begin
  if p_days is null or p_entered is null then return null; end if;
  v_local := p_entered at time zone 'America/Sao_Paulo';
  if p_days = 0 then
    return (v_local::date + time '23:59:59') at time zone 'America/Sao_Paulo';
  end if;
  if not coalesce(p_business, false) then
    return p_entered + make_interval(days => p_days);
  end if;
  while v_i < p_days loop
    v_local := v_local + interval '1 day';
    if extract(isodow from v_local) < 6 then v_i := v_i + 1; end if;
  end loop;
  return v_local at time zone 'America/Sao_Paulo';
end $$;

CREATE OR REPLACE FUNCTION private.stef_move_deal(p_deal uuid, p_stage uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
declare
  v_prev text := current_setting('app.deal_stage_transition_context', true);
begin
  perform set_config('app.deal_stage_transition_context',
    jsonb_build_object('actor_type','system','reason',p_reason,'trigger_event','stefanello_rule')::text, true);
  update public.deals set stage_id = p_stage where id = p_deal and stage_id is distinct from p_stage;
  perform set_config('app.deal_stage_transition_context', coalesce(v_prev, ''), true);
end $$;

CREATE OR REPLACE FUNCTION private.stef_stage_id(p_tenant uuid, p_board_key text, p_stage_key text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  select s.id from public.board_stages s join public.boards b on b.id = s.board_id
  where b.tenant_id = p_tenant and b.board_key = p_board_key and s.stage_key = p_stage_key limit 1
$$;

CREATE OR REPLACE FUNCTION private.stef_task(p_tenant uuid, p_deal uuid, p_contact uuid, p_owner uuid,
  p_title text, p_due timestamptz, p_kind text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  insert into public.activities (tenant_id, deal_id, contact_id, owner_id, type, title, due_at, metadata)
  values (p_tenant, p_deal, p_contact, p_owner, 'task', p_title, p_due,
          jsonb_build_object('kind', p_kind, 'source', 'stefanello_rule'))
$$;

CREATE OR REPLACE FUNCTION private.stef_followup(p_deal public.deals, p_at timestamptz, p_desc text, p_kind text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
declare v_creator uuid;
begin
  if p_deal.contact_id is null then return; end if;
  if exists (select 1 from public.deal_followups f where f.deal_id = p_deal.id and f.description like '[' || p_kind || ']%') then
    return;
  end if;
  select coalesce(p_deal.owner_id, s.sales_manager_profile_id) into v_creator
  from (select 1) x left join public.tenant_commercial_settings s on s.tenant_id = p_deal.tenant_id;
  if v_creator is null then return; end if;
  insert into public.deal_followups (tenant_id, deal_id, contact_id, scheduled_at, description, created_by, source)
  values (p_deal.tenant_id, p_deal.id, p_deal.contact_id, p_at, '[' || p_kind || '] ' || p_desc, v_creator, 'manual');
end $$;

CREATE OR REPLACE FUNCTION private.stef_route_contact(p_contact uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
declare
  v_c public.contacts;
  v_uf text;
  v_owner uuid;
begin
  if current_setting('app.stef_skip_routing', true) = '1' then return; end if;
  select * into v_c from public.contacts where id = p_contact;
  if not found then return; end if;
  v_uf := upper(btrim(coalesce(v_c.address_state, '')));
  if v_uf = '' then return; end if;
  if v_uf in ('RS','SC') then
    select owner_id into v_owner from public.uf_routing_rules where tenant_id = v_c.tenant_id and uf = v_uf;
    update public.contacts set out_of_area = false, out_of_area_at = null,
      owner_id = coalesce(v_owner, owner_id)
    where id = p_contact;
    if v_owner is not null then
      update public.deals d set owner_id = v_owner
      from public.board_stages s join public.boards b on b.id = s.board_id
      where d.contact_id = p_contact and d.stage_id = s.id and d.status = 'open'
        and b.board_key = 'main' and s.stage_key = 'lead_novo';
    end if;
  else
    update public.contacts set out_of_area = true, out_of_area_at = coalesce(out_of_area_at, now())
    where id = p_contact;
  end if;
end $$;

CREATE OR REPLACE FUNCTION private.stef_contacts_before()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
begin
  if tg_op = 'INSERT' or new.address_city is distinct from old.address_city
     or new.address_state is distinct from old.address_state then
    select rc.region_id into new.region_id
    from public.service_route_cities rc
    where rc.tenant_id = new.tenant_id and rc.active
      and rc.uf = upper(btrim(coalesce(new.address_state,'')))
      and rc.city_norm = private.stef_norm(new.address_city)
    limit 1;
    if not found then new.region_id := null; end if;
  end if;
  return new;
end $$;
CREATE TRIGGER zz_stef_contacts_before BEFORE INSERT OR UPDATE OF address_city, address_state ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION private.stef_contacts_before();

CREATE OR REPLACE FUNCTION private.stef_contacts_after_uf()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
begin
  if exists (
    select 1 from public.deals d join public.board_stages s on s.id = d.stage_id join public.boards b on b.id = s.board_id
    where d.contact_id = new.id and d.status = 'open' and b.board_key = 'main' and s.stage_key = 'lead_novo'
  ) then
    perform private.stef_route_contact(new.id);
  end if;
  return null;
end $$;
CREATE TRIGGER zz_stef_contacts_after_uf AFTER UPDATE OF address_state ON public.contacts
  FOR EACH ROW WHEN (new.address_state IS DISTINCT FROM old.address_state)
  EXECUTE FUNCTION private.stef_contacts_after_uf();

CREATE OR REPLACE FUNCTION private.stef_deals_before()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
declare
  v_board_key text; v_stage_key text; v_sla int; v_bus boolean;
begin
  select b.board_key, s.stage_key, s.sla_days, s.sla_business_days
    into v_board_key, v_stage_key, v_sla, v_bus
  from public.board_stages s join public.boards b on b.id = s.board_id where s.id = new.stage_id;
  if v_board_key is null then return new; end if;

  if tg_op = 'INSERT' or new.stage_id is distinct from old.stage_id then
    new.stage_due_at := private.stef_compute_due(coalesce(new.stage_entered_at, now()), v_sla, v_bus);
    if v_stage_key = 'ganho' and new.first_order_at is null then
      raise exception 'Para marcar como Ganho, informe a data do 1º pedido faturado.'
        using errcode = '23514', hint = 'Preencha first_order_at antes de mover para Ganho.';
    end if;
  end if;

  if new.status = 'lost' then
    if new.lost_reason_code is null then
      raise exception 'Informe o motivo da perda para marcar o negócio como perdido.'
        using errcode = '23514', hint = 'Preencha lost_reason_code com um dos motivos da lista.';
    end if;
    new.lost_reason := coalesce(new.lost_reason, new.lost_reason_code::text);
    if new.lost_reason_code = 'sem_contato' and new.nurture_return_at is null
       and (tg_op = 'INSERT' or old.status is distinct from 'lost' or old.lost_reason_code is distinct from new.lost_reason_code) then
      new.nurture_return_at := coalesce(new.closed_at, now()) + interval '75 days';
    end if;
    if new.lost_reason_code <> 'sem_contato' then new.nurture_return_at := null; end if;
  end if;
  return new;
end $$;
CREATE TRIGGER zz_stef_deals_before BEFORE INSERT OR UPDATE ON public.deals
  FOR EACH ROW EXECUTE FUNCTION private.stef_deals_before();

CREATE OR REPLACE FUNCTION private.stef_deals_after()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
declare
  v_board_key text; v_stage_key text; v_max int;
  v_set public.tenant_commercial_settings;
  v_contact public.contacts;
  v_entered boolean := tg_op = 'INSERT' or new.stage_id is distinct from old.stage_id;
  v_stage uuid; v_board uuid; v_seller uuid;
begin
  select b.board_key, s.stage_key, s.max_attempts into v_board_key, v_stage_key, v_max
  from public.board_stages s join public.boards b on b.id = s.board_id where s.id = new.stage_id;
  if v_board_key is null then return null; end if;
  select * into v_set from public.tenant_commercial_settings where tenant_id = new.tenant_id;
  if new.contact_id is not null then
    select * into v_contact from public.contacts where id = new.contact_id;
  end if;

  if tg_op = 'INSERT' and v_board_key = 'main' and v_stage_key = 'lead_novo' and new.contact_id is not null then
    perform private.stef_route_contact(new.contact_id);
  end if;

  if v_stage_key = 'em_contato' and v_max is not null and new.contact_attempts >= v_max
     and (tg_op = 'INSERT' or old.contact_attempts < v_max) then
    perform private.stef_task(new.tenant_id, new.id, new.contact_id, new.owner_id,
      'Decidir: perder por Sem contato ou insistir', now(), 'attempts_limit');
  end if;

  if v_entered and v_stage_key = 'cadastro_credito' then
    perform private.stef_task(new.tenant_id, new.id, new.contact_id, v_set.finance_profile_id,
      'Cadastro e análise de crédito', private.stef_compute_due(now(), 2, true), 'credit_review');
  end if;

  if new.sample_requested and (tg_op = 'INSERT' or not old.sample_requested) then
    perform private.stef_task(new.tenant_id, new.id, new.contact_id, v_set.sales_manager_profile_id,
      'Aprovar amostra solicitada', now() + interval '1 day', 'sample_approval');
  end if;
  if new.sample_status = 'aprovada' and new.sample_delivered_at is not null
     and (tg_op = 'INSERT' or old.sample_status is distinct from 'aprovada' or old.sample_delivered_at is null) then
    perform private.stef_followup(new, new.sample_delivered_at + interval '3 days',
      'Follow-up da amostra entregue', 'sample_followup');
  end if;

  if v_entered and v_board_key = 'main' and v_stage_key = 'ganho' and new.contact_id is not null then
    update public.contacts set portfolio_owner_id = case
        when upper(btrim(coalesce(address_state,''))) = 'RS' then coalesce(v_set.televendas_rs_profile_id, new.owner_id)
        else new.owner_id end
    where id = new.contact_id;
    v_stage := private.stef_stage_id(new.tenant_id, 'pos_venda', 'primeira_entrega');
    if v_stage is not null and not exists (select 1 from public.deals where source_deal_id = new.id) then
      select board_id into v_board from public.board_stages where id = v_stage;
      insert into public.deals (tenant_id, board_id, stage_id, contact_id, title, value, owner_id,
        first_order_at, first_order_value, first_order_mix, source_deal_id)
      values (new.tenant_id, v_board, v_stage, new.contact_id, new.title, new.first_order_value,
        (select portfolio_owner_id from public.contacts where id = new.contact_id),
        new.first_order_at, new.first_order_value, new.first_order_mix, new.id);
    end if;
  end if;

  if v_board_key = 'pos_venda' then
    if v_stage_key = 'primeira_entrega' and new.first_delivery_at is not null
       and (v_entered or old.first_delivery_at is null) then
      perform private.stef_followup(new, new.first_delivery_at + interval '2 days',
        'Contato pós 1ª entrega (D+2)', 'delivery_d2');
    end if;
    if new.second_order_at is not null and new.first_order_at is not null
       and new.second_order_at <= new.first_order_at + interval '30 days'
       and (tg_op = 'INSERT' or old.second_order_at is null)
       and v_stage_key is distinct from 'cliente_ativado' then
      v_stage := private.stef_stage_id(new.tenant_id, 'pos_venda', 'cliente_ativado');
      if v_stage is not null then
        perform private.stef_move_deal(new.id, v_stage, '2º pedido em até 30 dias do 1º');
      end if;
    end if;
    if v_entered and v_stage_key = 'visita_presencial' and new.contact_id is not null then
      select r.external_seller_id into v_seller from public.service_regions r where r.id = v_contact.region_id;
      v_seller := coalesce(v_seller, v_set.external_seller_rs_profile_id);
      update public.contacts set
        portfolio_owner_id = coalesce(v_seller, portfolio_owner_id),
        follow_up_owner_id = coalesce(v_set.televendas_rs_profile_id, follow_up_owner_id),
        portfolio_transferred_at = now()
      where id = new.contact_id;
      if v_seller is not null then
        update public.deals set owner_id = v_seller where id = new.id;
      end if;
    end if;
  end if;
  return null;
end $$;
CREATE TRIGGER zz_stef_deals_after AFTER INSERT OR UPDATE ON public.deals
  FOR EACH ROW EXECUTE FUNCTION private.stef_deals_after();

CREATE OR REPLACE FUNCTION public.process_nurture_returns()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
declare r record; v_stage uuid; v_n int := 0; v_owner uuid;
begin
  for r in
    select d.id, d.tenant_id, d.contact_id from public.deals d join public.boards b on b.id = d.board_id
    where b.board_key = 'main' and d.status = 'lost' and d.lost_reason_code = 'sem_contato'
      and d.nurture_return_at is not null and d.nurture_return_at <= now()
    for update of d skip locked
  loop
    v_stage := private.stef_stage_id(r.tenant_id, 'main', 'lead_novo');
    if v_stage is null then continue; end if;
    perform private.stef_move_deal(r.id, v_stage, 'Retorno da nutrição (Sem contato, 75 dias)');
    update public.deals set lost_reason_code = null, nurture_return_at = null, contact_attempts = 0 where id = r.id;
    if r.contact_id is not null then
      update public.contacts set tags = array_append(tags, 'Retorno nutrição')
      where id = r.contact_id and not ('Retorno nutrição' = any(tags));
      perform private.stef_route_contact(r.contact_id);
    end if;
    select owner_id into v_owner from public.deals where id = r.id;
    perform private.stef_task(r.tenant_id, r.id, r.contact_id, v_owner,
      'Retomar contato: lead voltou da nutrição', now(), 'nurture_return');
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
REVOKE ALL ON FUNCTION public.process_nurture_returns() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_nurture_returns() TO service_role;

CREATE OR REPLACE FUNCTION public.mark_out_of_area(p_deal_id uuid, p_note text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
declare v_tenant uuid := private.get_user_tenant_id(); v_contact uuid;
begin
  if v_tenant is null then raise exception 'Não autenticado' using errcode = '42501'; end if;
  select contact_id into v_contact from public.deals where id = p_deal_id and tenant_id = v_tenant;
  if v_contact is null then raise exception 'Negócio não encontrado' using errcode = 'P0002'; end if;
  update public.contacts set out_of_area = true, out_of_area_at = now(),
    out_of_area_note = coalesce(p_note, out_of_area_note)
  where id = v_contact;
end $$;

CREATE OR REPLACE FUNCTION public.reactivate_region(p_region_id uuid, p_cities text[], p_new_owner uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
declare
  v_tenant uuid := private.get_user_tenant_id();
  v_stage uuid; v_board uuid; v_n int := 0; r record; v_deal uuid;
begin
  if v_tenant is null then raise exception 'Não autenticado' using errcode = '42501'; end if;
  if p_region_id is null and coalesce(array_length(p_cities, 1), 0) = 0 then
    raise exception 'Informe a região ou as cidades' using errcode = '22023';
  end if;
  if not exists (select 1 from public.profiles where id = p_new_owner and tenant_id = v_tenant) then
    raise exception 'Responsável inválido para este workspace' using errcode = '22023';
  end if;
  v_stage := private.stef_stage_id(v_tenant, 'main', 'lead_novo');
  if v_stage is null then raise exception 'Funil principal sem etapa lead_novo' using errcode = 'P0002'; end if;
  select board_id into v_board from public.board_stages where id = v_stage;
  perform set_config('app.stef_skip_routing', '1', true);
  for r in
    select c.id, c.name from public.contacts c
    where c.tenant_id = v_tenant and c.out_of_area and c.deleted_at is null
      and ((p_region_id is not null and c.region_id = p_region_id)
        or private.stef_norm(c.address_city) = any (select private.stef_norm(x) from unnest(coalesce(p_cities, '{}')) x))
  loop
    update public.contacts set out_of_area = false, out_of_area_at = null, owner_id = p_new_owner where id = r.id;
    select d.id into v_deal from public.deals d
      where d.contact_id = r.id and d.board_id = v_board and d.status = 'open' order by d.created_at desc limit 1;
    if v_deal is null then
      insert into public.deals (tenant_id, board_id, stage_id, contact_id, title, owner_id)
      values (v_tenant, v_board, v_stage, r.id, r.name, p_new_owner);
    else
      perform private.stef_move_deal(v_deal, v_stage, 'Reativar região');
      update public.deals set owner_id = p_new_owner, contact_attempts = 0 where id = v_deal;
    end if;
    v_deal := null;
    v_n := v_n + 1;
  end loop;
  perform set_config('app.stef_skip_routing', '', true);
  return v_n;
end $$;

REVOKE ALL ON FUNCTION public.mark_out_of_area(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reactivate_region(uuid, text[], uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_out_of_area(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reactivate_region(uuid, text[], uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION private.stef_compute_due(timestamptz, integer, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.stef_move_deal(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.stef_stage_id(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.stef_task(uuid, uuid, uuid, uuid, text, timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.stef_followup(public.deals, timestamptz, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.stef_route_contact(uuid) FROM PUBLIC;

CREATE VIEW public.deal_sla_status WITH (security_invoker = true) AS
select d.id as deal_id, d.tenant_id, b.board_key, s.stage_key, s.name as stage_name, d.owner_id,
  d.stage_entered_at, d.stage_due_at, d.contact_attempts, s.max_attempts,
  (d.status = 'open' and d.stage_due_at is not null and now() > d.stage_due_at) as is_overdue
from public.deals d join public.board_stages s on s.id = d.stage_id join public.boards b on b.id = s.board_id
left join public.contacts c on c.id = d.contact_id
where b.board_key is not null and not coalesce(c.out_of_area, false);

CREATE VIEW public.v_stef_leads_by_origin WITH (security_invoker = true) AS
select tenant_id, lead_origin, count(*)::int as leads from public.contacts
where deleted_at is null and merged_into_id is null and not out_of_area
group by tenant_id, lead_origin;

CREATE VIEW public.v_stef_leads_by_owner WITH (security_invoker = true) AS
select c.tenant_id, c.owner_id, p.name as owner_name, count(*)::int as leads
from public.contacts c left join public.profiles p on p.id = c.owner_id
where c.deleted_at is null and c.merged_into_id is null and not c.out_of_area
group by c.tenant_id, c.owner_id, p.name;

CREATE VIEW public.v_stef_stage_conversion WITH (security_invoker = true) AS
with md as (
  select d.* from public.deals d join public.boards b on b.id = d.board_id
  left join public.contacts c on c.id = d.contact_id
  where b.board_key = 'main' and not coalesce(c.out_of_area, false)
), reached as (
  select md.id as deal_id, md.stage_id from md
  union select h.deal_id, h.to_stage_id from public.deal_stage_history h join md on md.id = h.deal_id
  union select md.id, s.id from md join public.board_stages s on s.board_id = md.board_id and s.stage_key = 'lead_novo'
), per as (
  select s.board_id, b.tenant_id, s.id as stage_id, s.stage_key, s.name, s.position,
    count(distinct r.deal_id)::int as deals_reached
  from public.board_stages s join public.boards b on b.id = s.board_id
  left join reached r on r.stage_id = s.id
  where b.board_key = 'main' and not s.is_lost
  group by s.board_id, b.tenant_id, s.id, s.stage_key, s.name, s.position
)
select tenant_id, board_id, stage_id, stage_key, name, position, deals_reached,
  lead(deals_reached) over w as deals_next,
  case when deals_reached > 0 then round(100.0 * lead(deals_reached) over w / deals_reached) end as conversion_pct
from per window w as (partition by board_id order by position);

CREATE VIEW public.v_stef_lead_to_client WITH (security_invoker = true) AS
select d.tenant_id, count(*)::int as leads,
  count(*) filter (where d.status = 'won')::int as clients,
  case when count(*) > 0 then round(100.0 * count(*) filter (where d.status = 'won') / count(*)) end as conversion_pct
from public.deals d join public.boards b on b.id = d.board_id
left join public.contacts c on c.id = d.contact_id
where b.board_key = 'main' and not coalesce(c.out_of_area, false)
group by d.tenant_id;

CREATE VIEW public.v_stef_stage_avg_time WITH (security_invoker = true) AS
with seg as (
  select d.id as deal_id, d.tenant_id, d.board_id, d.status, d.closed_at,
    coalesce((select h.from_stage_id from public.deal_stage_history h where h.deal_id = d.id order by h.created_at limit 1), d.stage_id) as stage_id,
    d.created_at as entered_at
  from public.deals d join public.boards b on b.id = d.board_id where b.board_key is not null
  union all
  select h.deal_id, d.tenant_id, d.board_id, d.status, d.closed_at, h.to_stage_id, h.created_at
  from public.deal_stage_history h join public.deals d on d.id = h.deal_id join public.boards b on b.id = d.board_id
  where b.board_key is not null
), w as (
  select seg.*, coalesce(lead(entered_at) over (partition by deal_id order by entered_at),
    case when status = 'open' then now() else closed_at end) as left_at
  from seg
)
select w.tenant_id, w.board_id, s.id as stage_id, s.stage_key, s.name,
  count(*)::int as passages,
  round(extract(epoch from avg(w.left_at - w.entered_at)) / 3600)::int as avg_hours
from w join public.board_stages s on s.id = w.stage_id
where not s.is_won and not s.is_lost and w.left_at is not null
group by w.tenant_id, w.board_id, s.id, s.stage_key, s.name;

CREATE VIEW public.v_stef_overdue_summary WITH (security_invoker = true) AS
select tenant_id, board_key, stage_key, stage_name, owner_id,
  count(*) filter (where is_overdue)::int as overdue, count(*)::int as total
from public.deal_sla_status group by tenant_id, board_key, stage_key, stage_name, owner_id;

CREATE VIEW public.v_stef_cost_per_client WITH (security_invoker = true) AS
with won as (
  select d.tenant_id, date_trunc('month', d.first_order_at at time zone 'America/Sao_Paulo')::date as month, count(*)::int as clients
  from public.deals d join public.boards b on b.id = d.board_id join public.contacts c on c.id = d.contact_id
  where b.board_key = 'main' and d.status = 'won' and c.lead_origin = 'trafego_pago_site' and d.first_order_at is not null
  group by 1, 2
)
select coalesce(m.tenant_id, w.tenant_id) as tenant_id, coalesce(m.month, w.month) as month,
  coalesce(m.amount, 0) as spend, coalesce(w.clients, 0) as clients,
  case when coalesce(w.clients, 0) > 0 then round(coalesce(m.amount, 0) / w.clients) end as cost_per_client
from (select * from public.marketing_spend where channel = 'trafego_pago') m
full join won w on w.tenant_id = m.tenant_id and w.month = m.month;

CREATE VIEW public.v_stef_first_order WITH (security_invoker = true) AS
select d.tenant_id, date_trunc('month', d.first_order_at at time zone 'America/Sao_Paulo')::date as month,
  count(*)::int as orders, round(avg(d.first_order_value)) as avg_ticket, round(sum(d.first_order_value)) as total
from public.deals d join public.boards b on b.id = d.board_id
where b.board_key = 'main' and d.status = 'won' and d.first_order_at is not null
group by 1, 2;

CREATE VIEW public.v_stef_first_order_mix WITH (security_invoker = true) AS
select d.tenant_id, p.product, count(*)::int as orders
from public.deals d join public.boards b on b.id = d.board_id, unnest(d.first_order_mix) as p(product)
where b.board_key = 'main' and d.status = 'won'
group by d.tenant_id, p.product;

CREATE VIEW public.v_stef_activation_rate WITH (security_invoker = true) AS
select d.tenant_id,
  count(*)::int as first_orders,
  count(*) filter (where d.second_order_at is not null and d.second_order_at <= d.first_order_at + interval '30 days')::int as activated,
  count(*) filter (where d.first_order_at <= now() - interval '30 days'
    or (d.second_order_at is not null and d.second_order_at <= d.first_order_at + interval '30 days'))::int as eligible,
  case when count(*) filter (where d.first_order_at <= now() - interval '30 days'
    or (d.second_order_at is not null and d.second_order_at <= d.first_order_at + interval '30 days')) > 0
  then round(100.0 * count(*) filter (where d.second_order_at is not null and d.second_order_at <= d.first_order_at + interval '30 days')
    / count(*) filter (where d.first_order_at <= now() - interval '30 days'
    or (d.second_order_at is not null and d.second_order_at <= d.first_order_at + interval '30 days'))) end as activation_pct
from public.deals d join public.boards b on b.id = d.board_id
where b.board_key = 'pos_venda' and d.first_order_at is not null
group by d.tenant_id;

CREATE VIEW public.v_stef_clients_by_origin WITH (security_invoker = true) AS
select d.tenant_id, c.client_origin, count(*)::int as clients
from public.deals d join public.boards b on b.id = d.board_id join public.contacts c on c.id = d.contact_id
where b.board_key = 'main' and d.status = 'won'
group by d.tenant_id, c.client_origin;

CREATE VIEW public.v_stef_out_of_area_demand WITH (security_invoker = true) AS
select c.tenant_id,
  case when grouping(c.address_city) = 0 then 'cidade' when grouping(r.name) = 0 then 'regiao' else 'uf' end as group_level,
  upper(c.address_state) as uf, c.address_city as city, r.name as region_name,
  count(*)::int as leads, coalesce(sum(c.monthly_volume_kg), 0)::bigint as kg_month
from public.contacts c left join public.service_regions r on r.id = c.region_id
where c.out_of_area and c.deleted_at is null
group by grouping sets ((c.tenant_id, upper(c.address_state)), (c.tenant_id, upper(c.address_state), c.address_city), (c.tenant_id, r.name));

GRANT SELECT ON public.deal_sla_status, public.v_stef_leads_by_origin, public.v_stef_leads_by_owner,
  public.v_stef_stage_conversion, public.v_stef_lead_to_client, public.v_stef_stage_avg_time,
  public.v_stef_overdue_summary, public.v_stef_cost_per_client, public.v_stef_first_order,
  public.v_stef_first_order_mix, public.v_stef_activation_rate, public.v_stef_clients_by_origin,
  public.v_stef_out_of_area_demand TO authenticated, service_role;
