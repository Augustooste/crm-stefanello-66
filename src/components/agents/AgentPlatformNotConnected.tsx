import { Unplug } from "lucide-react";
import { Link } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/common/EmptyState";

/**
 * Estado exibido quando o tenant ainda não conectou o provedor de agentes (ou a conexão
 * existe mas não está ativa). A credencial (token do provedor de agentes) só é
 * cadastrada na integração já existente, em Configurações > Integrações e
 * Plugins — esta área de Agentes nunca pede token diretamente.
 */
export function AgentPlatformNotConnected() {
  return (
    <div className="col-span-12 flex flex-col items-center gap-4">
      <EmptyState
        icon={Unplug}
        title="provedor de agentes não conectado"
        description="Para usar a área de Agentes de IA, conecte o provedor de agentes em Configurações > Integrações e Plugins. O token de acesso é cadastrado só lá — esta tela não pede credencial."
      />
      <Button asChild variant="secondary">
        <Link to="/configuracoes" hash="plugins">
          Ir para Integrações e Plugins
        </Link>
      </Button>
    </div>
  );
}
