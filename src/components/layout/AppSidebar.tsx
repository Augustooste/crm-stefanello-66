import { Link, useRouterState } from "@tanstack/react-router";
import { AGENTES_IA_HABILITADO } from "@/lib/feature-flags";
import {
  LayoutDashboard,
  KanbanSquare,
  Inbox,
  Users,
  CalendarClock,
  ListChecks,
  BarChart3,
  Settings,
  Zap,
  Workflow,
  HelpCircle,
  Bot,
  Megaphone,
  type LucideIcon,
} from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { useCurrentProfile } from "@/lib/api/session";
import { useHumanAttentionCount } from "@/lib/api/human-attention";
import { useTenantBrand } from "@/lib/api/tenant-brand";
import { useActivePlugins } from "@/lib/api/plugins";
import { useMyCapabilities } from "@/lib/api/entitlements";
import { engineRegistry } from "@/engines/registry";
import { resolveEngineNavigation } from "@/kernel/engines/registry";

type NavItem = {
  title: string;
  url: string;
  icon: LucideIcon;
  admin: boolean;
  // Não há campo `plugin` aqui: quem filtra item por plugin ativo no tenant é o
  // `resolveEngineNavigation`, que só devolve os itens das engines ligadas.
  group: "Operação" | "Automação e IA" | "Gestão";
};

const agentesItem: NavItem = {
  title: "Agentes IA",
  url: "/agentes",
  icon: Bot,
  admin: true,
  group: "Automação e IA",
};

const baseItems: NavItem[] = [
  { title: "Visão geral", url: "/app", icon: LayoutDashboard, admin: false, group: "Operação" },
  { title: "Funil", url: "/pipeline", icon: KanbanSquare, admin: false, group: "Operação" },
  { title: "Conversas", url: "/inbox", icon: Inbox, admin: false, group: "Operação" },
  { title: "Contatos", url: "/contatos", icon: Users, admin: false, group: "Operação" },
  { title: "Atividades", url: "/atividades", icon: CalendarClock, admin: false, group: "Operação" },
  // Aprovar/rejeitar uma sugestão da IA é ação normal de operação (qualquer
  // membro do tenant faz), não administração — por isso admin: false, ao
  // contrário de Relatórios/Configurações/etc. abaixo.
  { title: "Decisões", url: "/decisions", icon: ListChecks, admin: false, group: "Automação e IA" },
  // Navegação visível a todos os papéis (mesmo critério de "Decisões" acima)
  // -- só as ações de escrita DENTRO da página (criar sequence, editar step)
  // são admin-gated, não o acesso à página em si.
  {
    title: "Acompanhamento automático",
    url: "/nurture",
    icon: Workflow,
    admin: false,
    group: "Automação e IA",
  },
  // Assistente IA/Falhas de IA/Digest Semanal/Integrações saíram do sidebar:
  // viraram abas dentro de Configurações (menos telas de rotina, mais telas de
  // configuração agrupadas num só lugar -- ver AiAssistantTab/AiFailuresTab/
  // NotificationsTab/PluginsTab).
  // Campanhas (/templates: campanhas + modelos) voltou ao menu quando o
  // broadcast ficou completo (canal na campanha, estimativa de público,
  // confirmação, cron ligado). Admin-only, igual ao beforeLoad da rota e à RLS
  // de escrita de template_schedules.
  {
    title: "Campanhas",
    url: "/templates",
    icon: Megaphone,
    admin: true,
    group: "Automação e IA",
  },
  // "Formulários" (/formularios) saiu do menu por decisão de produto: nenhuma
  // outra tela linka para lá. A rota continua funcionando por URL.
  // Área de agentes do provedor externo: fora do ar por decisão de produto (ver
  // AGENTES_IA_HABILITADO). Some do menu E a rota redireciona -- só esconder o
  // item deixaria o deep-link /agentes servindo tela branca no SSR.
  ...(AGENTES_IA_HABILITADO ? [agentesItem] : []),
  { title: "Relatórios", url: "/relatorios", icon: BarChart3, admin: true, group: "Gestão" },
  { title: "Configurações", url: "/configuracoes", icon: Settings, admin: true, group: "Gestão" },
  { title: "Ajuda", url: "/ajuda", icon: HelpCircle, admin: false, group: "Gestão" },
];

export function AppSidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { data: profile } = useCurrentProfile();
  const brand = useTenantBrand();
  const attentionCount = useHumanAttentionCount(profile?.tenant_id ?? null);
  const activePlugins = useActivePlugins();
  const capabilities = useMyCapabilities();
  const isAdmin = profile?.role === "admin";
  const enabledCapabilities = capabilities.data
    ? new Set(capabilities.data.filter((item) => item.enabled).map((item) => item.capability_key))
    : undefined;
  const engineItems = resolveEngineNavigation(
    engineRegistry,
    activePlugins,
    isAdmin,
    enabledCapabilities,
  ).map((item) => ({
    ...item,
    admin: item.admin ?? false,
  }));
  const items = [...baseItems.filter((i) => !i.admin || isAdmin), ...engineItems];
  // Marca padrão só quando não há workspace; enquanto o nome carrega, placeholder neutro.
  const brandName = brand.name ?? (brand.isLoading ? null : "Stefanello");

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div
          className="flex items-center gap-2 px-2 py-1.5"
          aria-busy={brandName ? undefined : true}
        >
          {brand.logoUrl ? (
            <img
              src={brand.logoUrl}
              alt=""
              aria-hidden
              className="h-8 w-8 shrink-0 rounded-md object-cover"
            />
          ) : brandName ? (
            <div className="glow-soft flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary font-mono font-medium text-primary-foreground">
              {brandName.charAt(0).toUpperCase()}
            </div>
          ) : (
            <div aria-hidden className="h-8 w-8 shrink-0 animate-pulse rounded-md bg-muted" />
          )}
          <span className="truncate text-body font-semibold text-sidebar-foreground group-data-[collapsible=icon]:hidden">
            {brandName ?? "Carregando…"}
          </span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        {(["Operação", "Automação e IA", "Gestão"] as const).map((group) => {
          const groupItems = items.filter((item) => item.group === group);
          if (groupItems.length === 0) return null;
          return (
            <SidebarGroup key={group} className="py-1">
              <SidebarGroupLabel>{group}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {groupItems.map((item) => {
                    const active =
                      item.url === "/app" ? pathname === "/app" : pathname.startsWith(item.url);
                    return (
                      <SidebarMenuItem key={item.title}>
                        <SidebarMenuButton asChild isActive={active} tooltip={item.title}>
                          <Link to={item.url}>
                            <item.icon />
                            <span>{item.title}</span>
                          </Link>
                        </SidebarMenuButton>
                        {/* ponytail: badge some no modo colapsado (icon); expandir é o default */}
                        {item.url === "/inbox" && attentionCount > 0 && (
                          <SidebarMenuBadge
                            className="bg-primary text-primary-foreground"
                            aria-label={`${attentionCount} conversas aguardando atendimento humano`}
                          >
                            {attentionCount > 99 ? "99+" : attentionCount}
                          </SidebarMenuBadge>
                        )}
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          );
        })}
      </SidebarContent>
      <SidebarFooter>
        <div className="flex items-center gap-1.5 px-2 py-1 text-caption text-muted-foreground group-data-[collapsible=icon]:justify-center">
          <Zap className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate group-data-[collapsible=icon]:hidden">
            Powered by Acelera IA
          </span>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
