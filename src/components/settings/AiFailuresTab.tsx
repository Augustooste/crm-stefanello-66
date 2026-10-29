import { useState } from "react";
import { AlertTriangle } from "lucide-react";

import { EmptyState } from "@/components/common/EmptyState";
import { StatusBadge } from "@/components/common/StatusBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
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
  AI_ERROR_CODE_LABELS,
  useAiFailureLogs,
  AI_FAILURE_LOGS_PAGE_SIZE,
} from "@/lib/api/ai-failure-logs";
import type { AiErrorCode } from "@/lib/ai/errors";
import { formatDateTime } from "@/lib/format";
import {
  userFacingErrorMessage,
  userFacingFailureMessage,
} from "@/lib/integrations/friendly-errors";

const ERROR_CODE_OPTIONS = Object.keys(AI_ERROR_CODE_LABELS) as AiErrorCode[];

/**
 * Corpo da antiga rota /falhas-ia, agora aba "Falhas de IA" dentro de
 * Configurações (gate de admin já é feito por ConfiguracoesPage). Rota
 * antiga vira redirect (ver _app.falhas-ia.tsx).
 */
export function AiFailuresTab() {
  const [page, setPage] = useState(1);
  const [errorCode, setErrorCode] = useState<AiErrorCode | null>(null);

  const logsQ = useAiFailureLogs(page, errorCode);
  const rows = logsQ.data?.rows ?? [];
  const total = logsQ.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / AI_FAILURE_LOGS_PAGE_SIZE));

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-card-title">
          {logsQ.isLoading
            ? "Falhas de IA"
            : `${total} falha${total === 1 ? "" : "s"} registrada(s)`}
        </CardTitle>
        <Select
          value={errorCode ?? "all"}
          onValueChange={(v) => {
            setErrorCode(v === "all" ? null : (v as AiErrorCode));
            setPage(1);
          }}
        >
          <SelectTrigger className="w-[240px]">
            <SelectValue placeholder="Filtrar por tipo de erro" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os tipos</SelectItem>
            {ERROR_CODE_OPTIONS.map((code) => (
              <SelectItem key={code} value={code}>
                {AI_ERROR_CODE_LABELS[code]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent className="p-0">
        {logsQ.isLoading ? (
          <div className="p-4 space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : logsQ.isError ? (
          <div className="p-6">
            <EmptyState
              icon={AlertTriangle}
              title="Erro ao carregar falhas"
              description={userFacingErrorMessage(
                logsQ.error,
                "Não foi possível carregar as falhas agora.",
              )}
              actionLabel="Tentar novamente"
              onAction={() => logsQ.refetch()}
            />
          </div>
        ) : rows.length === 0 ? (
          <div className="p-6">
            <EmptyState
              icon={AlertTriangle}
              title={errorCode ? "Nenhuma falha desse tipo" : "Nenhuma falha registrada"}
              description={
                errorCode
                  ? "Ajuste o filtro para ver outros tipos de erro."
                  : "Quando a IA falhar ao gerar uma resposta, o registro aparece aqui."
              }
            />
          </div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Quando</TableHead>
                  <TableHead>Rota</TableHead>
                  <TableHead>Provedor / modelo</TableHead>
                  <TableHead>Situação</TableHead>
                  <TableHead>Tipo de erro</TableHead>
                  <TableHead>Mensagem</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDateTime(row.created_at)}
                    </TableCell>
                    <TableCell className="font-medium text-foreground">{row.route}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {[row.provider, row.model].filter(Boolean).join(" / ") || "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.status_code ?? "—"}
                    </TableCell>
                    <TableCell>
                      <StatusBadge variant="destructive">
                        {AI_ERROR_CODE_LABELS[row.error_code as AiErrorCode] ?? row.error_code}
                      </StatusBadge>
                    </TableCell>
                    <TableCell className="max-w-md truncate text-muted-foreground">
                      {userFacingFailureMessage(row.error_message)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="flex items-center justify-between border-t border-border px-4 py-3">
              <span className="text-caption text-muted-foreground">
                Página {page} de {totalPages}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Anterior
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Próxima
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
