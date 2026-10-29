import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Download, Eye, Info, Lock, RotateCcw, Upload, Wand2 } from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";

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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useCurrentProfile } from "@/lib/api/session";
import {
  useReplaceViewPrefs,
  useResetPageViewPrefs,
  useUpdateViewPref,
  useViewPrefs,
  type ViewPrefsMap,
} from "@/lib/api/view-prefs";
import { listPages, type PageKey } from "@/lib/view-prefs/registry";
import { BUILTIN_PRESETS, findPreset } from "@/lib/view-prefs/presets";
import { userFacingErrorMessage } from "@/lib/integrations/friendly-errors";
import {
  downloadPrefsJson,
  parseImportedPrefs,
  readFileAsJson,
} from "@/lib/view-prefs/export-import";
import {
  PERIOD_OPTIONS,
  useGlobalPeriod,
  type PeriodKey,
} from "@/lib/view-prefs/use-global-period";

/**
 * Visualização — Admin liga/desliga widgets, aplica presets prontos,
 * define o período default da empresa e faz backup das preferências.
 * Agent vê tudo em modo somente-leitura.
 */
export function ViewPrefsTab() {
  const { data: profile } = useCurrentProfile();
  const view = useViewPrefs();
  const readOnly = profile?.role !== "admin";
  const pages = listPages();

  if (view.isLoading) return <Skeleton className="h-96 w-full" />;

  return (
    <div className="flex flex-col gap-4">
      {readOnly && (
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-caption text-muted-foreground">
          <Lock className="h-3.5 w-3.5" aria-hidden />
          Somente leitura — apenas administradores podem alterar as preferências da empresa.
        </div>
      )}
      <PresetsCard readOnly={readOnly} />
      <GlobalDefaultsCard readOnly={readOnly} />
      {pages.map((page) => (
        <PageSection
          key={page.key}
          pageKey={page.key as PageKey}
          label={page.label}
          readOnly={readOnly}
        />
      ))}
      <BackupCard readOnly={readOnly} />
    </div>
  );
}

function PresetsCard({ readOnly }: { readOnly: boolean }) {
  const [selected, setSelected] = useState<string>(BUILTIN_PRESETS[0]?.id ?? "");
  const replace = useReplaceViewPrefs();
  const preset = findPreset(selected);

  function apply() {
    if (!preset) return;
    replace.mutate(
      { prefs: preset.prefs, mode: "merge" },
      {
        onSuccess: () => toast.success(`Preset "${preset.name}" aplicado.`),
        onError: (err) =>
          toast.error(userFacingErrorMessage(err, "Não foi possível aplicar o preset.")),
      },
    );
  }

  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="flex items-center gap-2 text-card-title">
          <Wand2 className="h-4 w-4" aria-hidden />
          Presets de visualização
        </CardTitle>
        <p className="text-caption text-muted-foreground">
          Aplique um perfil pronto — depois ajuste widget por widget se quiser.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1 space-y-1">
          <Label htmlFor="preset-select">Perfil</Label>
          <Select value={selected} onValueChange={setSelected} disabled={readOnly}>
            <SelectTrigger id="preset-select" aria-label="Selecionar preset">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BUILTIN_PRESETS.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {preset && <p className="text-caption text-muted-foreground">{preset.description}</p>}
        </div>
        <ReadOnlyGate readOnly={readOnly}>
          <Button type="button" onClick={apply} disabled={readOnly || replace.isPending || !preset}>
            Aplicar preset
          </Button>
        </ReadOnlyGate>
      </CardContent>
    </Card>
  );
}

