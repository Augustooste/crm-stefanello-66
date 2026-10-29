import { AlertTriangle } from "lucide-react";

import { EmptyState } from "@/components/common/EmptyState";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  CLIENT_ERROR_WINDOW_DAYS,
  groupClientErrorsByRoute,
  useClientErrors,
} from "@/lib/api/client-errors";
import { formatDateTime } from "@/lib/format";
import { userFacingErrorMessage } from "@/lib/integrations/friendly-errors";

/**
 * "Erros do app": erros de frontend por rota, com contagem. Responde a pergunta
 * que motivou a telemetria — qual página deu erro — sem abrir o console do
 * navegador. Gate de admin é do ConfiguracoesPage; RLS e o hook repetem.
 */
export function ClientErrorsTab() {
  const errorsQ = useClientErrors();
  const routes = groupClientErrorsByRoute(errorsQ.data ?? []);
  const total = (errorsQ.data ?? []).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-card-title">
          {errorsQ.isLoading || errorsQ.isError
            ? "Erros do app"
            : `${total} erro${total === 1 ? "" : "s"} em ${routes.length} ${
                routes.length === 1 ? "página" : "páginas"
              } (últimos ${CLIENT_ERROR_WINDOW_DAYS} dias)`}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {errorsQ.isLoading ? (
          <div className="space-y-3 p-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : errorsQ.isError ? (
          // Sem este ramo a query com falha caía no `?? []` e a tela dizia
          // "Nenhum erro registrado" — o oposto do que estava acontecendo.
          <EmptyState
            icon={AlertTriangle}
            title="Não foi possível carregar"
            description={userFacingErrorMessage(
              errorsQ.error,
              "Não foi possível carregar os erros do app agora.",
            )}
            actionLabel="Tentar novamente"
            onAction={() => errorsQ.refetch()}
          />
        ) : routes.length === 0 ? (
          <EmptyState
            icon={AlertTriangle}
            title="Nenhum erro registrado"
            description={`Nenhuma página do app registrou erro nos últimos ${CLIENT_ERROR_WINDOW_DAYS} dias.`}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Página</TableHead>
                <TableHead className="w-24 text-right">Ocorrências</TableHead>
                <TableHead className="w-40">Último erro</TableHead>
                <TableHead>Mensagem</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {routes.map((row) => (
                <TableRow key={row.route}>
                  <TableCell className="font-mono">{row.route}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.occurrences}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDateTime(row.lastAt)}
                  </TableCell>
                  <TableCell className="max-w-md">
                    {row.lastErrorCode ? (
                      <span className="mr-2 font-mono text-caption text-muted-foreground">
                        {row.lastErrorCode}
                      </span>
                    ) : null}
                    <span className="break-words">{row.lastMessage}</span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
