DROP POLICY IF EXISTS "ai_feature_catalog select all authenticated" ON public.ai_feature_catalog;
CREATE POLICY "ai_feature_catalog select workspace members" ON public.ai_feature_catalog FOR SELECT TO authenticated
  USING ((SELECT private.get_user_tenant_id()) IS NOT NULL);
DROP POLICY IF EXISTS "integrations read" ON public.integrations;
CREATE POLICY "integrations read workspace members" ON public.integrations FOR SELECT TO authenticated
  USING ((SELECT private.get_user_tenant_id()) IS NOT NULL);
DROP POLICY IF EXISTS "marketplace engine capabilities read" ON public.marketplace_engine_capabilities;
CREATE POLICY "marketplace engine capabilities read workspace members" ON public.marketplace_engine_capabilities FOR SELECT TO authenticated
  USING ((SELECT private.get_user_tenant_id()) IS NOT NULL);
DROP POLICY IF EXISTS "marketplace engine dependencies read" ON public.marketplace_engine_dependencies;
CREATE POLICY "marketplace engine dependencies read workspace members" ON public.marketplace_engine_dependencies FOR SELECT TO authenticated
  USING ((SELECT private.get_user_tenant_id()) IS NOT NULL);
DROP POLICY IF EXISTS "niche_templates read" ON public.niche_templates;
CREATE POLICY "niche_templates read workspace members" ON public.niche_templates FOR SELECT TO authenticated
  USING ((SELECT private.get_user_tenant_id()) IS NOT NULL);
DROP POLICY IF EXISTS "permissions authenticated read" ON public.permissions;
CREATE POLICY "permissions read workspace members" ON public.permissions FOR SELECT TO authenticated
  USING ((SELECT private.get_user_tenant_id()) IS NOT NULL);