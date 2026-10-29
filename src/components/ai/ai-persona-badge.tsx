import { Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";
import { useAiPersona } from "@/hooks/use-ai-persona";

interface AiPersonaBadgeProps {
  /** Tenant explícito (bolha de mensagem já traz `tenant_id`); omitido = tenant da sessão atual. */
  tenantId?: string | null;
  size?: "xs" | "sm";
  className?: string;
}

/**
 * Identidade visual da IA (nome + avatar) compartilhada entre inbox,
 * assistente e insights — centraliza o que no medflow-v0 está espalhado como
 * string literal "Clara" em vários componentes (ver referências do épico D).
 * Antes do tenant configurar `ai_name`, mostra o ícone Sparkles genérico em
 * vez de travar o visual num nome hardcoded.
 */
export function AiPersonaBadge({ tenantId, size = "sm", className }: AiPersonaBadgeProps) {
  const { data: persona } = useAiPersona(tenantId);

  const avatarSizeClass = size === "xs" ? "h-4 w-4 text-[10px]" : "h-5 w-5 text-caption";
  const textSizeClass = size === "xs" ? "text-caption" : "text-body";

  return (
    <span className={cn("inline-flex items-center gap-1 font-medium", textSizeClass, className)}>
      <span
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary",
          avatarSizeClass,
        )}
        aria-hidden="true"
      >
        {persona?.avatarEmoji ??
          (persona?.name ? persona.initials : <Sparkles className="h-3 w-3" />)}
      </span>
      {persona?.name ?? "IA"}
    </span>
  );
}
