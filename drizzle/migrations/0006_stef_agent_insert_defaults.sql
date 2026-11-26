CREATE OR REPLACE FUNCTION private.stef_contacts_before() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private AS $$
declare v_role text;
begin
  if tg_op = 'INSERT' and (select auth.uid()) is not null then
    v_role := private.stef_current_role();
    if v_role = 'agent' then
      new.owner_id := (select auth.uid()); new.opened_by := (select auth.uid()); new.client_origin := 'prospeccao_propria';
    elsif v_role in ('admin', 'manager') then
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

DROP TRIGGER IF EXISTS zz_stef_contacts_before ON public.contacts;
CREATE TRIGGER aa_stef_contacts_before BEFORE INSERT OR UPDATE OF address_city, address_state ON public.contacts FOR EACH ROW EXECUTE FUNCTION private.stef_contacts_before();

DROP POLICY IF EXISTS "contacts role select" ON public.contacts;
CREATE POLICY "contacts role select" ON public.contacts FOR SELECT TO authenticated USING (
  (private.stef_current_role() = 'agent' and tenant_id = (select private.get_active_tenant_id())
    and (select auth.uid()) in (owner_id, portfolio_owner_id, follow_up_owner_id))
  or private.stef_can_read_contact(tenant_id, id));

DROP POLICY IF EXISTS "deals role select" ON public.deals;
CREATE POLICY "deals role select" ON public.deals FOR SELECT TO authenticated USING (
  (private.stef_current_role() = 'agent' and tenant_id = (select private.get_active_tenant_id()) and owner_id = (select auth.uid()))
  or private.stef_can_read_deal(tenant_id, id));