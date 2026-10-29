import { useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Bell, LogOut, Moon, Sparkles, Sun, User } from "lucide-react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { InitialsAvatar } from "@/components/common/InitialsAvatar";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { GlobalPeriodPicker } from "@/components/common/GlobalPeriodPicker";
import { AiAssistantPanel } from "@/components/ai/AiAssistantPanel";
import { useCurrentProfile } from "@/lib/api/session";
import { useDecisionQueue } from "@/hooks/use-decision-queue";
import { useHumanAttentionCount } from "@/lib/api/human-attention";
import { useRecentAiFailureCount } from "@/lib/api/ai-failure-logs";
import { supabase } from "@/integrations/supabase/client";
import { isDarkSkin } from "@/lib/appearance-boot";
import { useAppearance } from "@/lib/useAppearance";
import { WorkspaceSwitcher } from "@/components/layout/WorkspaceSwitcher";
import { useWorkspaces } from "@/lib/api/workspaces";
import { useTenantRecord } from "@/lib/api/tenant-brand";
import { toast } from "sonner";
import { setClientAuthTransition } from "@/lib/client-error-telemetry";

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface";

function ThemeToggle() {
  const { theme, skin, setTheme } = useAppearance();
  const isDark = theme === "dark";
  // Sob Profundo/Power a tela é escura de qualquer jeito: manter o botão vivo
  // seria um clique que troca o ícone e não muda nada. Mesma decisão da aba
  // Aparência, que explica o porquê em texto.
  const skinFixaOTema = isDarkSkin(skin);
  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      disabled={skinFixaOTema}
      title={
        skinFixaOTema
          ? "O Visual escolhido em Configurações tem campo escuro próprio e fixa o tema"
          : undefined
      }
      aria-label={isDark ? "Mudar para tema claro" : "Mudar para tema escuro"}
      aria-pressed={isDark}
      className={`flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50 ${FOCUS_RING}`}
    >
      {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}

function AiAssistantButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label="Abrir assistente IA"
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-controls="ai-assistant-panel"
      className={`flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground aria-expanded:bg-primary/15 aria-expanded:text-primary ${FOCUS_RING}`}
    >
      <Sparkles className="h-4 w-4" />
    </button>
  );
}

