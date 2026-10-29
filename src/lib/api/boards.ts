import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile } from "@/lib/api/session";
import type { Board } from "@/components/pipeline/BoardSwitcher";

/**
 * Lista somente-leitura dos quadros (boards) do tenant atual.
 *
 * Mesma queryKey usada por `_app.pipeline.tsx` (`["boards", tenantId]`) --
 * compartilha cache e é invalidada pelas mutations de criar/renomear/remover
 * quadro em `BoardSwitcher`. Extraído para reuso por telas que só precisam
 * LISTAR quadros para filtrar dados (Dashboard/Relatórios), sem a gestão
 * administrativa (criar/renomear/remover) que continua exclusiva do
 * `BoardSwitcher` no Pipeline.
 */
export function useBoards() {
  const { data: profile } = useCurrentProfile();
  return useQuery<Board[]>({
    queryKey: ["boards", profile?.tenant_id],
    enabled: !!profile?.tenant_id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("boards")
        .select("id, name, is_default, position")
        .order("position");
      if (error) throw error;
      return (data ?? []) as Board[];
    },
  });
}
