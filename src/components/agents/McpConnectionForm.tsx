// Formulário de criação de conexão MCP e, quando necessário, conclusão do
// fluxo OAuth.
//
// mcp.add — POST /v2/agent/{agentId}/mcp/add — corpo { name, description,
// mcpUrl, urlType, authType, headers? }. Resposta { connected, success, id,
// url } (todos os campos opcionais no contrato).
//
// Quando a resposta trouxer `url`, a conexão exige autorização OAuth: só
// termina com POST /v2/mcp/connect (`mcp.connect`), corpo { code, state }.
// Esses dois valores vêm da URL para onde o PRÓPRIO PROVEDOR MCP redireciona
// depois da autorização — o CRM IA não registra rota de callback nesse
// fluxo, então o usuário copia `code`/`state` manualmente da barra de
// endereço da página de retorno e cola aqui.
//
// Decide o próximo passo pela PRESENÇA de `url`/`id` na resposta, nunca pelo
// `authType` escolhido no formulário — o contrato não garante que todo
// OAUTH devolva `url` nem que todo NO_OAUTH/HEADERS devolva `id` de imediato.
import { useState } from "react";
import { toast } from "sonner";
import { ExternalLink, Loader2, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAgentPlatformMutation } from "@/lib/api/agent-platform";
import type { AgentPlatformRequestBody } from "@/lib/api/agent-platform-contract";
import {
  MCP_AUTH_TYPES,
  MCP_URL_TYPES,
  type McpAuthType,
  type McpUrlType,
} from "@/integrations/agent-platform/enums.gen";

const URL_TYPE_LABELS: Record<McpUrlType, string> = {
  SSE: "SSE (Server-Sent Events)",
  STREAMABLEHTTP: "HTTP em streaming (Streamable HTTP)",
};

const AUTH_TYPE_LABELS: Record<McpAuthType, string> = {
  NO_OAUTH: "Sem autenticação",
  OAUTH: "OAuth",
  HEADERS: "Cabeçalhos customizados",
};

interface HeaderPair {
  key: string;
  value: string;
}

function isValidUrl(value: string): boolean {
  if (!value) return false;
  try {
    return !!new URL(value);
  } catch {
    return false;
  }
}

interface FormState {
  name: string;
  description: string;
  mcpUrl: string;
  urlType: McpUrlType;
  authType: McpAuthType;
}

const INITIAL_FORM: FormState = {
  name: "",
  description: "",
  mcpUrl: "",
  urlType: MCP_URL_TYPES[0],
  authType: MCP_AUTH_TYPES[0],
};

interface OAuthPending {
  url: string;
  name: string;
}

