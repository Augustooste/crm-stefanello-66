import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Ban, CheckCircle2, Copy, Mail, RefreshCw, UserPlus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/common/EmptyState";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusBadge } from "@/components/common/StatusBadge";
import { supabase } from "@/integrations/supabase/client";
import { createInvite, rotateInviteToken } from "@/lib/api/invites";
import { createTeamMember } from "@/lib/api/team-members.functions";
import { useCurrentProfile } from "@/lib/api/session";
import { useAuth } from "@/lib/auth/AuthProvider";
import { formatDate } from "@/lib/format";
import { userFacingErrorMessage } from "@/lib/integrations/friendly-errors";

type ProfileRow = {
  id: string;
  name: string;
  email: string | null;
  role: "admin" | "agent";
  disabled: boolean;
};
type InviteRow = {
  id: string;
  email: string;
  role: "admin" | "agent";
  token: string;
  expires_at: string;
  accepted_at: string | null;
  created_at: string;
};

export function TeamTab() {
  const { data: profile } = useCurrentProfile();
  const { user } = useAuth();
  const tenantId = profile?.tenant_id;
  const qc = useQueryClient();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const isAdmin = profile?.role === "admin";
  const [shownLink, setShownLink] = useState<string | null>(null);

  const membersQ = useQuery({
    queryKey: ["team-members", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      // O e-mail dos colegas não é mais legível direto em `profiles` (grant de
      // coluna revogado); a RPC devolve o e-mail apenas para o próprio usuário
      // e para admins do mesmo workspace.
      const { data, error } = await supabase.rpc("get_tenant_team");
      if (error) throw error;
      return (data ?? []) as ProfileRow[];
    },
  });

  const invitesQ = useQuery({
    queryKey: ["team-invites", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("invites")
        .select("id, email, role, token, expires_at, accepted_at, created_at")
        .is("accepted_at", null)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as InviteRow[];
    },
  });

  const activeAdmins = (membersQ.data ?? []).filter(
    (m) => m.role === "admin" && !m.disabled,
  ).length;

  const setRole = useMutation({
    mutationFn: async ({ id, role }: { id: string; role: "admin" | "agent" }) => {
      const { error } = await supabase.from("profiles").update({ role }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["team-members"] });
      qc.invalidateQueries({ queryKey: ["current-profile"] });
      toast.success("Papel atualizado");
    },
    onError: (e: Error) => toast.error(userFacingErrorMessage(e, "Erro")),
  });

  const setDisabled = useMutation({
    mutationFn: async ({ id, disabled }: { id: string; disabled: boolean }) => {
      const { error } = await supabase.from("profiles").update({ disabled }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["team-members"] });
      toast.success("Usuário atualizado");
    },
    onError: (e: Error) => toast.error(userFacingErrorMessage(e, "Erro")),
  });

  const cancelInvite = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("invites").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["team-invites"] });
      toast.success("Convite cancelado");
    },
    onError: (e: Error) => toast.error(userFacingErrorMessage(e, "Erro")),
  });

  // Não reenvia nada: o app não dispara e-mail. Troca o token e a validade, e
  // mostra o link novo para o admin copiar e mandar por onde quiser. Trocar o
  // token é o ponto: renovar mantendo o segredo antigo só revive por mais 7 dias
  // um link que pode ter vazado.
  const renewInviteLink = useMutation({
    mutationFn: (invite: InviteRow) => rotateInviteToken(invite.id),
    onSuccess: (token) => {
      qc.invalidateQueries({ queryKey: ["team-invites"] });
      setShownLink(`${window.location.origin}/auth?invite=${token}`);
      toast.success(
        "Novo link gerado, válido por mais 7 dias. O link anterior deixou de valer. Copie e envie você mesmo.",
      );
    },
    onError: (e: Error) => toast.error(userFacingErrorMessage(e, "Erro")),
  });

  const canDisable = (m: ProfileRow) => {
    if (m.id === user?.id) return false;
    if (m.role === "admin" && activeAdmins <= 1 && !m.disabled) return false;
    return true;
  };
  const canChangeRoleTo = (m: ProfileRow, next: "admin" | "agent") => {
    if (m.id === user?.id && m.role === "admin" && next === "agent" && activeAdmins <= 1)
      return false;
    if (m.role === "admin" && next === "agent" && activeAdmins <= 1) return false;
    return true;
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-card-title">Equipe</CardTitle>
          <div className="flex gap-2">
            {isAdmin && (
              <Button size="sm" variant="outline" onClick={() => setAddMemberOpen(true)}>
                <UserPlus className="mr-1 h-4 w-4" /> Adicionar membro
              </Button>
            )}
            <Button size="sm" onClick={() => setInviteOpen(true)}>
              <Mail className="mr-1 h-4 w-4" /> Convidar
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {membersQ.isLoading ? (
            <div className="p-4">
              <Skeleton className="h-24 w-full" />
            </div>
          ) : (membersQ.data ?? []).length === 0 ? (
            <div className="p-6">
              <EmptyState title="Sem membros" description="Convide seu primeiro colega." />
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {membersQ.data!.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-body font-medium text-foreground">
                      {m.name}{" "}
                      {m.id === user?.id && (
                        <span className="text-caption text-muted-foreground">(você)</span>
                      )}
                    </div>
                    <div className="text-caption text-muted-foreground truncate">
                      {m.email ?? "—"}
                    </div>
                  </div>
                  <StatusBadge variant={m.disabled ? "neutral" : "success"}>
                    {m.disabled ? "Desativado" : "Ativo"}
                  </StatusBadge>
                  <Select
                    value={m.role}
                    onValueChange={(v) => {
                      const next = v as "admin" | "agent";
                      if (!canChangeRoleTo(m, next)) {
                        toast.error("Não é possível: deve haver ao menos um administrador ativo.");
                        return;
                      }
                      setRole.mutate({ id: m.id, role: next });
                    }}
                    disabled={m.disabled}
                  >
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="admin">Administrador</SelectItem>
                      <SelectItem value="agent">Atendente</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!canDisable(m)}
                    onClick={() => setDisabled.mutate({ id: m.id, disabled: !m.disabled })}
                    title={
                      m.id === user?.id
                        ? "Você não pode desativar a si mesmo"
                        : m.role === "admin" && activeAdmins <= 1 && !m.disabled
                          ? "Deve haver ao menos um administrador ativo"
                          : m.disabled
                            ? "Reativar"
                            : "Desativar"
                    }
                  >
                    {m.disabled ? (
                      <CheckCircle2 className="mr-1 h-4 w-4" />
                    ) : (
                      <Ban className="mr-1 h-4 w-4" />
                    )}
                    {m.disabled ? "Reativar" : "Desativar"}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-card-title">Convites pendentes</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {invitesQ.isLoading ? (
            <div className="p-4">
              <Skeleton className="h-16 w-full" />
            </div>
          ) : (invitesQ.data ?? []).length === 0 ? (
            <div className="p-6">
              <EmptyState
                title="Nenhum convite pendente"
                description="Convites aparecerão aqui até serem aceitos."
              />
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {invitesQ.data!.map((i) => {
                const expired = new Date(i.expires_at).getTime() < Date.now();
                const link = `${window.location.origin}/auth?invite=${i.token}`;
                return (
                  <li key={i.id} className="flex flex-wrap items-center gap-3 p-3">
                    <Mail className="h-4 w-4 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="text-body font-medium text-foreground">{i.email}</div>
                      <div className="text-caption text-muted-foreground">
                        Papel: {i.role === "admin" ? "Administrador" : "Atendente"} ·{" "}
                        {expired ? "Expirado" : `Expira em ${formatDate(i.expires_at)}`}
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        navigator.clipboard.writeText(link);
                        toast.success("Link copiado");
                      }}
                    >
                      <Copy className="mr-1 h-4 w-4" /> Copiar link
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => renewInviteLink.mutate(i)}
                      disabled={renewInviteLink.isPending}
                    >
                      <RefreshCw className="mr-1 h-4 w-4" /> Gerar novo link
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => cancelInvite.mutate(i.id)}>
                      <X className="mr-1 h-4 w-4" /> Cancelar
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {inviteOpen && (
        <InviteDialog
          open={inviteOpen}
          onOpenChange={setInviteOpen}
          tenantId={tenantId!}
          onCreated={(link) => setShownLink(link)}
        />
      )}

      {addMemberOpen && <AddMemberDialog open={addMemberOpen} onOpenChange={setAddMemberOpen} />}

      <Dialog open={!!shownLink} onOpenChange={(v) => !v && setShownLink(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Link de convite</DialogTitle>
            <DialogDescription>
              Envie este link para a pessoa convidada. Ele expira em 7 dias.
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            <Input readOnly value={shownLink ?? ""} onFocus={(e) => e.currentTarget.select()} />
            <Button
              variant="outline"
              onClick={() => {
                if (shownLink) {
                  navigator.clipboard.writeText(shownLink);
                  toast.success("Copiado");
                }
              }}
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => setShownLink(null)}>Fechar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function InviteDialog({
  open,
  onOpenChange,
  tenantId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  tenantId: string;
  onCreated: (link: string) => void;
}) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "agent">("agent");

  const create = useMutation({
    mutationFn: () => createInvite({ tenantId, email, role, createdBy: user?.id ?? null }),
    onSuccess: ({ token, superseded }) => {
      qc.invalidateQueries({ queryKey: ["team-invites"] });
      toast.success(
        superseded > 0
          ? "Convite criado. O convite anterior para este e-mail deixou de valer."
          : "Convite criado",
      );
      onOpenChange(false);
      onCreated(`${window.location.origin}/auth?invite=${token}`);
    },
    onError: (e: Error) => toast.error(userFacingErrorMessage(e, "Erro ao criar convite")),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Convidar pessoa</DialogTitle>
          <DialogDescription>
            Envie o link de convite. Quando a pessoa se cadastrar com este e-mail, entrará na sua
            empresa com o papel escolhido.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="invite-email">E-mail *</Label>
            <Input
              id="invite-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Papel</Label>
            <Select value={role} onValueChange={(v) => setRole(v as "admin" | "agent")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">Administrador</SelectItem>
                <SelectItem value="agent">Atendente</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button disabled={!email.trim() || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? "Criando…" : "Criar convite"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Criação direta: a conta nasce pronta, com senha inicial, dentro do workspace
 * de quem está criando. O workspace nunca é enviado pelo formulário — o
 * servidor o deriva da sessão.
 */
function AddMemberDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const createMember = useServerFn(createTeamMember);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "agent">("agent");
  const [password, setPassword] = useState("");

  const create = useMutation({
    mutationFn: () => createMember({ data: { name, email, role, password } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["team-members"] });
      qc.invalidateQueries({ queryKey: ["team-invites"] });
      toast.success("Membro criado. Peça para a pessoa trocar a senha no primeiro acesso.");
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(userFacingErrorMessage(e, "Erro ao criar membro")),
  });

  const podeCriar =
    name.trim().length >= 2 && email.trim().length > 3 && password.length >= 8 && !create.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Adicionar membro</DialogTitle>
          <DialogDescription>
            A conta é criada na hora, já dentro da sua empresa, com a senha inicial que você
            definir. Peça para a pessoa trocar a senha no primeiro acesso.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="member-name">Nome *</Label>
            <Input id="member-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="member-email">E-mail *</Label>
            <Input
              id="member-email"
              type="email"
              autoComplete="off"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Papel</Label>
            <Select value={role} onValueChange={(v) => setRole(v as "admin" | "agent")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">Administrador</SelectItem>
                <SelectItem value="agent">Atendente</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="member-password">Senha inicial *</Label>
            <Input
              id="member-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <p className="text-caption text-muted-foreground">Mínimo de 8 caracteres.</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button disabled={!podeCriar} onClick={() => create.mutate()}>
            {create.isPending ? "Criando…" : "Criar membro"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
