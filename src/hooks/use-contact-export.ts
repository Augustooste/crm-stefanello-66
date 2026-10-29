import { useMutation } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile } from "@/lib/api/session";
import { stringifyCsv, withUtf8Bom } from "@/lib/csv";

/** Chunk de leitura — mesmo padrão do medflow: `.range()` até a página vir
 * menor que o tamanho pedido, garantindo que export de >500 contatos (cap de
 * paginação da UI) retorne a base inteira, não só a primeira tela. */
const EXPORT_PAGE_SIZE = 1000;

const EXPORT_HEADER = ["nome", "telefone", "email", "etiquetas", "notas", "origem", "criado_em"];

export interface ContactExportFilters {
  /** Mesmo texto livre da busca da tela de contatos (nome/telefone/email). */
  search?: string;
  /** Etiquetas selecionadas na tela — semântica OR, igual ao filtro client-side atual. */
  tags?: string[];
}

/**
 * Remove caracteres que quebrariam a sintaxe de filtro do PostgREST dentro
 * de `.or(...)`: `,` separa condições, `(`/`)` agrupam, `%` é wildcard do
 * próprio `ilike`. Sanitização defensiva — o valor vem de busca livre do
 * usuário e é interpolado numa string de filtro.
 */
function sanitizeIlikeValue(raw: string): string {
  return raw.replace(/[%,()]/g, "").trim();
}

type ExportRow = {
  name: string | null;
  phone: string | null;
  email: string | null;
  tags: string[] | null;
  notes: string | null;
  source: string | null;
  created_at: string;
};

async function fetchAllContactsForExport(filters: ContactExportFilters): Promise<ExportRow[]> {
  let all: ExportRow[] = [];
  let page = 0;

  while (true) {
    let query = supabase
      .from("contacts")
      .select("name, phone, email, tags, notes, source, created_at")
      .is("deleted_at", null);

    const search = filters.search?.trim();
    if (search) {
      const safe = sanitizeIlikeValue(search);
      if (safe) {
        query = query.or(`name.ilike.%${safe}%,phone.ilike.%${safe}%,email.ilike.%${safe}%`);
      }
    }
    if (filters.tags && filters.tags.length > 0) {
      query = query.overlaps("tags", filters.tags);
    }

    const from = page * EXPORT_PAGE_SIZE;
    const to = from + EXPORT_PAGE_SIZE - 1;
    const { data, error } = await query.order("created_at", { ascending: false }).range(from, to);
    if (error) throw error;

    const chunk = (data ?? []) as ExportRow[];
    all = all.concat(chunk);
    if (chunk.length < EXPORT_PAGE_SIZE) break;
    page += 1;
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

export interface ContactExportResult {
  recordsCount: number;
}

/**
 * Hook de export de contatos para CSV. Busca TODOS os contatos que passam
 * nos filtros atuais da tela (não só os renderizados), respeita
 * `deleted_at is null`, monta o CSV com BOM UTF-8 + `;` (compatível com
 * Excel pt-BR), dispara o download via Blob e registra a exportação em
 * `contact_export_log`.
 */
export function useContactExport() {
  const { data: profile } = useCurrentProfile();

  const mutation = useMutation({
    mutationFn: async (filters: ContactExportFilters): Promise<ContactExportResult> => {
      const tenantId = profile?.tenant_id;
      const exportedBy = profile?.id;
      if (!tenantId || !exportedBy) throw new Error("Perfil do usuário não carregado.");

      const contacts = await fetchAllContactsForExport(filters);

      const rows = contacts.map((c) => [
        c.name || "",
        c.phone || "",
        c.email || "",
        (c.tags || []).join("; "),
        c.notes || "",
        c.source || "",
        c.created_at || "",
      ]);
      const csv = withUtf8Bom(stringifyCsv([EXPORT_HEADER, ...rows], ";"));

      const today = new Date().toISOString().slice(0, 10);
      triggerCsvDownload(csv, `contatos-${today}.csv`);

      // Auditoria de export — best-effort, não bloqueia o download já disparado.
      const { error: logError } = await supabase.from("contact_export_log").insert({
        tenant_id: tenantId,
        filters: { search: filters.search ?? null, tags: filters.tags ?? [] },
        records_count: contacts.length,
        exported_by: exportedBy,
      });
      if (logError) {
        console.error(
          "[contact-export] falha ao registrar contact_export_log (non-fatal):",
          logError.message,
        );
      }

      return { recordsCount: contacts.length };
    },
  });

  return {
    exportContacts: mutation.mutateAsync,
    isExporting: mutation.isPending,
  };
}
