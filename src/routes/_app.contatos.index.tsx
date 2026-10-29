import { useMemo, useState } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  Copy,
  Download,
  Handshake,
  Loader2,
  Plus,
  Search,
  Trash2,
  Upload,
  UserPlus,
  X,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { PageHeader } from "@/components/common/PageHeader";
import { EmptyState } from "@/components/common/EmptyState";
import { StatusBadge } from "@/components/common/StatusBadge";
import { ContactFormDialog, type ContactRow } from "@/components/contacts/ContactFormDialog";
import { ContactImportDialog } from "@/components/contacts/ContactImportDialog";
import { ContactBulkActionsBar } from "@/components/contacts/ContactBulkActionsBar";
import { ContactBulkResultDialog } from "@/components/contacts/ContactBulkResultDialog";
import { useContactExport } from "@/hooks/use-contact-export";
import {
  useBulkContactActions,
  type ContactBulkActionReport,
} from "@/hooks/use-bulk-contact-actions";
import { useCurrentProfile, useTenantProfiles } from "@/lib/api/session";
import { InitialsAvatar } from "@/components/common/InitialsAvatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { supabase } from "@/integrations/supabase/client";
import { formatDate } from "@/lib/format";

const PAGE_SIZE = 10;

type ContactStatus = "lead" | "contact";
type StatusFilter = "all" | ContactStatus;

// Fase 4 PR-B (user story J) -- staging leve lead/contact (ver
// supabase/migrations/20260711100300_fase4_prb_contacts_staging.sql). ContactRow
// (ContactFormDialog) ainda não inclui as colunas novas -- estende localmente,
// mesmo padrão de ContactDetailRow em _app.contatos.$id.tsx.
type ContactListRow = ContactRow & {
  status: ContactStatus;
  owner_id: string | null;
};

export const Route = createFileRoute("/_app/contatos/")({
  head: () => ({
    meta: [
      { title: "Contatos" },
      {
        name: "description",
        content: "Base de leads e clientes com busca, filtros e histórico completo.",
      },
      { property: "og:title", content: "Contatos" },
      {
        property: "og:description",
        content: "Base de leads e clientes com busca, filtros e histórico completo.",
      },
      { property: "og:url", content: "https://aceleraflow.lovable.app/contatos" },
      { name: "twitter:title", content: "Contatos" },
      {
        name: "twitter:description",
        content: "Base de leads e clientes com busca, filtros e histórico completo.",
      },
    ],
    links: [{ rel: "canonical", href: "https://aceleraflow.lovable.app/contatos" }],
  }),
  component: ContactsPage,
});

function ContactsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [onlyMine, setOnlyMine] = useState(false);
  const [page, setPage] = useState(1);
  const [openNew, setOpenNew] = useState(false);
  const [openImport, setOpenImport] = useState(false);
  const [deleting, setDeleting] = useState<ContactRow | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkResult, setBulkResult] = useState<{
    actionLabel: string;
    report: ContactBulkActionReport;
  } | null>(null);
  const { exportContacts, isExporting } = useContactExport();
  const { applyTag, isApplyingTag, bulkSoftDelete, isBulkDeleting } = useBulkContactActions();
  const { data: profile } = useCurrentProfile();
  const { data: tenantProfiles = [] } = useTenantProfiles();

  const contactsQuery = useQuery({
    queryKey: ["contacts"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("contacts")
        .select(
          "id, tenant_id, name, phone, email, source, tags, notes, ai_paused, status, owner_id, created_at",
        )
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as ContactListRow[];
    },
  });

  const contacts = useMemo(() => contactsQuery.data ?? [], [contactsQuery.data]);

  const ownerNameById = useMemo(() => {
    const map: Record<string, string> = {};
    tenantProfiles.forEach((p) => {
      map[p.id] = p.name;
    });
    return map;
  }, [tenantProfiles]);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    contacts.forEach((c) => c.tags?.forEach((t) => set.add(t)));
    ["Quente", "Frio", "Indicação", "Site", "VIP"].forEach((t) => set.add(t));
    return Array.from(set).sort();
  }, [contacts]);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    return contacts.filter((c) => {
      if (t && ![c.name, c.phone ?? "", c.email ?? ""].some((v) => v.toLowerCase().includes(t)))
        return false;
      if (tags.length && !tags.some((tag) => c.tags?.includes(tag))) return false;
      if (statusFilter !== "all" && c.status !== statusFilter) return false;
      if (onlyMine && c.owner_id !== profile?.id) return false;
      return true;
    });
  }, [contacts, q, tags, statusFilter, onlyMine, profile?.id]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const paged = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const hasActiveFilters = q !== "" || tags.length > 0 || statusFilter !== "all" || onlyMine;

  const clearSearch = () => {
    setQ("");
    setTags([]);
    setStatusFilter("all");
    setOnlyMine(false);
    setPage(1);
  };

  const namesById = useMemo(() => {
    const map: Record<string, string | undefined> = {};
    contacts.forEach((c) => {
      map[c.id] = c.name;
    });
    return map;
  }, [contacts]);

  const filteredIds = useMemo(() => filtered.map((c) => c.id), [filtered]);
  const allFilteredSelected =
    filteredIds.length > 0 && filteredIds.every((id) => selectedIds.has(id));
  const someFilteredSelected = filteredIds.some((id) => selectedIds.has(id));

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAllFiltered = () => {
    setSelectedIds((prev) => {
      if (allFilteredSelected) {
        const next = new Set(prev);
        filteredIds.forEach((id) => next.delete(id));
        return next;
      }
      return new Set([...prev, ...filteredIds]);
    });
  };

  const clearSelection = () => setSelectedIds(new Set());

  const deleteMut = useMutation({
    mutationFn: async (id: string) => {
      // Soft delete — nunca DELETE físico, que dispararia cascade em
      // conversations/messages e apagaria histórico de conversa sem aviso
      // (mesmo critério de aceite do bulk delete, aplicado aqui à exclusão
      // individual pré-existente que ainda usava .delete()).
      const { error } = await supabase
        .from("contacts")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
      return id;
    },
    onSuccess: (id) => {
      qc.invalidateQueries({ queryKey: ["contacts"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      toast.success("Contato excluído");
      setDeleting(null);
      // Mesmo cuidado do bulk delete: nunca deixar um id excluído preso em
      // selectedIds (contaria em selectedCount/checkbox "selecionar todos"
      // um contato que já não existe mais na lista).
      setSelectedIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    },
    onError: (e: Error) => toast.error(e.message ?? "Erro ao excluir"),
  });

  const assumeOwnerMut = useMutation({
    mutationFn: async (contactId: string) => {
      if (!profile) throw new Error("Perfil não carregado");
      // Só toca owner_id -- NÃO muda status (critério de aceite: assumir um
      // lead/contact sem dono não deve reclassificar lead<->contact como
      // side-effect). `.is("owner_id", null)` é guarda extra contra corrida:
      // se outro agente já assumiu entre o clique e o UPDATE, esta linha não
      // casa e o update vira no-op silencioso ao invés de roubar o dono alheio.
      const { error } = await supabase
        .from("contacts")
        .update({ owner_id: profile.id })
        .eq("id", contactId)
        .is("owner_id", null);
      if (error) throw error;
      return contactId;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contacts"] });
      toast.success("Contato assumido");
    },
    onError: (e: Error) => toast.error(e.message ?? "Erro ao assumir contato"),
  });

  const handleExport = async () => {
    try {
      const { recordsCount } = await exportContacts({ search: q, tags });
      toast.success(`${recordsCount} contato(s) exportado(s)`);
    } catch (e) {
      toast.error((e as Error)?.message ?? "Erro ao exportar contatos");
    }
  };

  const handleBulkApplyTag = async (tag: string) => {
    const contactIds = Array.from(selectedIds);
    try {
      const report = await applyTag({ contactIds, tag });
      // Modal de relatório só quando há falha — sucesso 100% já vira toast.
      if (report.falhas > 0) setBulkResult({ actionLabel: `aplicar etiqueta "${tag}"`, report });
      // Colapsa a seleção para só os que falharam — os que tiveram sucesso
      // saem da lista após o refetch (ex.: soft-delete) ou já receberam a
      // etiqueta; manter seus ids selecionados aplicaria uma próxima ação
      // em lote sobre contatos que não fazem mais parte do que o usuário vê.
      setSelectedIds(new Set(report.erros.map((e) => e.id)));
      if (report.falhas === 0) {
        toast.success(`Etiqueta "${tag}" aplicada em ${report.sucesso} contato(s)`);
      } else {
        toast.error(`${report.sucesso} sucesso(s), ${report.falhas} falha(s) — ver detalhes`);
      }
    } catch (e) {
      toast.error((e as Error)?.message ?? "Erro ao aplicar etiqueta em lote");
    }
  };

  const handleBulkDelete = async () => {
    const contactIds = Array.from(selectedIds);
    try {
      const report = await bulkSoftDelete(contactIds);
      if (report.falhas > 0) setBulkResult({ actionLabel: "excluir contatos", report });
      // Idem: seleção colapsa para os que falharam (os excluídos com sucesso
      // somem da lista após o refetch — não faz sentido mantê-los selecionados).
      setSelectedIds(new Set(report.erros.map((e) => e.id)));
      if (report.falhas === 0) {
        toast.success(`${report.sucesso} contato(s) excluído(s)`);
      } else {
        toast.error(`${report.sucesso} sucesso(s), ${report.falhas} falha(s) — ver detalhes`);
      }
    } catch (e) {
      toast.error((e as Error)?.message ?? "Erro ao excluir contatos em lote");
    }
  };

  return (
    <div className="col-span-12 flex flex-col gap-4">
      <PageHeader
        title="Contatos"
        description={
          contactsQuery.isLoading ? "Carregando…" : `${contacts.length} contatos na base`
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" asChild>
              <Link to="/contatos/duplicados">
                <Copy className="mr-1 h-4 w-4" /> Ver duplicados
              </Link>
            </Button>
            <Button variant="outline" onClick={() => setOpenImport(true)}>
              <Upload className="mr-1 h-4 w-4" /> Importar CSV
            </Button>
            <Button variant="outline" onClick={handleExport} disabled={isExporting}>
              {isExporting ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Download className="mr-1 h-4 w-4" />
              )}
              Exportar CSV
            </Button>
            <Button onClick={() => setOpenNew(true)}>
              <Plus className="mr-1 h-4 w-4" /> Novo contato
            </Button>
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
          <Input
            aria-label="Buscar contatos"
            placeholder="Buscar por nome, telefone ou e-mail…"
            className="pl-8"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <div className="flex items-center gap-2">
          <Label className="text-caption text-muted-foreground">Etiquetas</Label>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="h-9">
                {tags.length ? `${tags.length} selecionada(s)` : "Todas"}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-56 p-2">
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {allTags.length === 0 && (
                  <p className="p-2 text-caption text-muted-foreground">Nenhuma etiqueta ainda</p>
                )}
                {allTags.map((t) => {
                  const checked = tags.includes(t);
                  return (
                    <label
                      key={t}
                      className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 hover:bg-muted"
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(v) =>
                          setTags((prev) => (v ? [...prev, t] : prev.filter((x) => x !== t)))
                        }
                      />
                      <span className="text-body">{t}</span>
                    </label>
                  );
                })}
              </div>
            </PopoverContent>
          </Popover>
        </div>
        <div className="flex items-center gap-2">
          <Label className="text-caption text-muted-foreground">Situação</Label>
          <Select
            value={statusFilter}
            onValueChange={(v) => {
              setStatusFilter(v as StatusFilter);
              setPage(1);
            }}
          >
            <SelectTrigger className="h-9 w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              <SelectItem value="lead">Lead</SelectItem>
              <SelectItem value="contact">Contato</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <label
          className={`flex items-center gap-2 ${profile ? "cursor-pointer" : "cursor-not-allowed opacity-60"}`}
        >
          <Checkbox
            aria-label="Mostrar apenas meus contatos"
            checked={onlyMine}
            disabled={!profile}
            onCheckedChange={(v) => {
              setOnlyMine(!!v);
              setPage(1);
            }}
          />
          <span className="text-caption text-muted-foreground">Meus contatos</span>
        </label>
      </div>

      <ContactBulkActionsBar
        selectedCount={selectedIds.size}
        allTags={allTags}
        onApplyTag={handleBulkApplyTag}
        onDelete={handleBulkDelete}
        onClearSelection={clearSelection}
        isApplyingTag={isApplyingTag}
        isDeleting={isBulkDeleting}
      />

      <div className="rounded-lg border border-border bg-surface">
        {contactsQuery.isLoading ? (
          <div className="p-4 space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-8 w-8 rounded-full" />
                <Skeleton className="h-4 flex-1" />
              </div>
            ))}
          </div>
        ) : contactsQuery.isError ? (
          <div className="p-6">
            <EmptyState
              title="Erro ao carregar contatos"
              description={(contactsQuery.error as Error).message}
              actionLabel="Tentar novamente"
              onAction={() => contactsQuery.refetch()}
            />
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-6">
            <EmptyState
              title={contacts.length === 0 ? "Nenhum contato ainda" : "Nenhum contato encontrado"}
              description={
                contacts.length === 0
                  ? "Comece adicionando seu primeiro contato."
                  : "Ajuste a busca ou os filtros para tentar de novo."
              }
              actionLabel={contacts.length === 0 ? "Novo contato" : "Limpar busca"}
              onAction={contacts.length === 0 ? () => setOpenNew(true) : clearSearch}
            />
          </div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      aria-label="Selecionar todos os contatos filtrados"
                      checked={
                        allFilteredSelected ? true : someFilteredSelected ? "indeterminate" : false
                      }
                      onCheckedChange={toggleSelectAllFiltered}
                    />
                  </TableHead>
                  <TableHead>Nome</TableHead>
                  <TableHead>Telefone</TableHead>
                  <TableHead>E-mail</TableHead>
                  <TableHead>Etiquetas</TableHead>
                  <TableHead>Origem</TableHead>
                  <TableHead>Dono</TableHead>
                  <TableHead>Criado em</TableHead>
                  <TableHead className="w-20" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {paged.map((c) => (
                  <TableRow key={c.id} className="cursor-pointer" tabIndex={0}>
                    <TableCell>
                      <Checkbox
                        aria-label={`Selecionar ${c.name}`}
                        checked={selectedIds.has(c.id)}
                        onCheckedChange={() => toggleSelected(c.id)}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </TableCell>
                    <TableCell>
                      <Link
                        to="/contatos/$id"
                        params={{ id: c.id }}
                        className="flex items-center gap-2 hover:underline"
                      >
                        <InitialsAvatar name={c.name} variant="muted" size="sm" />
                        <span className="font-medium text-foreground">{c.name}</span>
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{c.phone || "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{c.email || "—"}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {c.tags?.map((t) => (
                          <StatusBadge key={t} variant="neutral">
                            {t}
                          </StatusBadge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{c.source || "—"}</TableCell>
                    <TableCell>
                      <div className="flex flex-col items-start gap-1">
                        <StatusBadge variant={c.status === "lead" ? "warning" : "success"}>
                          {c.status === "lead" ? "Lead" : "Contato"}
                        </StatusBadge>
                        {c.owner_id ? (
                          <span className="text-caption text-muted-foreground">
                            {ownerNameById[c.owner_id] ?? "Dono desconhecido"}
                          </span>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 px-2 text-caption"
                            disabled={
                              !profile ||
                              (assumeOwnerMut.isPending && assumeOwnerMut.variables === c.id)
                            }
                            onClick={(e) => {
                              e.stopPropagation();
                              assumeOwnerMut.mutate(c.id);
                            }}
                          >
                            <UserPlus className="mr-1 h-3.5 w-3.5" /> Assumir
                          </Button>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(c.created_at)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Criar negócio para ${c.name}`}
                          title="Criar negócio"
                          onClick={(e) => {
                            e.stopPropagation();
                            navigate({
                              to: "/pipeline",
                              search: { contactId: c.id, contactName: c.name },
                            });
                          }}
                        >
                          <Handshake className="h-4 w-4 text-muted-foreground" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Excluir ${c.name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleting(c);
                          }}
                        >
                          <Trash2 className="h-4 w-4 text-muted-foreground" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="flex items-center justify-between border-t border-border px-4 py-3">
              <span className="text-caption text-muted-foreground">
                Página {currentPage} de {totalPages}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={currentPage <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Anterior
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={currentPage >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Próxima
                </Button>
              </div>
            </div>
          </>
        )}
      </div>

      {hasActiveFilters && (
        <button
          onClick={clearSearch}
          className="self-start text-caption text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
        >
          <X className="h-3 w-3" /> Limpar filtros
        </button>
      )}

      <ContactFormDialog open={openNew} onOpenChange={setOpenNew} />
      <ContactImportDialog open={openImport} onOpenChange={setOpenImport} />

      <ContactBulkResultDialog
        open={!!bulkResult}
        onOpenChange={(v) => !v && setBulkResult(null)}
        actionLabel={bulkResult?.actionLabel ?? ""}
        report={bulkResult?.report ?? null}
        namesById={namesById}
      />

      <AlertDialog open={!!deleting} onOpenChange={(v) => !v && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir contato</AlertDialogTitle>
            <AlertDialogDescription>
              Tem certeza que deseja excluir <strong>{deleting?.name}</strong>? Os negócios,
              conversas e atividades relacionados não são apagados.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleting && deleteMut.mutate(deleting.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
