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
  Workflow,
  HelpCircle,
  Bot,
  Megaphone,
  type LucideIcon,
} from "lucide-react";

import {
  Sidebar,
  SidebarContent,
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
import { BrandMark } from "@/components/marketing/BrandMark";
import { displayBrandName } from "@/lib/brand-name";
import { useActivePlugins } from "@/lib/api/plugins";
import { useMyCapabilities } from "@/lib/api/entitlements";
import { engineRegistry } from "@/engines/registry";
import { resolveEngineNavigation } from "@/kernel/engines/registry";
import type { TeamMemberRole } from "@/lib/commercial-roles";

type NavItem = {
  title: string;
  url: string;
  icon: LucideIcon;
  roles: TeamMemberRole[];
  group: "Operação" | "Automação e IA" | "Gestão";
};

const ALL_ROLES: TeamMemberRole[] = ["admin", "manager", "finance", "agent"];

// Itens desligados continuam registrados aqui para religar depois sem recriar rotas.
const HIDDEN_NAVIGATION_ITEMS = new Set([
  "Decisões",
  "Campanhas",
  "Ajuda",
  "Agentes IA",
]);
const SHOW_ENGINE_NAVIGATION = false; // Produtos, Empresas e Agenda.

const baseItems: NavItem[] = [
  { title: "Visão geral", url: "/app", icon: LayoutDashboard, roles: ALL_ROLES, group: "Operação" },
  { title: "Funil", url: "/pipeline", icon: KanbanSquare, roles: ALL_ROLES, group: "Operação" },
  { title: "Conversas", url: "/inbox", icon: Inbox, roles: ["admin"], group: "Operação" },
  { title: "Contatos", url: "/contatos", icon: Users, roles: ALL_ROLES, group: "Operação" },
  { title: "Atividades", url: "/atividades", icon: CalendarClock, roles: ALL_ROLES, group: "Operação" },
  { title: "Decisões", url: "/decisions", icon: ListChecks, roles: ALL_ROLES, group: "Automação e IA" },
  { title: "Acompanhamento automático", url: "/nurture", icon: Workflow, roles: ["admin"], group: "Automação e IA" },
  { title: "Campanhas", url: "/templates", icon: Megaphone, roles: ["admin"], group: "Automação e IA" },
  ...(AGENTES_IA_HABILITADO
    ? [{ title: "Agentes IA", url: "/agentes", icon: Bot, roles: ["admin"] as TeamMemberRole[], group: "Automação e IA" as const }]
    : []),
  { title: "Relatórios", url: "/relatorios", icon: BarChart3, roles: ["admin", "manager"], group: "Gestão" },
  { title: "Configurações", url: "/configuracoes", icon: Settings, roles: ["admin"], group: "Gestão" },
  { title: "Ajuda", url: "/ajuda", icon: HelpCircle, roles: ALL_ROLES, group: "Gestão" },
];

export function AppSidebar() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { data: profile } = useCurrentProfile();
  const brand = useTenantBrand();
  const attentionCount = useHumanAttentionCount(profile?.tenant_id ?? null);
  const activePlugins = useActivePlugins();
  const capabilities = useMyCapabilities();
  const role = profile?.role ?? "agent";
  const isAdmin = role === "admin";
  const enabledCapabilities = capabilities.data
    ? new Set(capabilities.data.filter((item) => item.enabled).map((item) => item.capability_key))
    : undefined;
  const engineItems = SHOW_ENGINE_NAVIGATION
    ? resolveEngineNavigation(engineRegistry, activePlugins, isAdmin, enabledCapabilities).map((item) => ({
        ...item,
        group: "Operação" as const,
        roles: item.admin ? (["admin"] as TeamMemberRole[]) : ALL_ROLES,
      }))
    : [];
  const items = [
    ...baseItems.filter((item) => item.roles.includes(role) && !HIDDEN_NAVIGATION_ITEMS.has(item.title)),
    ...engineItems.filter((item) => !HIDDEN_NAVIGATION_ITEMS.has(item.title)),
  ];
  const brandName = brand.name
    ? displayBrandName(brand.name)
    : brand.isLoading
      ? null
      : "Laticínio Stefanello";

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1.5" aria-busy={brandName ? undefined : true}>
          <BrandMark className="h-9 group-data-[collapsible=icon]:hidden" />
          <img
            src="/app-icon-192.png"
            alt="Laticínio Stefanello"
            width={192}
            height={192}
            className="hidden h-8 w-8 object-contain group-data-[collapsible=icon]:block"
          />
          <span className="sr-only">{brandName ?? "Carregando…"}</span>
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
                    const active = item.url === "/app" ? pathname === "/app" : pathname.startsWith(item.url);
                    return (
                      <SidebarMenuItem key={item.title}>
                        <SidebarMenuButton asChild isActive={active} tooltip={item.title}>
                          <Link to={item.url}>
                            <item.icon />
                            <span>{item.title}</span>
                          </Link>
                        </SidebarMenuButton>
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
    </Sidebar>
  );
}
