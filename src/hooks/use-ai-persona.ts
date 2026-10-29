import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile } from "@/lib/api/session";

export interface AiPersona {
  name: string;
  avatarEmoji: string | null;
  initials: string;
}

const DEFAULT_NAME = "Assistente Virtual";

function computeInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "IA";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/**
 * Persona de IA do tenant — nome/emoji configuráveis em ai_settings
 * (Card "Persona da IA" em Assistente/Configurações). Sempre resolve para um
 * valor exibível (nunca null): sem configuração, cai em
 * "Assistente {tenant.name}" (ou o default genérico sem tenant).
 *
 * `tenantId` é opcional — quando omitido, resolve do perfil da sessão atual
 * (mesmo padrão dos outros hooks de ai_settings do projeto). queryKey
 * compartilhada entre todos os consumidores (badges no inbox/assistente/
 * insights) evita 1 query por bolha de mensagem no thread.
 */
export function useAiPersona(tenantId?: string | null) {
  const { data: profile } = useCurrentProfile();
  const resolvedTenantId = tenantId ?? profile?.tenant_id ?? null;

  return useQuery({
    queryKey: ["ai-persona", resolvedTenantId],
    enabled: !!resolvedTenantId,
    staleTime: 10 * 60 * 1000,
    queryFn: async (): Promise<AiPersona> => {
      const [settingsRes, tenantRes] = await Promise.all([
        supabase
          .from("ai_settings")
          .select("ai_name, ai_avatar_emoji")
          .eq("tenant_id", resolvedTenantId!)
          .maybeSingle(),
        supabase.from("tenants").select("name").eq("id", resolvedTenantId!).maybeSingle(),
      ]);
      if (settingsRes.error) throw settingsRes.error;
      if (tenantRes.error) throw tenantRes.error;

      const tenantName = tenantRes.data?.name;
      const name =
        settingsRes.data?.ai_name || (tenantName ? `Assistente ${tenantName}` : DEFAULT_NAME);
      const avatarEmoji = settingsRes.data?.ai_avatar_emoji ?? null;

      return { name, avatarEmoji, initials: computeInitials(name) };
    },
  });
}
