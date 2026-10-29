import { useMemo, useState } from "react";
import { AlertTriangle, Download, Link2, X } from "lucide-react";
import { toast } from "sonner";

import { EmptyState } from "@/components/common/EmptyState";
import { IncidentAlertBanner } from "@/components/settings/IncidentAlertBanner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  DEFAULT_INCIDENT_FILTERS,
  INCIDENT_EXPORT_LIMIT,
  INCIDENT_KIND_LABELS,
  INCIDENT_PERIOD_LABELS,
  distinctIncidentCodes,
  fetchIncidents,
  incidentsByTrace,
  useIncidents,
  type Incident,
  type IncidentFilters,
  type IncidentKind,
  type IncidentPeriod,
} from "@/lib/api/incidents";
import { downloadIncidents } from "@/lib/incidents-export";
import { formatDateTime } from "@/lib/format";
import { userFacingErrorMessage } from "@/lib/integrations/friendly-errors";

const ALL = "todos";

function KindBadge({ kind }: { kind: IncidentKind }) {
  return (
    <Badge variant={kind === "falha_ia" ? "destructive" : "secondary"}>
      {INCIDENT_KIND_LABELS[kind]}
    </Badge>
  );
}

/**
 * Centro de incidentes: erros do app (frontend) e falhas da IA (backend) na
 * mesma lista, correlacionados pelo traceId — o id da mensagem de entrada que
 * originou a execução. Clicar num traceId filtra a execução inteira, então dá
 * para ver "a IA falhou e a tela deu erro" como um incidente só.
 * Gate de admin é do ConfiguracoesPage; RLS e o hook repetem.
 */
