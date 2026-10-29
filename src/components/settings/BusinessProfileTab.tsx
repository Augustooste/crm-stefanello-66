import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile } from "@/lib/api/session";
import { userFacingErrorMessage } from "@/lib/integrations/friendly-errors";
import {
  BusinessProfileForm,
  emptyBusinessProfile,
  normalizeBusinessProfile,
  type BusinessProfile,
} from "./BusinessProfileForm";

export function BusinessProfileTab() {
  const { data: profile } = useCurrentProfile();
  const qc = useQueryClient();
  const tenantId = profile?.tenant_id;
  const [value, setValue] = useState<BusinessProfile>(emptyBusinessProfile());

  const tenantQ = useQuery({
    queryKey: ["tenant-business-profile", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenants")
        .select("business_profile")
        .eq("id", tenantId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  useEffect(() => {
    if (tenantQ.data) setValue(normalizeBusinessProfile(tenantQ.data.business_profile));
  }, [tenantQ.data]);

  const save = useMutation({
    mutationFn: async () => {
      if (!tenantId) throw new Error("Tenant inválido");
      const { error } = await supabase
        .from("tenants")
        .update({ business_profile: JSON.parse(JSON.stringify(value)) })
        .eq("id", tenantId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Perfil do negócio salvo");
      qc.invalidateQueries({ queryKey: ["tenant-business-profile"] });
    },
    onError: (e: Error) => toast.error(userFacingErrorMessage(e, "Erro ao salvar")),
  });

  if (tenantQ.isLoading) return <Skeleton className="h-96 w-full" />;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-card-title">Perfil do negócio</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <BusinessProfileForm value={value} onChange={setValue} />
        <div className="flex justify-end">
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? "Salvando…" : "Salvar perfil"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
