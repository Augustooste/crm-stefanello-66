import { useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { ArrowLeft, Merge, Users } from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/common/PageHeader";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useDuplicateGroups,
  useMergeContactGroup,
  friendlyMergeErrorMessage,
  type DuplicateGroup,
} from "@/hooks/use-contact-duplicates";
import { formatDate } from "@/lib/format";

export const Route = createFileRoute("/_app/contatos/duplicados")({
  head: () => ({
    meta: [
      { title: "Contatos duplicados" },
      {
        name: "description",
        content: "Revise grupos de contatos prováveis duplicados e funda-os preservando histórico.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: DuplicateContactsPage,
});

const MATCH_LABEL: Record<DuplicateGroup["matchType"], string> = {
  phone: "Mesmo telefone",
  email: "Mesmo e-mail",
};

function DuplicateContactsPage() {
  const duplicatesQuery = useDuplicateGroups();
  const groups = duplicatesQuery.data ?? [];

  return (
    <div className="col-span-12 flex flex-col gap-4">
      <PageHeader
        title="Contatos duplicados"
        description={
          duplicatesQuery.isLoading
            ? "Procurando duplicados…"
            : groups.length === 0
              ? "Nenhum grupo duplicado encontrado"
              : `${groups.length} grupo(s) com prováveis duplicados`
        }
        actions={
          <Button variant="outline" asChild>
            <Link to="/contatos">
              <ArrowLeft className="mr-1 h-4 w-4" /> Voltar para contatos
            </Link>
          </Button>
        }
      />

      {duplicatesQuery.isLoading ? (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-32 w-full rounded-lg" />
          ))}
        </div>
      ) : duplicatesQuery.isError ? (
        <EmptyState
          title="Erro ao buscar duplicados"
          description={(duplicatesQuery.error as Error).message}
          actionLabel="Tentar novamente"
          onAction={() => duplicatesQuery.refetch()}
        />
      ) : groups.length === 0 ? (
        <EmptyState
          icon={Users}
          title="Nenhum contato duplicado"
          description="Não encontramos grupos com o mesmo telefone ou e-mail na sua base."
        />
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((group) => (
            <DuplicateGroupCard key={group.key} group={group} />
          ))}
        </div>
      )}
    </div>
  );
}

function DuplicateGroupCard({ group }: { group: DuplicateGroup }) {
  const [targetId, setTargetId] = useState(group.contacts[0]?.id ?? "");
  const mergeMutation = useMergeContactGroup();

  const handleMerge = () => {
    const sourceIds = group.contacts.map((c) => c.id).filter((id) => id !== targetId);
    if (sourceIds.length === 0) return;

    mergeMutation.mutate(
      { targetId, sourceIds },
      {
        onSuccess: () => {
          const targetName = group.contacts.find((c) => c.id === targetId)?.name ?? "principal";
          toast.success(`Grupo fundido em "${targetName}"`);
        },
        onError: (error) => {
          toast.error(friendlyMergeErrorMessage(error));
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-4">
        <div>
          <CardTitle className="text-card-title">{MATCH_LABEL[group.matchType]}</CardTitle>
          <p className="mt-1 text-caption text-muted-foreground">{group.matchValue}</p>
        </div>
        <Button
          size="sm"
          onClick={handleMerge}
          disabled={mergeMutation.isPending || !targetId}
          aria-label={`Fundir grupo de ${MATCH_LABEL[group.matchType].toLowerCase()} ${group.matchValue}`}
        >
          <Merge className="mr-1 h-4 w-4" />
          {mergeMutation.isPending ? "Fundindo…" : "Fundir grupo"}
        </Button>
      </CardHeader>
      <CardContent>
        <p className="mb-2 text-caption text-muted-foreground">
          Escolha qual contato é o "principal" — ele absorve os demais, preservando negócios,
          conversas e atividades.
        </p>
        <RadioGroup value={targetId} onValueChange={setTargetId} className="gap-3">
          {group.contacts.map((contact) => (
            <Label
              key={contact.id}
              htmlFor={`${group.key}-${contact.id}`}
              className="flex cursor-pointer items-center gap-3 rounded-md border border-border p-3 hover:bg-muted"
            >
              <RadioGroupItem value={contact.id} id={`${group.key}-${contact.id}`} />
              <div className="flex flex-1 flex-wrap items-center gap-x-4 gap-y-1 text-body">
                <span className="font-medium text-foreground">{contact.name}</span>
                <span className="text-muted-foreground">{contact.phone || "—"}</span>
                <span className="text-muted-foreground">{contact.email || "—"}</span>
                <span className="text-caption text-muted-foreground">
                  Criado em {formatDate(contact.created_at)}
                </span>
              </div>
            </Label>
          ))}
        </RadioGroup>
      </CardContent>
    </Card>
  );
}