function NotificationsBell({ tenantId }: { tenantId: string | null }) {
  const { items: pendingDecisions } = useDecisionQueue();
  const attentionCount = useHumanAttentionCount(tenantId);
  const aiFailureCount = useRecentAiFailureCount();
  const decisionCount = pendingDecisions.length;
  const total = decisionCount + attentionCount + aiFailureCount;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={total > 0 ? `Notificações (${total} pendentes)` : "Notificações"}
          className={`relative flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground ${FOCUS_RING}`}
        >
          <Bell className="h-4 w-4" />
          {total > 0 && (
            <Badge
              variant="destructive"
              className="absolute right-1 top-1 h-4 min-w-4 justify-center rounded-full border-none px-1 text-[10px] leading-none"
            >
              {total > 99 ? "99+" : total}
            </Badge>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex flex-col gap-1">
        <p className="mb-1 text-body font-medium text-foreground">Notificações</p>
        {total === 0 ? (
          <p className="text-caption text-muted-foreground">Nenhuma notificação pendente</p>
        ) : (
          <>
            {decisionCount > 0 && (
              <Link
                to="/decisions"
                className={`flex items-center justify-between rounded-md px-2 py-1.5 text-body hover:bg-muted ${FOCUS_RING}`}
              >
                <span>Decisões aguardando revisão</span>
                <Badge variant="secondary">{decisionCount}</Badge>
              </Link>
            )}
            {attentionCount > 0 && (
              <Link
                to="/inbox"
                className={`flex items-center justify-between rounded-md px-2 py-1.5 text-body hover:bg-muted ${FOCUS_RING}`}
              >
                <span>Conversas aguardando humano</span>
                <Badge variant="secondary">{attentionCount}</Badge>
              </Link>
            )}
            {aiFailureCount > 0 && (
              <Link
                to="/configuracoes"
                hash="ia/falhas"
                className={`flex items-center justify-between rounded-md px-2 py-1.5 text-body hover:bg-muted ${FOCUS_RING}`}
              >
                <span>Falhas recentes de IA</span>
                <Badge variant="destructive">{aiFailureCount}</Badge>
              </Link>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function AppTopbar() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const profileQ = useCurrentProfile();
  const profile = profileQ.data;
  const workspacesQ = useWorkspaces();
  const workspaces = workspacesQ.data ?? [];
  const activeWorkspace = workspaces.find((workspace) => workspace.is_active);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);

  const tenantId = activeWorkspace?.tenant_id ?? profile?.tenant_id;
  // Mesmo registro (e mesmas colunas) que a marca/tema usam: uma consulta só.
  const tenantQ = useTenantRecord(tenantId);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!tenantQ.data?.logo_url) {
        setLogoUrl(null);
        return;
      }
      const { data } = await supabase.storage
        .from("logos")
        .createSignedUrl(tenantQ.data.logo_url, 3600);
      if (!cancelled) setLogoUrl(data?.signedUrl ?? null);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [tenantQ.data?.logo_url]);

  const displayName = profile?.name ?? "";
  // Marca padrão só quando já se sabe que não há nome; carregando → texto neutro.
  const isTenantLoading =
    !!profileQ.isPending || !!workspacesQ.isPending || (!!tenantId && tenantQ.isPending);
  const tenantName =
    activeWorkspace?.tenant_name ??
    tenantQ.data?.name ??
    (isTenantLoading ? "Carregando…" : "CRM IA");

  async function handleSignOut() {
    if (isSigningOut) return;
    setIsSigningOut(true);
    setClientAuthTransition("signing_out");
    try {
      // Interrompe leituras protegidas antes de a sessão virar anônima. Sem
      // essa ordem, um observer ainda montado pode repetir a consulta entre o
      // SIGNED_OUT e a navegação e receber 42501 do RLS.
      await queryClient.cancelQueries();
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      queryClient.clear();
      await navigate({ to: "/auth", replace: true });
      setClientAuthTransition("stable");
    } catch {
      setClientAuthTransition("stable");
      setIsSigningOut(false);
      toast.error("Não foi possível sair. Tente novamente.");
    }
  }

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-surface px-2 backdrop-blur-md sm:gap-3 sm:px-4">
      <SidebarTrigger aria-label="Alternar menu lateral" />
      <Separator orientation="vertical" className="hidden h-6 sm:block" />
      <div className="flex min-w-0 items-center gap-2">
        {logoUrl && (
          <img src={logoUrl} alt="" aria-hidden className="h-6 w-6 shrink-0 rounded object-cover" />
        )}
        <WorkspaceSwitcher />
        <span className="sr-only">{tenantName}</span>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
        <GlobalPeriodPicker />
        <AiAssistantButton open={aiOpen} onToggle={() => setAiOpen((v) => !v)} />
        <ThemeToggle />
        <NotificationsBell tenantId={profile?.tenant_id ?? null} />
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={displayName ? `Menu de ${displayName}` : "Abrir menu do usuário"}
            className={`flex items-center gap-2 rounded-md px-1 py-1 text-body hover:bg-muted sm:px-2 ${FOCUS_RING}`}
          >
            <InitialsAvatar name={displayName} variant="brand" size="md" />
            <span className="hidden max-w-32 truncate font-medium text-foreground xl:inline">
              {displayName || "Minha conta"}
            </span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>
              <div className="text-body font-medium">{displayName || "Minha conta"}</div>
              {profile?.role && (
                <div className="text-caption font-normal text-muted-foreground">
                  {profile.role === "admin" ? "Administrador" : "Atendente"}
                </div>
              )}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link to="/perfil">
                <User className="mr-2 h-4 w-4" />
                Editar perfil
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem disabled={isSigningOut} onClick={handleSignOut}>
              <LogOut className="mr-2 h-4 w-4" />
              {isSigningOut ? "Saindo..." : "Sair"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <AiAssistantPanel open={aiOpen} onOpenChange={setAiOpen} />
    </header>
  );
}
