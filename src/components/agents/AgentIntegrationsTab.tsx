// Aba "Integrações" do agente provedor de agentes.
//
// Duas seções sempre separadas na tela:
//
// 1) Integrações nativas do provedor de agentes (ElevenLabs, Google Agenda, Plug Chat
//    e E-Vendi). A API pública do provedor de agentes não expõe NENHUM endpoint para
//    essas quatro — ver contracts/agent-platform/CONTRACT_MATRIX.md §1.6. Por
//    isso esta seção NUNCA inventa endpoint, nunca faz scraping do painel,
//    nunca mostra "conectado" e nunca tem formulário de credencial: só o
//    aviso de indisponibilidade, deixando claro que a limitação é da API
//    pública, não do produto provedor de agentes nem do CRM IA.
//
// 2) MCPs conectados por API (mcp.add / mcp.connect / mcp.tools.* /
//    mcp.delete — esses SIM existem no contrato). O contrato não tem
//    endpoint que liste as conexões MCP de um agente, só operações por
//    `mcpId` — então a tela trabalha com UMA conexão em foco por vez: a que
//    acabou de ser criada, ou outra cujo `mcpId` o usuário cole manualmente.
// Nenhuma chamada direta à API do provedor — tudo via useAgentPlatformMutation.
import { useState } from "react";
import { toast } from "sonner";
import { Check, Copy, ExternalLink, Info, Plug, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useAgentPlatformMutation } from "@/lib/api/agent-platform";
import { McpConnectionForm } from "./McpConnectionForm";
import { McpToolsList } from "./McpToolsList";

const AGENT_PLATFORM_PANEL_URL = "https://app.agent-platform.ai";

// Mensagem exigida verbatim para as quatro integrações nativas — não varia
// por integração, porque a causa (API pública sem endpoint) também não varia.
const UNAVAILABLE_MESSAGE =
  "Configuração não disponibilizada pela API pública do provedor de agentes. Gerencie esta integração diretamente no provedor de agentes.";

interface NativeIntegration {
  slug: string;
  name: string;
  description: string;
}

const NATIVE_INTEGRATIONS: NativeIntegration[] = [
  {
    slug: "elevenlabs",
    name: "ElevenLabs",
    description: "Faz o agente responder por áudio com vozes geradas pela ElevenLabs.",
  },
  {
    slug: "google-agenda",
    name: "Google Agenda",
    description: "Deixa o agente consultar e criar eventos na agenda do Google do negócio.",
  },
  {
    slug: "plug-chat",
    name: "Plug Chat",
    description: "Conecta o agente ao Plug Chat para atendimento em outros canais do provedor.",
  },
  {
    slug: "e-vendi",
    name: "E-Vendi",
    description: "Integra o agente ao catálogo e checkout do E-Vendi.",
  },
];

interface FocusedMcp {
  mcpId: string;
  name: string;
}