export function McpConnectionForm({
  agentId,
  onConnected,
}: {
  agentId: string;
  onConnected: (mcpId: string, name: string) => void;
}) {
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [headers, setHeaders] = useState<HeaderPair[]>([]);
  const [oauth, setOauth] = useState<OAuthPending | null>(null);
  const [code, setCode] = useState("");
  const [authState, setAuthState] = useState("");

  const addMut = useAgentPlatformMutation("mcp.add", { invalidate: [] });
  const connectMut = useAgentPlatformMutation("mcp.connect", { invalidate: [] });

  const urlValid = isValidUrl(form.mcpUrl);
  const canSubmit = form.name.trim() !== "" && form.description.trim() !== "" && urlValid;

  function patchHeader(index: number, patch: Partial<HeaderPair>) {
    setHeaders((prev) => prev.map((h, i) => (i === index ? { ...h, ...patch } : h)));
  }

  function submitCreate() {
    if (!canSubmit) return;

    const cleanHeaders = headers.filter((h) => h.key.trim() !== "");
    // O contrato tipa `headers` como objeto sem propriedades declaradas
    // (openapi.json só diz `type: object`, sem chave/valor) — o gerador
    // produz `Record<string, never>`. Monta o record explicitamente (sem
    // `Object.fromEntries`, cujo overload cai em `any` para pares
    // `string[]`) e faz um cast único e comentado na borda de envio, no
    // mesmo padrão de AgentSettingsTab.buildUpdatePayload (D4): nunca
    // `any`, e só quando o usuário realmente escolheu HEADERS.
    const headerRecord: Record<string, string> = {};
    for (const h of cleanHeaders) headerRecord[h.key.trim()] = h.value;
    const body: AgentPlatformRequestBody<"mcp.add"> = {
      name: form.name.trim(),
      description: form.description.trim(),
      mcpUrl: form.mcpUrl.trim(),
      urlType: form.urlType,
      authType: form.authType,
      ...(form.authType === "HEADERS" && cleanHeaders.length > 0
        ? { headers: headerRecord as AgentPlatformRequestBody<"mcp.add">["headers"] }
        : {}),
    };

    addMut.mutate(
      { params: { agentId }, body },
      {
        onSuccess: (data) => {
          if (data.url) {
            setOauth({ url: data.url, name: form.name.trim() });
            return;
          }
          if (form.authType === "OAUTH") {
            // OAuth foi escolhido mas a resposta não trouxe a URL de
            // autorização — a conexão NÃO está pronta e a UI não pode
            // afirmar sucesso. Se sobrou um `id` órfão, mantém em foco só
            // para o usuário poder inspecionar/excluir, nunca como "conectado".
            toast.error(
              "O provedor de agentes não devolveu a URL de autorização OAuth. Confira esta conexão diretamente no painel do provedor de agentes.",
            );
            if (data.id) onConnected(data.id, form.name.trim());
            return;
          }
          if (data.id) {
            toast.success("Conexão MCP criada.");
            onConnected(data.id, form.name.trim());
            return;
          }
          toast.error("O provedor de agentes não retornou identificador nem URL de autorização.");
        },
        onError: (error) => toast.error(error.message),
      },
    );
  }

  function submitOAuthCompletion() {
    if (!oauth || !code.trim() || !authState.trim()) return;
    connectMut.mutate(
      { body: { code: code.trim(), state: authState.trim() } },
      {
        onSuccess: (data) => {
          if (data.mcpId) {
            toast.success("Conexão MCP autorizada.");
            onConnected(data.mcpId, oauth.name);
            return;
          }
          toast.error("O provedor de agentes não retornou o identificador da conexão.");
        },
        onError: (error) => toast.error(error.message),
      },
    );
  }

  if (oauth) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submitOAuthCompletion();
        }}
        className="flex flex-col gap-3 rounded-md border border-border p-4"
      >
        <p className="font-medium text-foreground">Autorize o acesso no provedor MCP</p>
        <p className="text-caption text-muted-foreground">
          Esta conexão exige OAuth. Abra o link abaixo, autorize o CRM IA no provedor e, na página
          de retorno, copie os valores <code>code</code> e <code>state</code> da URL para os campos
          abaixo.
        </p>
        <Button variant="outline" size="sm" className="w-fit" asChild>
          <a href={oauth.url} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            Abrir URL de autorização
          </a>
        </Button>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="mcp-oauth-code">code</Label>
            <Input id="mcp-oauth-code" value={code} onChange={(e) => setCode(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mcp-oauth-state">state</Label>
            <Input
              id="mcp-oauth-state"
              value={authState}
              onChange={(e) => setAuthState(e.target.value)}
            />
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => setOauth(null)}
            disabled={connectMut.isPending}
          >
            Cancelar
          </Button>
          <Button
            type="submit"
            disabled={!code.trim() || !authState.trim() || connectMut.isPending}
          >
            {connectMut.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
            Concluir autorização
          </Button>
        </div>
      </form>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submitCreate();
      }}
      className="flex flex-col gap-4"
    >
      <p className="font-medium text-foreground">Conectar um novo MCP</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="mcp-name">Nome</Label>
          <Input
            id="mcp-name"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="mcp-url-type">Tipo de URL</Label>
          <Select
            value={form.urlType}
            onValueChange={(v) => setForm((f) => ({ ...f, urlType: v as McpUrlType }))}
          >
            <SelectTrigger id="mcp-url-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MCP_URL_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {URL_TYPE_LABELS[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="mcp-description">Descrição</Label>
          <Textarea
            id="mcp-description"
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="mcp-url">URL de conexão MCP</Label>
          <Input
            id="mcp-url"
            placeholder="https://exemplo.com/sse"
            value={form.mcpUrl}
            onChange={(e) => setForm((f) => ({ ...f, mcpUrl: e.target.value }))}
            aria-invalid={form.mcpUrl !== "" && !urlValid}
          />
          {form.mcpUrl !== "" && !urlValid && (
            <p className="text-caption text-destructive">Informe uma URL válida.</p>
          )}
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="mcp-auth-type">Autenticação</Label>
          <Select
            value={form.authType}
            onValueChange={(v) => setForm((f) => ({ ...f, authType: v as McpAuthType }))}
          >
            <SelectTrigger id="mcp-auth-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MCP_AUTH_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {AUTH_TYPE_LABELS[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {form.authType === "HEADERS" && (
        <div className="flex flex-col gap-2 rounded-md border border-border p-3">
          <div className="flex items-center justify-between">
            <Label>Cabeçalhos</Label>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setHeaders((h) => [...h, { key: "", value: "" }])}
            >
              <Plus className="mr-1 h-3.5 w-3.5" aria-hidden />
              Adicionar cabeçalho
            </Button>
          </div>
          {headers.length === 0 && (
            <p className="text-caption text-muted-foreground">Nenhum cabeçalho adicionado.</p>
          )}
          {headers.map((h, i) => (
            <div key={i} className="flex gap-2">
              <Input
                aria-label="Nome do cabeçalho"
                placeholder="Nome"
                value={h.key}
                onChange={(e) => patchHeader(i, { key: e.target.value })}
              />
              <Input
                aria-label="Valor do cabeçalho"
                placeholder="Valor"
                value={h.value}
                onChange={(e) => patchHeader(i, { value: e.target.value })}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Remover cabeçalho"
                onClick={() => setHeaders((prev) => prev.filter((_, idx) => idx !== i))}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="flex justify-end">
        <Button type="submit" disabled={!canSubmit || addMut.isPending}>
          {addMut.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
          Criar conexão
        </Button>
      </div>
    </form>
  );
}
