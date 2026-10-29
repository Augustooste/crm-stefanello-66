import { useMutation } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { stringifyCsv, withUtf8Bom } from "@/lib/csv";

/** Chunk de leitura — mesmo padrão de `use-contact-export.ts`: `.range()` até
 * a página vir menor que o tamanho pedido, garantindo que o export traga o
 * board inteiro (a tela do pipeline não pagina a query de deals, mas o
 * export não deve depender disso). */
const EXPORT_PAGE_SIZE = 1000;

const EXPORT_HEADER = ["titulo", "estagio", "valor", "contato", "criado_em"];

export interface DealExportFilters {
  /** Board selecionado na tela — deals sempre pertencem a um board. */
  boardId: string;
  /** Responsável selecionado no filtro da tela ("Todos" não é passado aqui). */
  ownerId?: string;
  /** Etiqueta do contato selecionada no filtro da tela ("Todas" não é passado aqui). */
  tagName?: string;
}

type ExportDealRow = {
  id: string;
  title: string;
  value: number | null;
  created_at: string;
  contact: { name: string; tags: string[] | null } | null;
  stage: { name: string } | null;
};

type RawExportDealRow = Omit<ExportDealRow, "contact"> & {
  contact: (ExportDealRow["contact"] & { deleted_at: string | null }) | null;
};

async function fetchAllDealsForExport(filters: DealExportFilters): Promise<ExportDealRow[]> {
  let all: ExportDealRow[] = [];
  let page = 0;

  while (true) {
    let query = supabase
      .from("deals")
      .select(
        "id, title, value, created_at, contact:contacts(name, tags, deleted_at), stage:board_stages(name)",
      )
      .eq("board_id", filters.boardId);

    if (filters.ownerId) {
      query = query.eq("owner_id", filters.ownerId);
    }

    const from = page * EXPORT_PAGE_SIZE;
    const to = from + EXPORT_PAGE_SIZE - 1;
    // Tiebreaker por `id` — `created_at` sozinho não é único (dois deals
    // criados no mesmo instante ficariam em ordem indefinida entre páginas,
    // podendo repetir ou sumir na fronteira do `.range()`).
    const { data, error } = await query
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to);
    if (error) throw error;

    const chunk = (data ?? []) as unknown as RawExportDealRow[];
    // Join to-one: contato fundido/removido não deve aparecer no export (mesmo
    // critério do Kanban em `_app.pipeline.tsx`).
    all = all.concat(
      chunk.map((d) => ({
        ...d,
        contact: d.contact?.deleted_at ? null : d.contact,
      })),
    );
    if (chunk.length < EXPORT_PAGE_SIZE) break;
    page += 1;
  }

  // Etiqueta filtra pelo contato associado — não é coluna de `deals`, então
  // não dá pra empurrar pro `.eq()`/`.overlaps()` do Postgrest como no export
  // de contatos; aplicado client-side após a paginação, mesma semântica do
  // filtro da tela (`tagFilter` em `_app.pipeline.tsx`).
  if (filters.tagName) {
    const tagName = filters.tagName;
    return all.filter((d) => (d.contact?.tags ?? []).includes(tagName));
  }
  return all;
}

function triggerCsvDownload(csv: string, filename: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export interface DealExportResult {
  recordsCount: number;
}

/**
 * Hook de export de negócios (pipeline) para CSV. Busca TODOS os deals do
 * board selecionado que passam nos filtros atuais da tela (responsável e
 * etiqueta do contato associado), monta o CSV com BOM UTF-8 + `;`
 * (compatível com Excel pt-BR) e dispara o download via Blob.
 *
 * Mirror de `use-contact-export.ts` — sem log de auditoria: `contact_export_log`
 * é específico de contatos, não replicado aqui.
 */
export function useDealExport() {
  const mutation = useMutation({
    mutationFn: async (filters: DealExportFilters): Promise<DealExportResult> => {
      const deals = await fetchAllDealsForExport(filters);

      const rows = deals.map((d) => [
        d.title || "",
        d.stage?.name || "",
        d.value != null
          ? d.value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
          : "",
        d.contact?.name || "",
        d.created_at || "",
      ]);
      const csv = withUtf8Bom(stringifyCsv([EXPORT_HEADER, ...rows], ";"));

      const today = new Date().toISOString().slice(0, 10);
      triggerCsvDownload(csv, `negocios-${today}.csv`);

      return { recordsCount: deals.length };
    },
  });

  return {
    exportDeals: mutation.mutateAsync,
    isExporting: mutation.isPending,
  };
}