export function AgentIntegrationsTab({ agentId }: { agentId: string }) {
  const [focused, setFocused] = useState<FocusedMcp | null>(null);
  const [manualMcpId, setManualMcpId] = useState("");
  const [manualLabel, setManualLabel] = useState("");
  const [copied, setCopied] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const deleteMut = useAgentPlatformMutation("mcp.delete", {
    invalidate: ["mcp.tools.list"],
    onSuccess: () => {
      toast.success("Conexão MCP excluída.");
      setFocused(null);
    },
    onError: (error) => toast.error(error.message),
  });

  function handleManageExisting() {
    const trimmed = manualMcpId.trim();
    if (!trimmed) return;
    setFocused({ mcpId: trimmed, name: manualLabel.trim() || "Conexão MCP" });
    setManualMcpId("");
    setManualLabel("");
  }

  function handleCopyId() {
    if (!focused) return;
    void navigator.clipboard.writeText(focused.mcpId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-card-title">
            Integrações nativas do provedor de agentes
          </CardTitle>
          <CardDescription>
            Elas existem no painel do provedor de agentes, mas a API pública dele não expõe endpoint
            para ler nem configurar nenhuma das quatro — a limitação é da API pública, não do
            produto.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {NATIVE_INTEGRATIONS.map((integration) => (
              <div
                key={integration.slug}
                data-testid={`native-integration-${integration.slug}`}
                className="flex flex-col gap-2 rounded-lg border border-border p-4"
              >
                <p className="font-medium text-foreground">{integration.name}</p>
                <p className="text-caption text-muted-foreground">{integration.description}</p>
                <div className="flex items-start gap-2 rounded-md border border-border bg-surface p-3 text-caption text-muted-foreground">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span>{UNAVAILABLE_MESSAGE}</span>
                </div>
                <Button variant="outline" size="sm" className="w-fit" asChild>
                  <a href={AGENT_PLATFORM_PANEL_URL} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                    Abrir painel do provedor de agentes
                  </a>
                </Button>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-card-title">
            <Plug className="h-4 w-4" aria-hidden />
            MCPs conectados por API
          </CardTitle>
          <CardDescription>
            A API pública do provedor de agentes não tem endpoint que liste as conexões MCP de um
            agente — só operações por identificador (mcpId). Por isso esta tela mostra uma conexão
            por vez: a que você acabou de criar, ou outra cujo identificador você cole abaixo.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {focused ? (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-surface p-3">
                <div className="min-w-0">
                  <p className="font-medium text-foreground">{focused.name}</p>
                  <div className="flex items-center gap-1.5">
                    <code
                      className="break-all font-mono text-caption text-muted-foreground"
                      title={focused.mcpId}
                    >
                      {focused.mcpId}
                    </code>
                    <button
                      type="button"
                      aria-label={copied ? "Identificador copiado" : "Copiar identificador"}
                      onClick={handleCopyId}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      {copied ? (
                        <Check className="h-3.5 w-3.5 text-success" aria-hidden />
                      ) : (
                        <Copy className="h-3.5 w-3.5" aria-hidden />
                      )}
                    </button>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setFocused(null)}>
                    Trocar conexão
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => setConfirmingDelete(true)}
                    disabled={deleteMut.isPending}
                  >
                    <Trash2 className="mr-1 h-3.5 w-3.5" aria-hidden />
                    Excluir conexão
                  </Button>
                </div>
              </div>

              <McpToolsList agentId={agentId} mcpId={focused.mcpId} />
            </div>
          ) : (
            <div className="flex flex-col gap-6">
              <McpConnectionForm
                agentId={agentId}
                onConnected={(mcpId, name) => setFocused({ mcpId, name })}
              />

              <div className="flex flex-col gap-2 border-t border-border pt-4">
                <Label htmlFor="mcp-manual-id">Gerenciar uma conexão MCP já existente</Label>
                <p className="text-caption text-muted-foreground">
                  Se você já tem o identificador (mcpId) de uma conexão criada antes, cole aqui para
                  listar, ativar ou inativar as ferramentas dela, ou para excluí-la. O rótulo abaixo
                  é só para esta tela — o provedor de agentes não devolve nome de conexão.
                </p>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    id="mcp-manual-id"
                    placeholder="Identificador da conexão (mcpId)"
                    value={manualMcpId}
                    onChange={(e) => setManualMcpId(e.target.value)}
                  />
                  <Input
                    aria-label="Rótulo (opcional)"
                    placeholder="Rótulo (opcional)"
                    value={manualLabel}
                    onChange={(e) => setManualLabel(e.target.value)}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleManageExisting}
                    disabled={!manualMcpId.trim()}
                  >
                    Gerenciar
                  </Button>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir conexão MCP?</AlertDialogTitle>
            <AlertDialogDescription>
              Isso remove a conexão "{focused?.name}" no provedor de agentes. As ferramentas dela
              deixam de estar disponíveis para o agente. Esta ação não pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmingDelete(false);
                if (focused) deleteMut.mutate({ params: { agentId, mcpId: focused.mcpId } });
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