function GlobalDefaultsCard({ readOnly }: { readOnly: boolean }) {
  const { tenantDefault, isSessionOverride, clearSessionOverride } = useGlobalPeriod();
  const { data: profile } = useCurrentProfile();
  const view = useViewPrefs();
  const [saving, setSaving] = useState(false);
  const qc = useQueryClient();

  async function setDefault(next: PeriodKey) {
    if (!profile?.tenant_id) {
      toast.error("Sem empresa carregada.");
      return;
    }
    setSaving(true);
    try {
      const currentPrefs = (view.prefs as Record<string, unknown>) ?? {};
      const currentGlobal = (currentPrefs.global as Record<string, unknown>) ?? {};
      const nextPrefs = {
        ...currentPrefs,
        global: { ...currentGlobal, period: next },
      };
      const { error } = await supabase.from("tenant_view_preferences").upsert(
        {
          tenant_id: profile.tenant_id,
          prefs: nextPrefs,
          updated_by: profile.id ?? undefined,
        },
        { onConflict: "tenant_id" },
      );
      if (error) throw error;
      await qc.invalidateQueries({ queryKey: ["tenant-view-prefs", profile.tenant_id] });
      toast.success("Período padrão atualizado.");
    } catch (err) {
      toast.error(userFacingErrorMessage(err, "Não foi possível salvar."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="flex items-center gap-2 text-card-title">
          <Eye className="h-4 w-4" aria-hidden />
          Período padrão
        </CardTitle>
        <p className="text-caption text-muted-foreground">
          Período que a Visão geral, os Relatórios e as Conversas carregam ao entrar no app.
          Usuários podem trocar temporariamente pelo topo — não afeta este padrão.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1 space-y-1">
          <Label htmlFor="tenant-period">Período padrão da empresa</Label>
          <Select
            value={tenantDefault}
            onValueChange={(v) => void setDefault(v as PeriodKey)}
            disabled={readOnly || saving}
          >
            <SelectTrigger id="tenant-period">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PERIOD_OPTIONS.map((o) => (
                <SelectItem key={o.key} value={o.key}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {isSessionOverride && (
          <Button type="button" variant="ghost" size="sm" onClick={clearSessionOverride}>
            <RotateCcw className="mr-1 h-3.5 w-3.5" aria-hidden />
            Voltar ao default nesta sessão
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function PageSection({
  pageKey,
  label,
  readOnly,
}: {
  pageKey: PageKey;
  label: string;
  readOnly: boolean;
}) {
  const view = useViewPrefs();
  const update = useUpdateViewPref();
  const reset = useResetPageViewPrefs();
  const widgets = listPages().find((p) => p.key === pageKey)?.widgets ?? [];

  function onToggle(key: string, next: boolean) {
    update.mutate(
      { page: pageKey, key, value: next },
      {
        onError: (err) =>
          toast.error(userFacingErrorMessage(err, "Não foi possível salvar sua preferência.")),
      },
    );
  }

  function onReset() {
    reset.mutate(
      { page: pageKey },
      {
        onSuccess: () => toast.success("Padrões restaurados."),
        onError: (err) =>
          toast.error(userFacingErrorMessage(err, "Não foi possível restaurar os padrões.")),
      },
    );
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-card-title">
          <Eye className="h-4 w-4" aria-hidden />
          {label}
          {readOnly && (
            <Badge variant="outline" className="ml-2 text-caption">
              Somente leitura
            </Badge>
          )}
        </CardTitle>
        <ReadOnlyGate readOnly={readOnly}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onReset}
            disabled={readOnly || reset.isPending}
          >
            <RotateCcw className="mr-1 h-3.5 w-3.5" aria-hidden />
            Restaurar padrão
          </Button>
        </ReadOnlyGate>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-border">
          {widgets.map((w) => {
            const visible = view.isVisible(pageKey, w.key);
            const id = `viewpref-${pageKey}-${w.key}`;
            return (
              <li key={w.key} className="flex items-start justify-between gap-4 py-3">
                <div className="min-w-0 flex-1">
                  <Label htmlFor={id} className="text-body font-medium text-foreground">
                    {w.label}
                  </Label>
                  <p className="mt-0.5 text-caption text-muted-foreground">{w.description}</p>
                </div>
                <Switch
                  id={id}
                  checked={visible}
                  onCheckedChange={(v) => onToggle(w.key, v)}
                  disabled={readOnly || update.isPending}
                  aria-label={`Mostrar ${w.label}`}
                />
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

function BackupCard({ readOnly }: { readOnly: boolean }) {
  const { data: profile } = useCurrentProfile();
  const view = useViewPrefs();
  const replace = useReplaceViewPrefs();
  const inputRef = useRef<HTMLInputElement>(null);
  // O arquivo já foi lido e validado quando o dialog abre — guardar o
  // resultado evita reler o File depois que o input já foi limpo.
  const [pendingImport, setPendingImport] = useState<{
    prefs: ViewPrefsMap;
    count: number;
  } | null>(null);

  function onExport() {
    const slug = profile?.tenant_id?.slice(0, 8) ?? "tenant";
    downloadPrefsJson(view.prefs, slug);
    toast.success("Preferências exportadas.");
  }

  async function onImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const raw = await readFileAsJson(file);
      const parsed = parseImportedPrefs(raw);
      const count = Object.values(parsed).reduce((n, p) => n + Object.keys(p).length, 0);
      if (count === 0) {
        toast.error("Nenhuma preferência válida encontrada no arquivo.");
        return;
      }
      setPendingImport({ prefs: parsed, count });
    } catch {
      // Só dois erros chegam aqui: JSON.parse e o schema do Zod. Os dois falam
      // inglês ("Unexpected token < in JSON at position 0", "Expected object,
      // received string") e nenhum dos dois diz ao operador o que fazer.
      toast.error("Arquivo inválido — use o JSON exportado por esta tela.");
    }
  }

  function confirmImport() {
    if (!pendingImport) return;
    replace.mutate(
      { prefs: pendingImport.prefs, mode: "merge" },
      {
        onSuccess: () => toast.success("Preferências importadas."),
        onError: (err) => toast.error(userFacingErrorMessage(err, "Não foi possível importar.")),
      },
    );
    setPendingImport(null);
  }

  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="flex items-center gap-2 text-card-title">
          <Download className="h-4 w-4" aria-hidden />
          Backup de preferências
        </CardTitle>
        <p className="flex items-start gap-1.5 text-caption text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden />
          Exporte para migrar entre ambientes. O arquivo NÃO contém credenciais nem dados de negócio
          — só quais widgets aparecem em cada página.
        </p>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={onExport}>
          <Download className="mr-1.5 h-4 w-4" aria-hidden />
          Exportar JSON
        </Button>
        <ReadOnlyGate readOnly={readOnly}>
          <Button
            type="button"
            variant="outline"
            disabled={readOnly || replace.isPending}
            onClick={() => inputRef.current?.click()}
          >
            <Upload className="mr-1.5 h-4 w-4" aria-hidden />
            Importar JSON
          </Button>
        </ReadOnlyGate>
        <input
          ref={inputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={onImportFile}
        />
      </CardContent>

      <AlertDialog open={!!pendingImport} onOpenChange={(open) => !open && setPendingImport(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Aplicar as preferências do arquivo?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingImport?.count === 1
                ? "1 preferência do arquivo será aplicada por cima das atuais."
                : `${pendingImport?.count ?? 0} preferências do arquivo serão aplicadas por cima das atuais.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={confirmImport}>Aplicar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function ReadOnlyGate({ readOnly, children }: { readOnly: boolean; children: React.ReactNode }) {
  if (!readOnly) return <>{children}</>;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">{children}</span>
        </TooltipTrigger>
        <TooltipContent>Apenas administradores.</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