export function IncidentsTab() {
  const [filters, setFilters] = useState<IncidentFilters>(DEFAULT_INCIDENT_FILTERS);
  const [selectedTrace, setSelectedTrace] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const q = useIncidents(filters);

  const incidents = useMemo(() => q.data ?? [], [q.data]);
  const codes = useMemo(() => distinctIncidentCodes(incidents), [incidents]);
  const traceRows = useMemo(
    () => (selectedTrace ? incidentsByTrace(incidents, selectedTrace) : []),
    [incidents, selectedTrace],
  );

  const patch = (next: Partial<IncidentFilters>) => setFilters((prev) => ({ ...prev, ...next }));

  async function handleExport(format: "csv" | "json") {
    setExporting(true);
    try {
      // Exporta a janela inteira (até o teto), não só as linhas em tela.
      const rows = await fetchIncidents(filters, INCIDENT_EXPORT_LIMIT);
      if (rows.length === 0) {
        toast.info("Nada para exportar com os filtros atuais.");
        return;
      }
      if (downloadIncidents(rows, format)) {
        toast.success(`${rows.length} incidente(s) exportado(s) em ${format.toUpperCase()}.`);
      }
    } catch (error) {
      toast.error(userFacingErrorMessage(error, "Não foi possível exportar os incidentes."));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <IncidentAlertBanner
        onOpenDetails={(alert) => patch({ code: alert.code, kind: alert.kind, period: "24h" })}
      />

      <Card>
        <CardHeader className="flex flex-col gap-4">
          <CardTitle className="text-card-title">
            {q.isLoading
              ? "Incidentes"
              : `${incidents.length} incidente${incidents.length === 1 ? "" : "s"} · ${
                  INCIDENT_PERIOD_LABELS[filters.period]
                }`}
          </CardTitle>

          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="incidentes-periodo">Período</Label>
              <Select
                value={filters.period}
                onValueChange={(v) => patch({ period: v as IncidentPeriod })}
              >
                <SelectTrigger id="incidentes-periodo" className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(INCIDENT_PERIOD_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1">
              <Label htmlFor="incidentes-tipo">Tipo</Label>
              <Select
                value={filters.kind}
                onValueChange={(v) => patch({ kind: v as IncidentFilters["kind"] })}
              >
                <SelectTrigger id="incidentes-tipo" className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Todos</SelectItem>
                  <SelectItem value="erro_app">Erro do app</SelectItem>
                  <SelectItem value="falha_ia">Falha de IA</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1">
              <Label htmlFor="incidentes-codigo">Código</Label>
              <Select
                value={filters.code ?? ALL}
                onValueChange={(v) => patch({ code: v === ALL ? null : v })}
              >
                <SelectTrigger id="incidentes-codigo" className="w-52">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Todos os códigos</SelectItem>
                  {codes.map((code) => (
                    <SelectItem key={code} value={code}>
                      {code}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1">
              <Label htmlFor="incidentes-trace">Identificador de execução</Label>
              <Input
                id="incidentes-trace"
                className="w-56"
                placeholder="traceId"
                value={filters.traceId ?? ""}
                onChange={(e) => patch({ traceId: e.target.value || null })}
              />
            </div>

            <div className="ml-auto flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={exporting}
                onClick={() => handleExport("csv")}
              >
                <Download className="mr-1 h-4 w-4" aria-hidden />
                CSV
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={exporting}
                onClick={() => handleExport("json")}
              >
                <Download className="mr-1 h-4 w-4" aria-hidden />
                JSON
              </Button>
            </div>
          </div>

          {selectedTrace ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/40 p-3">
              <Link2 className="h-4 w-4 text-muted-foreground" aria-hidden />
              <span className="text-sm">
                Execução <span className="font-mono break-all">{selectedTrace}</span> ·{" "}
                {traceRows.length} evento{traceRows.length === 1 ? "" : "s"} correlacionado
                {traceRows.length === 1 ? "" : "s"}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                onClick={() => setSelectedTrace(null)}
              >
                <X className="mr-1 h-4 w-4" aria-hidden />
                Limpar
              </Button>
            </div>
          ) : null}
        </CardHeader>

        <CardContent className="p-0">
          {q.isLoading ? (
            <div className="space-y-3 p-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : q.isError ? (
            <EmptyState
              icon={AlertTriangle}
              title="Não foi possível carregar os incidentes"
              description="Tente novamente em instantes."
            />
          ) : incidents.length === 0 ? (
            <EmptyState
              icon={AlertTriangle}
              title="Nenhum incidente registrado"
              description={`Nada foi registrado no período selecionado (${INCIDENT_PERIOD_LABELS[filters.period].toLowerCase()}).`}
            />
          ) : (
            <IncidentTable
              incidents={selectedTrace ? traceRows : incidents}
              selectedTrace={selectedTrace}
              onSelectTrace={setSelectedTrace}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function IncidentTable({
  incidents,
  selectedTrace,
  onSelectTrace,
}: {
  incidents: Incident[];
  selectedTrace: string | null;
  onSelectTrace: (traceId: string | null) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-36">Quando</TableHead>
          <TableHead className="w-32">Tipo</TableHead>
          <TableHead className="w-48">Origem</TableHead>
          <TableHead className="w-40">Código</TableHead>
          <TableHead>Mensagem</TableHead>
          <TableHead className="w-44">Execução</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {incidents.map((incident) => (
          <TableRow key={incident.id}>
            <TableCell className="text-muted-foreground">
              {formatDateTime(incident.occurredAt)}
            </TableCell>
            <TableCell>
              <KindBadge kind={incident.kind} />
            </TableCell>
            <TableCell className="font-mono break-all">{incident.scope}</TableCell>
            <TableCell className="font-mono text-caption break-all">
              {incident.code ?? "—"}
            </TableCell>
            <TableCell className="max-w-md break-words">{incident.message}</TableCell>
            <TableCell>
              {incident.traceId ? (
                <Button
                  size="sm"
                  variant={selectedTrace === incident.traceId ? "secondary" : "ghost"}
                  className="max-w-full font-mono text-caption"
                  onClick={() =>
                    onSelectTrace(selectedTrace === incident.traceId ? null : incident.traceId)
                  }
                  title={incident.traceId}
                >
                  <span className="truncate">{incident.traceId.slice(0, 8)}…</span>
                </Button>
              ) : (
                <span className="text-caption text-muted-foreground">sem correlação</span>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
