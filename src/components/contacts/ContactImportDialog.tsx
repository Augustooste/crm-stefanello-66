import { useRef, useState } from "react";
import { FileUp, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { StatusBadge } from "@/components/common/StatusBadge";
import {
  useContactImport,
  parseContactImportFile,
  type ContactImportPreview,
} from "@/hooks/use-contact-import";
import type { ContactImportMode, ContactImportReport } from "@/lib/contact-import";

/** Campos core exibidos no preview de mapeamento (exclui `stage`, que é
 * tratado à parte — ver nota em `stageHeaderDetected`). */
type MappedDisplayField = "name" | "phone" | "email" | "tags" | "notes";

const MODE_OPTIONS: Array<{ value: ContactImportMode; label: string; description: string }> = [
  {
    value: "upsert_por_telefone",
    label: "Atualizar por telefone",
    description:
      "Se o telefone já existir na base, atualiza o contato. Caso contrário, cria um novo.",
  },
  {
    value: "criar_apenas",
    label: "Criar apenas",
    description: "Sempre cria um contato novo, mesmo que o telefone já exista na base.",
  },
  {
    value: "pular_duplicados",
    label: "Pular duplicados",
    description: "Ignora linhas cujo telefone já existe na base — não cria nem atualiza.",
  },
];

const FIELD_LABELS: Record<MappedDisplayField, string> = {
  name: "Nome",
  phone: "Telefone",
  email: "E-mail",
  tags: "Etiquetas",
  notes: "Notas",
};

type Step = "select" | "preview" | "report";

interface ContactImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ContactImportDialog({ open, onOpenChange }: ContactImportDialogProps) {
  const [step, setStep] = useState<Step>("select");
  const [preview, setPreview] = useState<ContactImportPreview | null>(null);
  const [mode, setMode] = useState<ContactImportMode>("upsert_por_telefone");
  const [report, setReport] = useState<ContactImportReport | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { runImport, isImporting } = useContactImport();

  const reset = () => {
    setStep("select");
    setPreview(null);
    setMode("upsert_por_telefone");
    setReport(null);
    setIsParsing(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleOpenChange = (v: boolean) => {
    if (!v) reset();
    onOpenChange(v);
  };

  const handleFileSelected = async (file: File | undefined) => {
    if (!file) return;
    setIsParsing(true);
    try {
      const parsed = await parseContactImportFile(file);
      if (parsed.totalRows === 0) {
        toast.error("CSV sem linhas de dados para importar.");
        return;
      }
      setPreview(parsed);
      setStep("preview");
    } catch (e) {
      toast.error((e as Error)?.message ?? "Não foi possível ler o arquivo CSV.");
    } finally {
      setIsParsing(false);
    }
  };

  const handleImport = async () => {
    if (!preview) return;
    try {
      const result = await runImport({ preview, mode });
      setReport(result);
      setStep("report");
    } catch (e) {
      toast.error((e as Error)?.message ?? "Erro ao importar contatos.");
    }
  };

  const mappedFields = preview
    ? (Object.keys(FIELD_LABELS) as MappedDisplayField[]).filter(
        (field) => preview.mapping[field] !== undefined,
      )
    : [];

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Importar contatos via CSV</DialogTitle>
          <DialogDescription>
            {step === "select" && "Selecione um arquivo CSV com sua base de contatos."}
            {step === "preview" &&
              "Confira o mapeamento de colunas e escolha o que fazer com duplicados."}
            {step === "report" && "Import concluído."}
          </DialogDescription>
        </DialogHeader>

        {step === "select" && (
          <div className="space-y-3">
            <label
              htmlFor="contact-import-file"
              className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed border-border p-8 text-center hover:bg-muted/50"
            >
              <FileUp className="h-6 w-6 text-muted-foreground" aria-hidden />
              <span className="text-body font-medium">Clique para escolher um arquivo .csv</span>
              <span className="text-caption text-muted-foreground">
                Delimitador (, ; ou tab) é detectado automaticamente
              </span>
            </label>
            <input
              ref={fileInputRef}
              id="contact-import-file"
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              disabled={isParsing}
              onChange={(e) => handleFileSelected(e.target.files?.[0])}
            />
            {isParsing && (
              <p className="flex items-center gap-2 text-caption text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Lendo arquivo…
              </p>
            )}
          </div>
        )}

        {step === "preview" && preview && (
          <div className="space-y-4">
            <div>
              <p className="mb-1 text-caption font-medium text-muted-foreground">
                {preview.totalRows} linha(s) de dados encontradas
              </p>
              <div className="flex flex-wrap gap-1">
                {mappedFields.map((field) => (
                  <StatusBadge key={field} variant="success">
                    {FIELD_LABELS[field]}
                  </StatusBadge>
                ))}
              </div>
            </div>

            {preview.stageHeaderDetected && (
              <p className="rounded-md bg-muted p-2 text-caption text-muted-foreground">
                Coluna de estágio/etapa detectada, mas ainda não há campo correspondente em contatos
                nesta versão — o valor não será importado.
              </p>
            )}

            {preview.ignoredHeaders.length > 0 && (
              <p className="rounded-md bg-muted p-2 text-caption text-muted-foreground">
                Coluna(s) ignorada(s) (sem sinônimo reconhecido):{" "}
                <strong>{preview.ignoredHeaders.join(", ")}</strong>
              </p>
            )}

            <Separator />

            <div className="space-y-2">
              <Label>O que fazer com telefones duplicados?</Label>
              <RadioGroup value={mode} onValueChange={(v) => setMode(v as ContactImportMode)}>
                {MODE_OPTIONS.map((opt) => (
                  <label
                    key={opt.value}
                    className="flex cursor-pointer items-start gap-2 rounded-md p-1.5 hover:bg-muted"
                  >
                    <RadioGroupItem value={opt.value} id={`mode-${opt.value}`} className="mt-0.5" />
                    <span>
                      <span className="block text-body font-medium">{opt.label}</span>
                      <span className="block text-caption text-muted-foreground">
                        {opt.description}
                      </span>
                    </span>
                  </label>
                ))}
              </RadioGroup>
            </div>
          </div>
        )}

        {step === "report" && report && (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-md border border-border p-3">
                <p className="text-h3 font-semibold">{report.criados}</p>
                <p className="text-caption text-muted-foreground">Criados</p>
              </div>
              <div className="rounded-md border border-border p-3">
                <p className="text-h3 font-semibold">{report.atualizados}</p>
                <p className="text-caption text-muted-foreground">Atualizados</p>
              </div>
              <div className="rounded-md border border-border p-3">
                <p className="text-h3 font-semibold">{report.ignorados}</p>
                <p className="text-caption text-muted-foreground">Ignorados</p>
              </div>
            </div>

            {report.erros.length > 0 && (
              <div>
                <p className="mb-1 text-caption font-medium text-destructive">
                  {report.erros.length} linha(s) com erro
                </p>
                <ScrollArea className="h-40 rounded-md border border-border p-2">
                  <ul className="space-y-1 text-caption text-muted-foreground">
                    {report.erros.map((err, i) => (
                      <li key={`${err.linha}-${i}`}>
                        Linha {err.linha}: {err.motivo}
                      </li>
                    ))}
                  </ul>
                </ScrollArea>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {step === "preview" && (
            <>
              <Button variant="outline" onClick={() => setStep("select")}>
                Voltar
              </Button>
              <Button onClick={handleImport} disabled={isImporting}>
                {isImporting && <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />}
                Importar {preview?.totalRows} contato(s)
              </Button>
            </>
          )}
          {step === "report" && <Button onClick={() => handleOpenChange(false)}>Concluir</Button>}
          {step === "select" && (
            <Button variant="outline" onClick={() => handleOpenChange(false)}>
              Cancelar
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
