import { useMemo, useState } from "react";
import { toast } from "sonner";
import { PhoneOff, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/common/EmptyState";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/common/StatusBadge";
import { Textarea } from "@/components/ui/textarea";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDateTime } from "@/lib/format";
import { userFacingErrorMessage } from "@/lib/integrations/friendly-errors";
import {
  useAddManualPhoneSuppression,
  usePhoneSuppressions,
  useReactivatePhoneSuppression,
  type PhoneSuppressionRow,
  type PhoneSuppressionSource,
} from "@/hooks/use-phone-suppressions";

const SOURCE_LABEL: Record<PhoneSuppressionSource, string> = {
  keyword: "Palavra-chave",
  manual: "Manual",
  api: "API",
};

type StatusFilter = "active" | "reactivated" | "all";

function matchesFilter(row: PhoneSuppressionRow, filter: StatusFilter): boolean {
  if (filter === "active") return row.reactivated_at === null;
  if (filter === "reactivated") return row.reactivated_at !== null;
  return true;
}

/**
 * Gestão de supressões de telefone (Fase 4, user story H). Lista
 * messaging_phone_suppressions (RLS tenant-scoped) e só escreve via as 2 RPCs
 * SECURITY DEFINER (add_manual_phone_suppression / reactivate_phone_suppression)
 * -- nunca insert/update direto: não existe policy para isso, de propósito
 * (ver supabase/migrations/20260710140200_fase4_suppressions_schema.sql).
 */
export function PhoneSuppressionsTab() {
  const suppressionsQ = usePhoneSuppressions();
  const addMut = useAddManualPhoneSuppression();
  const reactivateMut = useReactivatePhoneSuppression();

  const [filter, setFilter] = useState<StatusFilter>("active");
  const [addOpen, setAddOpen] = useState(false);

  const filteredRows = useMemo(
    () => (suppressionsQ.data ?? []).filter((row) => matchesFilter(row, filter)),
    [suppressionsQ.data, filter],
  );

  const handleReactivate = (row: PhoneSuppressionRow) => {
    reactivateMut.mutate(row.id, {
      onSuccess: () => toast.success(`${row.phone} reativado`),
      onError: (e: Error) => toast.error(userFacingErrorMessage(e, "Erro ao reativar supressão")),
    });
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-card-title">
          <PhoneOff className="h-4 w-4" aria-hidden />
          Supressões de telefone
        </CardTitle>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="mr-1 h-4 w-4" /> Adicionar supressão manual
        </Button>
      </CardHeader>
      <CardContent className="space-y-4 p-0">
        <div className="flex items-center justify-between gap-3 px-6 pt-4">
          <p className="text-caption text-muted-foreground">
            Telefones que não recebem envios automáticos (acompanhamento automático/envio em massa).
          </p>
          <Select value={filter} onValueChange={(v) => setFilter(v as StatusFilter)}>
            <SelectTrigger className="w-40" aria-label="Filtrar por situação">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Ativas</SelectItem>
              <SelectItem value="reactivated">Reativadas</SelectItem>
              <SelectItem value="all">Todas</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {suppressionsQ.isLoading ? (
          <div className="p-4">
            <Skeleton className="h-24 w-full" />
          </div>
        ) : suppressionsQ.isError ? (
          <div className="p-6">
            <EmptyState
              title="Erro ao carregar"
              description={userFacingErrorMessage(
                suppressionsQ.error,
                "Não foi possível carregar as supressões agora.",
              )}
              actionLabel="Tentar novamente"
              onAction={() => suppressionsQ.refetch()}
            />
          </div>
        ) : filteredRows.length === 0 ? (
          <div className="p-6">
            <EmptyState
              icon={PhoneOff}
              title="Nenhuma supressão encontrada"
              description="Telefones suprimidos por palavra-chave, manualmente ou via API aparecerão aqui."
            />
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Telefone</TableHead>
                <TableHead>Motivo</TableHead>
                <TableHead>Origem</TableHead>
                <TableHead>Suprimido em</TableHead>
                <TableHead>Situação</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredRows.map((row) => {
                const isActive = row.reactivated_at === null;
                return (
                  <TableRow key={row.id}>
                    <TableCell className="font-medium text-foreground">{row.phone}</TableCell>
                    <TableCell className="text-muted-foreground">{row.reason}</TableCell>
                    <TableCell>{SOURCE_LABEL[row.source]}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDateTime(row.suppressed_at)}
                    </TableCell>
                    <TableCell>
                      <StatusBadge variant={isActive ? "warning" : "neutral"}>
                        {isActive ? "Ativa" : "Reativada"}
                      </StatusBadge>
                    </TableCell>
                    <TableCell className="text-right">
                      {isActive && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={reactivateMut.isPending}
                          onClick={() => handleReactivate(row)}
                        >
                          Reativar
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>

      {addOpen && (
        <AddSuppressionDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          onSubmit={(input, onDone) =>
            addMut.mutate(input, {
              onSuccess: () => {
                toast.success("Supressão adicionada");
                onDone();
              },
              onError: (e: Error) =>
                toast.error(userFacingErrorMessage(e, "Erro ao adicionar supressão")),
            })
          }
          isPending={addMut.isPending}
        />
      )}
    </Card>
  );
}

function AddSuppressionDialog({
  open,
  onOpenChange,
  onSubmit,
  isPending,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSubmit: (input: { phone: string; reason: string }, onDone: () => void) => void;
  isPending: boolean;
}) {
  const [phone, setPhone] = useState("");
  const [reason, setReason] = useState("");

  const handleSubmit = () => {
    onSubmit({ phone: phone.trim(), reason: reason.trim() }, () => {
      onOpenChange(false);
      setPhone("");
      setReason("");
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Adicionar supressão manual</DialogTitle>
          <DialogDescription>
            O telefone deixa de receber envios automáticos (nurture/broadcast) até ser reativado.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="suppression-phone">Telefone *</Label>
            <Input
              id="suppression-phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+55 11 90000-0000"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="suppression-reason">Motivo *</Label>
            <Textarea
              id="suppression-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Por que este telefone deve parar de receber envios automáticos?"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button disabled={!phone.trim() || !reason.trim() || isPending} onClick={handleSubmit}>
            {isPending ? "Adicionando…" : "Adicionar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
