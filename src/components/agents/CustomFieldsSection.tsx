// Campos customizados do provedor de agentes — escopo de WORKSPACE, não do agente.
// São os campos usados pelas variáveis de intenção (`customField{...}`) do
// contrato. Não há endpoint de exclusão: só arquivar/desarquivar (ver
// contracts/agent-platform/CONTRACT_MATRIX.md §1.10).
import { useState } from "react";
import { Archive, ArchiveRestore, AlertTriangle, Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/common/EmptyState";
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
import { Switch } from "@/components/ui/switch";
import { CUSTOM_FIELD_TYPES, type CustomFieldType } from "@/integrations/agent-platform/enums.gen";
import { useAgentPlatformMutation, useAgentPlatformQuery } from "@/lib/api/agent-platform";
import type { AgentPlatformCustomField } from "@/lib/api/agent-platform-contract";

const TYPE_LABELS: Record<CustomFieldType, string> = {
  STRING: "Texto",
  DATE: "Data",
  DATE_TIME: "Data e hora",
  NUMBER: "Número",
  BOOLEAN: "Verdadeiro/Falso",
  MONEY: "Valor monetário",
};

/**
 * ACHADO (fora de D1-D14): o contrato documenta a resposta 200 de
 * `GET /v2/custom-field/workspace/{workspaceId}` como um objeto ÚNICO — não
 * como array nem como envelope paginado — apesar do endpoint aceitar
 * `page`/`pageSize`/`query`. Normalizamos defensivamente: se vier array,
 * usamos direto; se vier um objeto com `id`, tratamos como item único; caso
 * contrário, lista vazia.
 */
function toItems(
  value: AgentPlatformCustomField | AgentPlatformCustomField[] | null | undefined,
): AgentPlatformCustomField[] {
  if (Array.isArray(value)) return value;
  if (value && "id" in value) return [value];
  return [];
}

export function CustomFieldsSection() {
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [formOpen, setFormOpen] = useState<{ field?: AgentPlatformCustomField } | null>(null);

  const listQ = useAgentPlatformQuery("customFields.list", {
    params: { page: 1, pageSize: 100, query: search.trim() || undefined },
  });

  const toggleArchive = useAgentPlatformMutation("customField.toggleArchive", {
    invalidate: ["customFields.list"],
    onSuccess: () => toast.success("Campo atualizado"),
    onError: (e) => toast.error(e.message),
  });

  const items = toItems(listQ.data).filter((f) => (showArchived ? true : !f.archived));

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        {/* O título já está no AccordionTrigger — aqui só a descrição, sem repetir o heading. */}
        <CardDescription>
          Campos do workspace do provedor de agentes (não são exclusivos deste agente) — usados
          pelas intenções para capturar dados de variáveis.
        </CardDescription>
        <Button size="sm" onClick={() => setFormOpen({})}>
          <Plus className="mr-1 h-4 w-4" /> Novo campo
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <Input
            placeholder="Buscar por nome…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-xs"
            aria-label="Buscar campo customizado"
          />
          <label className="flex items-center gap-2 text-caption text-muted-foreground">
            <Switch checked={showArchived} onCheckedChange={setShowArchived} />
            Mostrar arquivados
          </label>
        </div>

        {listQ.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : listQ.error ? (
          <EmptyState
            icon={AlertTriangle}
            title="Não foi possível carregar os campos customizados"
            description={listQ.error.message}
            actionLabel="Tentar de novo"
            onAction={() => listQ.refetch()}
          />
        ) : items.length === 0 ? (
          <EmptyState
            title="Sem campos customizados"
            description="Crie campos para capturar dados nas intenções deste agente."
          />
        ) : (
          <ul className="divide-y divide-border">
            {items.map((f, i) => (
              <li key={f.id ?? i} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="text-body font-medium text-foreground">
                    {f.name}
                    {f.archived && (
                      <span className="ml-2 text-caption text-muted-foreground">(arquivado)</span>
                    )}
                  </div>
                  <div className="text-caption text-muted-foreground">
                    {(f.type && TYPE_LABELS[f.type]) ?? f.type ?? "—"} · jsonName:{" "}
                    {f.jsonName ?? "—"}
                  </div>
                </div>
                <Button variant="outline" size="sm" onClick={() => setFormOpen({ field: f })}>
                  Editar
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={f.archived ? `Desarquivar ${f.name}` : `Arquivar ${f.name}`}
                  disabled={!f.id || toggleArchive.isPending}
                  onClick={() =>
                    f.id &&
                    toggleArchive.mutate({
                      params: { customfieldId: f.id, archived: !f.archived },
                    })
                  }
                >
                  {f.archived ? (
                    <ArchiveRestore className="h-4 w-4" />
                  ) : (
                    <Archive className="h-4 w-4" />
                  )}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      {formOpen && (
        <CustomFieldFormDialog
          open
          onOpenChange={(v) => !v && setFormOpen(null)}
          field={formOpen.field}
        />
      )}
    </Card>
  );
}

function CustomFieldFormDialog({
  open,
  onOpenChange,
  field,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  field?: AgentPlatformCustomField;
}) {
  const [name, setName] = useState(field?.name ?? "");
  const [jsonName, setJsonName] = useState(field?.jsonName ?? "");
  const [description, setDescription] = useState(field?.description ?? "");
  const [type, setType] = useState<CustomFieldType>(field?.type ?? "STRING");

  const createMut = useAgentPlatformMutation("customFields.create", {
    invalidate: ["customFields.list"],
    onSuccess: () => {
      toast.success("Campo criado");
      onOpenChange(false);
    },
    onError: (e) => toast.error(e.message),
  });

  const updateMut = useAgentPlatformMutation("customField.update", {
    invalidate: ["customFields.list"],
    onSuccess: () => {
      toast.success("Campo atualizado");
      onOpenChange(false);
    },
    onError: (e) => toast.error(e.message),
  });

  const isPending = createMut.isPending || updateMut.isPending;

  function handleSave() {
    if (field?.id) {
      updateMut.mutate({
        params: { customfieldId: field.id },
        body: { name: name.trim(), jsonName: jsonName.trim(), description, type },
      });
    } else {
      createMut.mutate({
        body: { name: name.trim(), jsonName: jsonName.trim(), description, type },
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{field ? "Editar campo customizado" : "Novo campo customizado"}</DialogTitle>
          <DialogDescription>
            Campo do workspace do provedor de agentes — disponível para todos os agentes.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="cf-name">Nome *</Label>
            <Input id="cf-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cf-json-name">jsonName *</Label>
            <Input
              id="cf-json-name"
              value={jsonName}
              onChange={(e) => setJsonName(e.target.value)}
              placeholder="ex.: nome_do_cliente"
            />
            <p className="text-caption text-muted-foreground">
              Chave usada para referenciar este campo nas variáveis de intenção.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cf-description">Descrição</Label>
            <Input
              id="cf-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Tipo</Label>
            <Select value={type} onValueChange={(v) => setType(v as CustomFieldType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CUSTOM_FIELD_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {TYPE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button disabled={!name.trim() || !jsonName.trim() || isPending} onClick={handleSave}>
            {isPending ? "Salvando…" : "Salvar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
