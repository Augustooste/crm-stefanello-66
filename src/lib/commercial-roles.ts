export const TEAM_MEMBER_ROLES = ["admin", "manager", "finance", "agent"] as const;

export type TeamMemberRole = (typeof TEAM_MEMBER_ROLES)[number];

export const TEAM_MEMBER_ROLE_LABELS: Record<TeamMemberRole, string> = {
  admin: "Administrador",
  manager: "Gestor",
  finance: "Financeiro",
  agent: "Vendedor",
};

export function isTeamMemberRole(value: unknown): value is TeamMemberRole {
  return TEAM_MEMBER_ROLES.includes(value as TeamMemberRole);
}
