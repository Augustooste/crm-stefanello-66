import { Link } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile } from "@/lib/api/session";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function SimulatorChannelCard({ connected }: { connected: boolean }) {
  const { data: profile } = useCurrentProfile();
  const queryClient = useQueryClient();
  const create = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("channel-simulator", {
        body: { action: "create" },
      });
      if (error) throw error;
      if (!data?.ok)
        throw new Error(data?.error ?? "Não foi possível ativar o canal de demonstração.");
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tenant-channels", profile?.tenant_id] }),
        queryClient.invalidateQueries({ queryKey: ["tenant-integrations", profile?.tenant_id] }),
        queryClient.invalidateQueries({ queryKey: ["simulator-channel", profile?.tenant_id] }),
        queryClient.invalidateQueries({ queryKey: ["tenant-ai-features"] }),
      ]);
      toast.success("Canal de demonstração ativado. Abra o inbox e escolha Nova simulação.");
    },
    onError: () =>
      toast.error(
        "Não foi possível ativar a demonstração. Confira sua permissão de administrador e tente novamente.",
      ),
  });
  return (
    <Card data-integration-card="simulator">
      <CardHeader>
        <CardTitle className="text-card-title">Canal de demonstração</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          SIMULAÇÃO: envia como cliente e recebe a resposta real da IA no inbox. Nada é entregue no
          WhatsApp. Consome uso de IA; não precisa de credenciais de mensageria.
        </p>
        {connected && (
          <Button variant="outline" asChild>
            <Link to="/inbox" search={{ mode: "lista" }}>
              Abrir inbox
            </Link>
          </Button>
        )}
        {profile?.role === "admin" ? (
          <Button onClick={() => create.mutate()} disabled={create.isPending}>
            {create.isPending ? "Ativando demonstração..." : "Canal de demonstração"}
          </Button>
        ) : !connected ? (
          <p className="text-caption text-muted-foreground">
            Peça a um administrador para ativar a demonstração.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
