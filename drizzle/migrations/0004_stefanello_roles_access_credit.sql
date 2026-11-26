ALTER TABLE public.profiles DROP CONSTRAINT profiles_role_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check CHECK (role IN ('admin', 'manager', 'finance', 'agent'));
CREATE TYPE public.credit_condition_type AS ENUM ('a_vista', 'credito_aprovado', 'sem_aprovacao');
ALTER TABLE public.deals
  ADD COLUMN credit_condition public.credit_condition_type,
  ADD COLUMN credit_limit integer CHECK (credit_limit IS NULL OR credit_limit >= 0),
  ADD COLUMN payment_terms_days integer[] NOT NULL DEFAULT '{}',
  ADD COLUMN credit_notes text,
  ADD COLUMN credit_evaluated_at timestamptz,
  ADD COLUMN credit_evaluated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS contacts_owner_id_idx ON public.contacts (tenant_id, owner_id) WHERE owner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS contacts_portfolio_owner_id_idx ON public.contacts (tenant_id, portfolio_owner_id) WHERE portfolio_owner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS contacts_follow_up_owner_id_idx ON public.contacts (tenant_id, follow_up_owner_id) WHERE follow_up_owner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS deals_owner_id_idx ON public.deals (tenant_id, owner_id) WHERE owner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS deals_contact_id_idx ON public.deals (tenant_id, contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS activities_owner_id_idx ON public.activities (tenant_id, owner_id) WHERE owner_id IS NOT NULL;

CREATE OR REPLACE FUNCTION private.stef_current_role() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, private AS $$
  select p.role from public.profiles p where p.id = (select auth.uid()) and p.tenant_id = private.get_active_tenant_id() and not p.disabled limit 1
$$;
CREATE OR REPLACE FUNCTION private.stef_can_read_contact(p_tenant uuid, p_contact uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, private AS $$
declare v_role text := private.stef_current_role();
begin
  if p_contact is null or p_tenant is distinct from private.get_active_tenant_id() then return false; end if;
  if v_role in ('admin', 'manager') then return exists (select 1 from public.contacts c where c.id = p_contact and c.tenant_id = p_tenant); end if;
  if v_role = 'agent' then
    return exists (select 1 from public.contacts c where c.id = p_contact and c.tenant_id = p_tenant and (select auth.uid()) in (c.owner_id, c.portfolio_owner_id, c.follow_up_owner_id));
  end if;
  if v_role = 'finance' then
    return exists (select 1 from public.deals d join public.boards b on b.id = d.board_id join public.board_stages s on s.id = d.stage_id
      where d.tenant_id = p_tenant and d.contact_id = p_contact and (b.board_key = 'pos_venda' or (b.board_key = 'main' and s.stage_key in ('cadastro_credito', 'ganho'))));
  end if;
  return false;
end $$;
CREATE OR REPLACE FUNCTION private.stef_can_read_deal(p_tenant uuid, p_deal uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, private AS $$
declare v_role text := private.stef_current_role();
begin
  if p_deal is null or p_tenant is distinct from private.get_active_tenant_id() then return false; end if;
  if v_role in ('admin', 'manager') then return exists (select 1 from public.deals d where d.id = p_deal and d.tenant_id = p_tenant); end if;
  if v_role = 'agent' then
    return exists (select 1 from public.deals d left join public.contacts c on c.id = d.contact_id where d.id = p_deal and d.tenant_id = p_tenant
      and (d.owner_id = (select auth.uid()) or (select auth.uid()) in (c.owner_id, c.portfolio_owner_id, c.follow_up_owner_id)));
  end if;
  if v_role = 'finance' then
    return exists (select 1 from public.deals d join public.boards b on b.id = d.board_id join public.board_stages s on s.id = d.stage_id
      where d.id = p_deal and d.tenant_id = p_tenant and (b.board_key = 'pos_venda' or (b.board_key = 'main' and s.stage_key in ('cadastro_credito', 'ganho'))));
  end if;
  return false;
end $$;
CREATE OR REPLACE FUNCTION private.stef_can_read_activity(p_tenant uuid, p_owner uuid, p_deal uuid, p_contact uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, private AS $$
  select case
    when private.stef_current_role() in ('admin', 'manager') then p_tenant = (select private.get_active_tenant_id())
    when private.stef_current_role() = 'agent' then p_tenant = (select private.get_active_tenant_id()) and (p_owner = (select auth.uid()) or private.stef_can_read_deal(p_tenant, p_deal) or private.stef_can_read_contact(p_tenant, p_contact))
    when private.stef_current_role() = 'finance' then p_tenant = (select private.get_active_tenant_id()) and (private.stef_can_read_deal(p_tenant, p_deal) or private.stef_can_read_contact(p_tenant, p_contact))
    else false end
$$;
REVOKE ALL ON FUNCTION private.stef_current_role() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.stef_can_read_contact(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.stef_can_read_deal(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.stef_can_read_activity(uuid, uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.stef_current_role() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.stef_can_read_contact(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.stef_can_read_deal(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.stef_can_read_activity(uuid, uuid, uuid, uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS "contacts tenant all" ON public.contacts;
CREATE POLICY "contacts role select" ON public.contacts FOR SELECT TO authenticated USING (private.stef_can_read_contact(tenant_id, id));
CREATE POLICY "contacts admin manager all" ON public.contacts FOR ALL TO authenticated
  USING (private.stef_current_role() in ('admin', 'manager') and tenant_id = (select private.get_active_tenant_id()))
  WITH CHECK (private.stef_current_role() in ('admin', 'manager') and tenant_id = (select private.get_active_tenant_id()));
CREATE POLICY "contacts agent insert" ON public.contacts FOR INSERT TO authenticated WITH CHECK (private.stef_current_role() = 'agent' and tenant_id = (select private.get_active_tenant_id()) and owner_id = (select auth.uid()) and opened_by = (select auth.uid()) and client_origin = 'prospeccao_propria');
CREATE POLICY "contacts agent update" ON public.contacts FOR UPDATE TO authenticated
  USING (private.stef_current_role() = 'agent' and private.stef_can_read_contact(tenant_id, id))
  WITH CHECK (private.stef_current_role() = 'agent' and private.stef_can_read_contact(tenant_id, id));
CREATE POLICY "contacts agent delete" ON public.contacts FOR DELETE TO authenticated USING (private.stef_current_role() = 'agent' and private.stef_can_read_contact(tenant_id, id));

DROP POLICY IF EXISTS "deals tenant all" ON public.deals;
CREATE POLICY "deals role select" ON public.deals FOR SELECT TO authenticated USING (private.stef_can_read_deal(tenant_id, id));
CREATE POLICY "deals admin manager all" ON public.deals FOR ALL TO authenticated
  USING (private.stef_current_role() in ('admin', 'manager') and tenant_id = (select private.get_active_tenant_id()))
  WITH CHECK (private.stef_current_role() in ('admin', 'manager') and tenant_id = (select private.get_active_tenant_id()));
CREATE POLICY "deals agent insert" ON public.deals FOR INSERT TO authenticated WITH CHECK (private.stef_current_role() = 'agent' and tenant_id = (select private.get_active_tenant_id()) and owner_id = (select auth.uid()) and (contact_id is null or private.stef_can_read_contact(tenant_id, contact_id)));
CREATE POLICY "deals agent update" ON public.deals FOR UPDATE TO authenticated
  USING (private.stef_current_role() = 'agent' and private.stef_can_read_deal(tenant_id, id))
  WITH CHECK (private.stef_current_role() = 'agent' and tenant_id = (select private.get_active_tenant_id()) and owner_id = (select auth.uid()) and (contact_id is null or private.stef_can_read_contact(tenant_id, contact_id)));
CREATE POLICY "deals agent delete" ON public.deals FOR DELETE TO authenticated USING (private.stef_current_role() = 'agent' and private.stef_can_read_deal(tenant_id, id));
CREATE POLICY "deals finance credit update" ON public.deals FOR UPDATE TO authenticated
  USING (private.stef_current_role() = 'finance' and private.stef_can_read_deal(tenant_id, id))
  WITH CHECK (private.stef_current_role() = 'finance' and private.stef_can_read_deal(tenant_id, id));

DROP POLICY IF EXISTS "activities tenant all" ON public.activities;
CREATE POLICY "activities role select" ON public.activities FOR SELECT TO authenticated USING (private.stef_can_read_activity(tenant_id, owner_id, deal_id, contact_id));
CREATE POLICY "activities admin manager all" ON public.activities FOR ALL TO authenticated
  USING (private.stef_current_role() in ('admin', 'manager') and tenant_id = (select private.get_active_tenant_id()))
  WITH CHECK (private.stef_current_role() in ('admin', 'manager') and tenant_id = (select private.get_active_tenant_id()));
CREATE POLICY "activities agent insert" ON public.activities FOR INSERT TO authenticated WITH CHECK (private.stef_current_role() = 'agent' and private.stef_can_read_activity(tenant_id, owner_id, deal_id, contact_id));
CREATE POLICY "activities agent update" ON public.activities FOR UPDATE TO authenticated
  USING (private.stef_current_role() = 'agent' and private.stef_can_read_activity(tenant_id, owner_id, deal_id, contact_id))
  WITH CHECK (private.stef_current_role() = 'agent' and private.stef_can_read_activity(tenant_id, owner_id, deal_id, contact_id));
CREATE POLICY "activities agent delete" ON public.activities FOR DELETE TO authenticated USING (private.stef_current_role() = 'agent' and private.stef_can_read_activity(tenant_id, owner_id, deal_id, contact_id));

DROP POLICY IF EXISTS "conversations tenant all" ON public.conversations;
CREATE POLICY "conversations role select" ON public.conversations FOR SELECT TO authenticated USING (private.stef_can_read_contact(tenant_id, contact_id));
CREATE POLICY "conversations admin manager all" ON public.conversations FOR ALL TO authenticated
  USING (private.stef_current_role() in ('admin', 'manager') and tenant_id = (select private.get_active_tenant_id()))
  WITH CHECK (private.stef_current_role() in ('admin', 'manager') and tenant_id = (select private.get_active_tenant_id()));
CREATE POLICY "conversations agent insert" ON public.conversations FOR INSERT TO authenticated WITH CHECK (private.stef_current_role() = 'agent' and private.stef_can_read_contact(tenant_id, contact_id));
CREATE POLICY "conversations agent update" ON public.conversations FOR UPDATE TO authenticated
  USING (private.stef_current_role() = 'agent' and private.stef_can_read_contact(tenant_id, contact_id))
  WITH CHECK (private.stef_current_role() = 'agent' and private.stef_can_read_contact(tenant_id, contact_id));
CREATE POLICY "conversations agent delete" ON public.conversations FOR DELETE TO authenticated USING (private.stef_current_role() = 'agent' and private.stef_can_read_contact(tenant_id, contact_id));

DROP POLICY IF EXISTS "messages tenant all" ON public.messages;
CREATE POLICY "messages role select" ON public.messages FOR SELECT TO authenticated USING (tenant_id = (select private.get_active_tenant_id()) and exists (select 1 from public.conversations c where c.id = conversation_id and private.stef_can_read_contact(c.tenant_id, c.contact_id)));
CREATE POLICY "messages admin manager all" ON public.messages FOR ALL TO authenticated
  USING (private.stef_current_role() in ('admin', 'manager') and tenant_id = (select private.get_active_tenant_id()))
  WITH CHECK (private.stef_current_role() in ('admin', 'manager') and tenant_id = (select private.get_active_tenant_id()));
CREATE POLICY "messages agent insert" ON public.messages FOR INSERT TO authenticated WITH CHECK (private.stef_current_role() = 'agent' and tenant_id = (select private.get_active_tenant_id()) and exists (select 1 from public.conversations c where c.id = conversation_id and private.stef_can_read_contact(c.tenant_id, c.contact_id)));
CREATE POLICY "messages agent update" ON public.messages FOR UPDATE TO authenticated
  USING (private.stef_current_role() = 'agent' and tenant_id = (select private.get_active_tenant_id()) and exists (select 1 from public.conversations c where c.id = conversation_id and private.stef_can_read_contact(c.tenant_id, c.contact_id)))
  WITH CHECK (private.stef_current_role() = 'agent' and tenant_id = (select private.get_active_tenant_id()) and exists (select 1 from public.conversations c where c.id = conversation_id and private.stef_can_read_contact(c.tenant_id, c.contact_id)));
CREATE POLICY "messages agent delete" ON public.messages FOR DELETE TO authenticated USING (private.stef_current_role() = 'agent' and tenant_id = (select private.get_active_tenant_id()) and exists (select 1 from public.conversations c where c.id = conversation_id and private.stef_can_read_contact(c.tenant_id, c.contact_id)));

DROP POLICY IF EXISTS "deal_followups tenant all" ON public.deal_followups;
CREATE POLICY "deal_followups role select" ON public.deal_followups FOR SELECT TO authenticated USING (private.stef_can_read_deal(tenant_id, deal_id) or private.stef_can_read_contact(tenant_id, contact_id));
CREATE POLICY "deal_followups admin manager all" ON public.deal_followups FOR ALL TO authenticated
  USING (private.stef_current_role() in ('admin', 'manager') and tenant_id = (select private.get_active_tenant_id()))
  WITH CHECK (private.stef_current_role() in ('admin', 'manager') and tenant_id = (select private.get_active_tenant_id()));
CREATE POLICY "deal_followups agent insert" ON public.deal_followups FOR INSERT TO authenticated WITH CHECK (private.stef_current_role() = 'agent' and (private.stef_can_read_deal(tenant_id, deal_id) or private.stef_can_read_contact(tenant_id, contact_id)));
CREATE POLICY "deal_followups agent update" ON public.deal_followups FOR UPDATE TO authenticated
  USING (private.stef_current_role() = 'agent' and (private.stef_can_read_deal(tenant_id, deal_id) or private.stef_can_read_contact(tenant_id, contact_id)))
  WITH CHECK (private.stef_current_role() = 'agent' and (private.stef_can_read_deal(tenant_id, deal_id) or private.stef_can_read_contact(tenant_id, contact_id)));
CREATE POLICY "deal_followups agent delete" ON public.deal_followups FOR DELETE TO authenticated USING (private.stef_current_role() = 'agent' and (private.stef_can_read_deal(tenant_id, deal_id) or private.stef_can_read_contact(tenant_id, contact_id)));

DROP POLICY IF EXISTS "deal_stage_history tenant select" ON public.deal_stage_history;
CREATE POLICY "deal_stage_history role select" ON public.deal_stage_history FOR SELECT TO authenticated USING (private.stef_can_read_deal(tenant_id, deal_id));
DROP POLICY IF EXISTS "deal_stage_transition_commands tenant select" ON public.deal_stage_transition_commands;
CREATE POLICY "deal_stage_transition_commands role select" ON public.deal_stage_transition_commands FOR SELECT TO authenticated USING (private.stef_can_read_deal(tenant_id, deal_id));
DROP POLICY IF EXISTS "deal_stage_evaluations tenant select" ON public.deal_stage_evaluations;
CREATE POLICY "deal_stage_evaluations role select" ON public.deal_stage_evaluations FOR SELECT TO authenticated USING (private.stef_can_read_deal(tenant_id, deal_id));
DROP POLICY IF EXISTS "ai_pending_stage_advances tenant select" ON public.ai_pending_stage_advances;
CREATE POLICY "ai_pending_stage_advances role select" ON public.ai_pending_stage_advances FOR SELECT TO authenticated USING (private.stef_can_read_deal(tenant_id, deal_id));

CREATE OR REPLACE FUNCTION private.stef_contacts_before() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private AS $$
begin
  if tg_op = 'INSERT' and (select auth.role()) = 'authenticated' then
    if private.stef_current_role() = 'agent' then
      new.owner_id := (select auth.uid()); new.opened_by := (select auth.uid()); new.client_origin := 'prospeccao_propria';
    elsif private.stef_current_role() in ('admin', 'manager') then
      new.opened_by := coalesce(new.opened_by, (select auth.uid())); new.client_origin := 'lead_empresa';
    end if;
  end if;
  if tg_op = 'INSERT' or new.address_city is distinct from old.address_city or new.address_state is distinct from old.address_state then
    select rc.region_id into new.region_id from public.service_route_cities rc
      where rc.tenant_id = new.tenant_id and rc.active and rc.uf = upper(btrim(coalesce(new.address_state,''))) and rc.city_norm = private.stef_norm(new.address_city) limit 1;
    if not found then new.region_id := null; end if;
  end if;
  return new;
end $$;
CREATE OR REPLACE FUNCTION private.stef_route_contact(p_contact uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private AS $$
declare v_c public.contacts; v_uf text; v_owner uuid;
begin
  if current_setting('app.stef_skip_routing', true) = '1' then return; end if;
  select * into v_c from public.contacts where id = p_contact;
  if not found then return; end if;
  v_uf := upper(btrim(coalesce(v_c.address_state, '')));
  if v_uf = '' then return; end if;
  if v_uf in ('RS','SC') then
    if v_c.client_origin = 'prospeccao_propria' then update public.contacts set out_of_area = false, out_of_area_at = null where id = p_contact; return; end if;
    select owner_id into v_owner from public.uf_routing_rules where tenant_id = v_c.tenant_id and uf = v_uf;
    update public.contacts set out_of_area = false, out_of_area_at = null, owner_id = coalesce(v_owner, owner_id) where id = p_contact;
    if v_owner is not null then
      update public.deals d set owner_id = v_owner from public.board_stages s join public.boards b on b.id = s.board_id
      where d.contact_id = p_contact and d.stage_id = s.id and d.status = 'open' and b.board_key = 'main' and s.stage_key = 'lead_novo';
    end if;
  else
    update public.contacts set out_of_area = true, out_of_area_at = coalesce(out_of_area_at, now()) where id = p_contact;
  end if;
end $$;

CREATE OR REPLACE FUNCTION private.stef_deals_before() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private AS $$
declare v_board_key text; v_stage_key text; v_sla int; v_bus boolean; v_credit_fields_changed boolean;
begin
  if exists (select 1 from unnest(new.payment_terms_days) as days(day) where day < 0) then raise exception 'Os prazos de pagamento não podem ser negativos.' using errcode = '23514'; end if;
  if tg_op = 'INSERT' and private.stef_current_role() = 'agent' then new.owner_id := (select auth.uid()); end if;
  if tg_op = 'UPDATE' and private.stef_current_role() = 'finance'
     and (to_jsonb(new) - array['credit_condition', 'credit_limit', 'payment_terms_days', 'credit_notes', 'credit_evaluated_at', 'credit_evaluated_by', 'updated_at']::text[]) is distinct from
         (to_jsonb(old) - array['credit_condition', 'credit_limit', 'payment_terms_days', 'credit_notes', 'credit_evaluated_at', 'credit_evaluated_by', 'updated_at']::text[]) then
    raise exception 'Financeiro pode editar somente os campos de crédito; etapa, responsável e demais dados são somente leitura.' using errcode = '42501';
  end if;
  select b.board_key, s.stage_key, s.sla_days, s.sla_business_days into v_board_key, v_stage_key, v_sla, v_bus from public.board_stages s join public.boards b on b.id = s.board_id where s.id = new.stage_id;
  if v_board_key is null then return new; end if;
  if tg_op = 'INSERT' or new.stage_id is distinct from old.stage_id then
    new.stage_due_at := private.stef_compute_due(coalesce(new.stage_entered_at, now()), v_sla, v_bus);
    if v_stage_key = 'ganho' and new.credit_condition is null then raise exception 'Para marcar como Ganho, o Financeiro precisa preencher a condição de crédito.' using errcode = '23514', hint = 'Preencha credit_condition antes de mover para Ganho.'; end if;
    if v_stage_key = 'ganho' and new.first_order_at is null then raise exception 'Para marcar como Ganho, informe a data do 1º pedido faturado.' using errcode = '23514', hint = 'Preencha first_order_at antes de mover para Ganho.'; end if;
  end if;
  v_credit_fields_changed := tg_op = 'INSERT' or new.credit_condition is distinct from old.credit_condition or new.credit_limit is distinct from old.credit_limit or new.payment_terms_days is distinct from old.payment_terms_days or new.credit_notes is distinct from old.credit_notes;
  if new.credit_condition is not null and v_credit_fields_changed and (select auth.uid()) is not null then new.credit_evaluated_at := now(); new.credit_evaluated_by := (select auth.uid()); end if;
  if new.status = 'lost' then
    if new.lost_reason_code is null then raise exception 'Informe o motivo da perda para marcar o negócio como perdido.' using errcode = '23514', hint = 'Preencha lost_reason_code com um dos motivos da lista.'; end if;
    new.lost_reason := coalesce(new.lost_reason, new.lost_reason_code::text);
    if new.lost_reason_code = 'sem_contato' and new.nurture_return_at is null and (tg_op = 'INSERT' or old.status is distinct from 'lost' or old.lost_reason_code is distinct from new.lost_reason_code) then new.nurture_return_at := coalesce(new.closed_at, now()) + interval '75 days'; end if;
    if new.lost_reason_code <> 'sem_contato' then new.nurture_return_at := null; end if;
  end if;
  return new;
end $$;
CREATE OR REPLACE FUNCTION private.stef_credit_after() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private AS $$
declare v_label text;
begin
  if new.credit_condition is null or (tg_op = 'UPDATE' and new.credit_condition is not distinct from old.credit_condition) then return null; end if;
  update public.activities set completed_at = coalesce(completed_at, now()), updated_at = now() where deal_id = new.id and completed_at is null and metadata->>'kind' = 'credit_review';
  v_label := case new.credit_condition when 'a_vista' then 'à vista, sem crédito' when 'credito_aprovado' then 'crédito aprovado' when 'sem_aprovacao' then 'sem aprovação para compra' end;
  perform private.stef_task(new.tenant_id, new.id, new.contact_id, new.owner_id, 'Crédito avaliado: ' || v_label, now(), 'credit_evaluated');
  return null;
end $$;
CREATE TRIGGER zz_stef_credit_after AFTER INSERT OR UPDATE OF credit_condition ON public.deals FOR EACH ROW EXECUTE FUNCTION private.stef_credit_after();
CREATE OR REPLACE FUNCTION private.stef_guard_transition_command() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private AS $$
declare v_role text;
begin
  if new.actor_type <> 'human' then return new; end if;
  v_role := private.stef_current_role();
  if v_role = 'finance' then raise exception 'Financeiro não pode mover etapas nem marcar negócios como ganhos ou perdidos.' using errcode = '42501'; end if;
  if v_role = 'agent' and not private.stef_can_read_deal(new.tenant_id, new.deal_id) then raise exception 'Você só pode mover negócios da sua carteira ou acompanhamento.' using errcode = '42501'; end if;
  if v_role not in ('admin', 'manager', 'agent') then raise exception 'Seu papel não pode mover etapas.' using errcode = '42501'; end if;
  return new;
end $$;
CREATE TRIGGER zz_stef_guard_transition_command BEFORE INSERT ON public.deal_stage_transition_commands FOR EACH ROW EXECUTE FUNCTION private.stef_guard_transition_command();

CREATE OR REPLACE FUNCTION public.reactivate_region(p_region_id uuid, p_cities text[], p_new_owner uuid) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private AS $$
declare v_tenant uuid := private.get_user_tenant_id(); v_stage uuid; v_board uuid; v_n int := 0; r record; v_deal uuid;
begin
  if v_tenant is null then raise exception 'Não autenticado' using errcode = '42501'; end if;
  if private.stef_current_role() not in ('admin', 'manager') then raise exception 'Somente Administrador ou Gestor pode reativar região.' using errcode = '42501'; end if;
  if p_region_id is null and coalesce(array_length(p_cities, 1), 0) = 0 then raise exception 'Informe a região ou as cidades' using errcode = '22023'; end if;
  if not exists (select 1 from public.profiles where id = p_new_owner and tenant_id = v_tenant) then raise exception 'Responsável inválido para este workspace' using errcode = '22023'; end if;
  v_stage := private.stef_stage_id(v_tenant, 'main', 'lead_novo');
  if v_stage is null then raise exception 'Funil principal sem etapa lead_novo' using errcode = 'P0002'; end if;
  select board_id into v_board from public.board_stages where id = v_stage;
  perform set_config('app.stef_skip_routing', '1', true);
  for r in select c.id, c.name from public.contacts c where c.tenant_id = v_tenant and c.out_of_area and c.deleted_at is null and ((p_region_id is not null and c.region_id = p_region_id) or private.stef_norm(c.address_city) = any (select private.stef_norm(x) from unnest(coalesce(p_cities, '{}')) x))
  loop
    update public.contacts set out_of_area = false, out_of_area_at = null, owner_id = p_new_owner where id = r.id;
    select d.id into v_deal from public.deals d where d.contact_id = r.id and d.board_id = v_board and d.status = 'open' order by d.created_at desc limit 1;
    if v_deal is null then
      insert into public.deals (tenant_id, board_id, stage_id, contact_id, title, owner_id) values (v_tenant, v_board, v_stage, r.id, r.name, p_new_owner);
    else
      perform private.stef_move_deal(v_deal, v_stage, 'Reativar região'); update public.deals set owner_id = p_new_owner, contact_attempts = 0 where id = v_deal;
    end if;
    v_deal := null; v_n := v_n + 1;
  end loop;
  perform set_config('app.stef_skip_routing', '', true); return v_n;
end $$;
CREATE OR REPLACE FUNCTION public.mark_out_of_area(p_deal_id uuid, p_note text DEFAULT NULL) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private AS $$
declare v_tenant uuid := private.get_user_tenant_id(); v_contact uuid;
begin
  if v_tenant is null then raise exception 'Não autenticado' using errcode = '42501'; end if;
  if private.stef_current_role() = 'finance' or not private.stef_can_read_deal(v_tenant, p_deal_id) then raise exception 'Você não pode marcar este negócio como fora da área.' using errcode = '42501'; end if;
  select contact_id into v_contact from public.deals where id = p_deal_id and tenant_id = v_tenant;
  if v_contact is null then raise exception 'Negócio não encontrado' using errcode = 'P0002'; end if;
  update public.contacts set out_of_area = true, out_of_area_at = now(), out_of_area_note = coalesce(p_note, out_of_area_note) where id = v_contact;
end $$;
DO $$
declare v_definition text; v_changed text;
begin
  v_definition := pg_get_functiondef('public.dashboard_report(timestamptz,timestamptz,text)'::regprocedure);
  v_changed := replace(v_definition, 'if not private.is_admin() then', 'if not private.has_permission(''analytics.read'') then');
  if v_changed = v_definition then raise exception 'Não foi possível localizar a checagem de acesso do relatório.'; end if;
  execute v_changed;
end $$;
CREATE OR REPLACE FUNCTION public.sync_profile_membership() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private AS $$
declare v_role_id uuid;
begin
  insert into public.roles (tenant_id, role_key, name, is_system) values (new.tenant_id, 'admin', 'Administrador', true), (new.tenant_id, 'manager', 'Gestor', true), (new.tenant_id, 'finance', 'Financeiro', true), (new.tenant_id, 'agent', 'Vendedor', true)
  on conflict (tenant_id, role_key) do update set name = excluded.name;
  insert into public.role_permissions (role_id, permission_id) select r.id, p.id from public.roles r cross join public.permissions p where r.tenant_id = new.tenant_id and r.role_key = 'admin' on conflict do nothing;
  insert into public.role_permissions (role_id, permission_id) select r.id, p.id from public.roles r join public.permissions p on p.permission_key = any(array['crm.contacts.read', 'crm.contacts.write', 'crm.pipeline.read', 'crm.pipeline.write', 'analytics.read', 'crm.deals.credit.write']) where r.tenant_id = new.tenant_id and r.role_key = 'manager' on conflict do nothing;
  insert into public.role_permissions (role_id, permission_id) select r.id, p.id from public.roles r join public.permissions p on p.permission_key = any(array['crm.contacts.read', 'crm.pipeline.read', 'crm.deals.credit.write']) where r.tenant_id = new.tenant_id and r.role_key = 'finance' on conflict do nothing;
  insert into public.role_permissions (role_id, permission_id) select r.id, p.id from public.roles r join public.permissions p on p.permission_key = any(array['crm.contacts.read', 'crm.contacts.write', 'crm.pipeline.read', 'crm.pipeline.write', 'messaging.inbox.read', 'messaging.messages.send', 'automation.read', 'ai.use', 'calendar.use']) where r.tenant_id = new.tenant_id and r.role_key = 'agent' on conflict do nothing;
  select id into v_role_id from public.roles where tenant_id = new.tenant_id and role_key = new.role;
  if v_role_id is not null then
    insert into public.tenant_memberships (tenant_id, user_id, role_id, status, revoked_at) values (new.tenant_id, new.id, v_role_id, case when new.disabled then 'revoked' else 'active' end, case when new.disabled then now() else null end)
    on conflict (tenant_id, user_id) do update set role_id = excluded.role_id, status = excluded.status, revoked_at = excluded.revoked_at, updated_at = now();
  end if;
  return new;
end $$;