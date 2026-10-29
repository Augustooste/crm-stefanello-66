import { useState } from "react";
import { Mail, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { EmptyState } from "@/components/common/EmptyState";
import { StatusBadge } from "@/components/common/StatusBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { useCurrentProfile } from "@/lib/api/session";
import { formatDate } from "@/lib/format";
import { userFacingErrorMessage } from "@/lib/integrations/friendly-errors";
import {
  useCreateWeeklyReportRecipient,
  useDeleteWeeklyReportRecipient,
  useUpdateWeeklyReportRecipient,
  useWeeklyReportRecipients,
  useWeeklyReports,
  type RecipientChannel,
  type ReportStatus,
  type WeeklyReportRecipientRow,
  type WeeklyReportRow,
} from "@/hooks/use-weekly-digest";

const CHANNEL_LABEL: Record<RecipientChannel, string> = {
  email: "E-mail",
  whatsapp: "WhatsApp",
};

const REPORT_STATUS_LABEL: Record<ReportStatus, string> = {
  generated: "Gerado",
  sent: "Enviado",
  failed: "Falhou",
};

/**
 * Corpo da antiga rota /digest-semanal, agora aba "Notificações" dentro de
 * Configurações. Ao contrário das demais abas de Configurações, esta fica
 * visível a QUALQUER usuário autenticado do tenant (não só admin) -- mesmo
 * comportamento de antes (RLS libera leitura geral, só escrita é
 * admin-gated), replicado aqui via `isAdmin` interno. Rota antiga vira
 * redirect (ver _app.digest-semanal.tsx).
 */
export function NotificationsTab() {
  const { data: profile } = useCurrentProfile();
  const isAdmin = profile?.role === "admin";

  const recipientsQ = useWeeklyReportRecipients();
  const reportsQ = useWeeklyReports();

  const [openForm, setOpenForm] = useState<{ recipient?: WeeklyReportRecipientRow } | null>(null);
  const [deleting, setDeleting] = useState<WeeklyReportRecipientRow | null>(null);

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-card-title">Destinatários do resumo semanal</CardTitle>
          {isAdmin && (
            <Button size="sm" onClick={() => setOpenForm({})}>
              <Plus className="mr-1 h-4 w-4" /> Novo destinatário
            </Button>
          )}
        </CardHeader>
        <CardContent className="p-0">
          {recipientsQ.isLoading ? (
            <div className="p-4">
              <Skeleton className="h-24 w-full" />
            </div>
          ) : recipientsQ.isError ? (
            <div className="p-6">
              <EmptyState
                title="Erro ao carregar"
                description={userFacingErrorMessage(
                  recipientsQ.error,
                  "Não foi possível carregar os destinatários agora.",
                )}
                actionLabel="Tentar novamente"
                onAction={() => recipientsQ.refetch()}
              />
            </div>
          ) : (recipientsQ.data ?? []).length === 0 ? (
            <div className="p-6">
              <EmptyState
                icon={Mail}
                title="Nenhum destinatário"
                description="Cadastre quem deve receber o resumo semanal por e-mail ou WhatsApp."
              />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>Canal</TableHead>
                  <TableHead>Endereço</TableHead>
                  <TableHead>Situação</TableHead>
                  {isAdmin && <TableHead className="text-right">Ações</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {recipientsQ.data!.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium text-foreground">{r.name || "—"}</TableCell>
                    <TableCell>{CHANNEL_LABEL[r.channel]}</TableCell>
                    <TableCell className="text-muted-foreground">{r.address}</TableCell>
                    <TableCell>
                      <StatusBadge variant={r.active ? "success" : "neutral"}>
                        {r.active ? "Ativo" : "Inativo"}
                      </StatusBadge>
                    </TableCell>
                    {isAdmin && (
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Editar ${r.name || r.address}`}
                          onClick={() => setOpenForm({ recipient: r })}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Excluir ${r.name || r.address}`}
                          onClick={() => setDeleting(r)}
                        >
                          <Trash2 className="h-4 w-4 text-muted-foreground" />
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-card-title">Histórico de envios</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {reportsQ.isLoading ? (
            <div className="p-4">
              <Skeleton className="h-24 w-full" />
            </div>
          ) : reportsQ.isError ? (
            <div className="p-6">
              <EmptyState
                title="Erro ao carregar"
                description={userFacingErrorMessage(
                  reportsQ.error,
                  "Não foi possível carregar os relatórios agora.",
                )}
                actionLabel="Tentar novamente"
                onAction={() => reportsQ.refetch()}
              />
            </div>
          ) : (reportsQ.data ?? []).length === 0 ? (
            <div className="p-6">
              <EmptyState
                title="Nenhum relatório gerado ainda"
                description="O resumo semanal ainda não foi gerado para esta empresa."
              />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Período</TableHead>
                  <TableHead>Situação</TableHead>
                  <TableHead>Entregas</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {reportsQ.data!.map((report) => (
                  <ReportRow key={report.id} report={report} />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {openForm && (
        <RecipientFormDialog
          open={!!openForm}
          onOpenChange={(v) => !v && setOpenForm(null)}
          recipient={openForm.recipient}
          tenantId={profile?.tenant_id ?? ""}
        />
      )}

      <AlertDialog open={!!deleting} onOpenChange={(v) => !v && setDeleting(null)}>
        <DeleteRecipientDialogContent recipient={deleting} onClose={() => setDeleting(null)} />
      </AlertDialog>
    </div>
  );
}

function ReportRow({ report }: { report: WeeklyReportRow }) {
  const deliveries = report.weekly_report_deliveries ?? [];
  const sent = deliveries.filter((d) => d.status === "sent").length;
  const failed = deliveries.filter((d) => d.status === "failed").length;
  const pending = deliveries.filter((d) => d.status === "pending" || d.status === "sending").length;

  const statusVariant = report.status === "failed" ? "destructive" : "neutral";

  return (
    <TableRow>
      <TableCell className="font-medium text-foreground">
        {formatDate(report.period_start)} – {formatDate(report.period_end)}
      </TableCell>
      <TableCell>
        <StatusBadge variant={statusVariant}>{REPORT_STATUS_LABEL[report.status]}</StatusBadge>
      </TableCell>
      <TableCell className="text-muted-foreground">
        {sent} sucesso · {failed} falha{pending > 0 ? ` · ${pending} pendente` : ""}
      </TableCell>
    </TableRow>
  );
}

function DeleteRecipientDialogContent({
  recipient,
  onClose,
}: {
  recipient: WeeklyReportRecipientRow | null;
  onClose: () => void;
}) {
  const deleteMut = useDeleteWeeklyReportRecipient();

  return (
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Excluir destinatário</AlertDialogTitle>
        <AlertDialogDescription>
          <strong>{recipient?.name || recipient?.address}</strong> deixará de receber o resumo
          semanal. Esta ação não pode ser desfeita.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancelar</AlertDialogCancel>
        <AlertDialogAction
          onClick={() => {
            if (!recipient) return;
            deleteMut.mutate(recipient.id, {
              onSuccess: () => {
                toast.success("Destinatário removido");
                onClose();
              },
              onError: (e: Error) => toast.error(userFacingErrorMessage(e, "Erro ao remover")),
            });
          }}
          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
        >
          {deleteMut.isPending ? "Removendo…" : "Excluir"}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  );
}

function RecipientFormDialog({
  open,
  onOpenChange,
  recipient,
  tenantId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  recipient?: WeeklyReportRecipientRow;
  tenantId: string;
}) {
  const [name, setName] = useState(recipient?.name ?? "");
  const [channel, setChannel] = useState<RecipientChannel>(recipient?.channel ?? "email");
  const [address, setAddress] = useState(recipient?.address ?? "");
  const [active, setActive] = useState(recipient?.active ?? true);

  const createMut = useCreateWeeklyReportRecipient();
  const updateMut = useUpdateWeeklyReportRecipient();
  const isPending = createMut.isPending || updateMut.isPending;

  const handleSave = () => {
    const formInput = { channel, address: address.trim(), name: name.trim() || null, active };
    const onSuccess = () => {
      toast.success(recipient ? "Destinatário atualizado" : "Destinatário criado");
      onOpenChange(false);
    };
    const onError = (e: Error) => toast.error(userFacingErrorMessage(e, "Erro ao salvar"));

    if (recipient) {
      updateMut.mutate({ id: recipient.id, ...formInput }, { onSuccess, onError });
    } else {
      createMut.mutate({ tenantId, ...formInput }, { onSuccess, onError });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{recipient ? "Editar destinatário" : "Novo destinatário"}</DialogTitle>
          <DialogDescription>Defina canal, endereço e nome do destinatário.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="recipient-name">Nome</Label>
            <Input id="recipient-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="recipient-channel">Canal *</Label>
            <Select value={channel} onValueChange={(v) => setChannel(v as RecipientChannel)}>
              <SelectTrigger id="recipient-channel">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="email">E-mail</SelectItem>
                <SelectItem value="whatsapp">WhatsApp</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="recipient-address">
              {channel === "email" ? "E-mail *" : "Telefone (WhatsApp) *"}
            </Label>
            <Input
              id="recipient-address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder={channel === "email" ? "nome@empresa.com" : "+55 11 90000-0000"}
            />
          </div>
          <div className="flex items-center justify-between">
            <Label htmlFor="recipient-active">Ativo</Label>
            <Switch id="recipient-active" checked={active} onCheckedChange={setActive} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button disabled={!address.trim() || isPending} onClick={handleSave}>
            {isPending ? "Salvando…" : "Salvar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
