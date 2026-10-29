import { useMutation } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { stringifyCsv, withUtf8Bom } from "@/lib/csv";

/** Chunk de leitura — mesmo padrão de `use-contact-export.ts`/`use-deal-export.ts`:
 * `.range()` até a página vir menor que o tamanho pedido, garantindo que o
 * export traga TODA a base filtrada (a tela do inbox limita a query a 500
 * conversas por segurança — ver `_app.inbox.tsx` — mas o export não deve
 * depender desse teto). */
const EXPORT_PAGE_SIZE = 1000;

const EXPORT_HEADER = [
  "contato",
  "telefone",
  "canal",
  "status",
  "aguardando_humano",
  "ultimo_contato_em",
  "criado_em",
];

export interface ConversationExportFilters {
  /** Mesmo texto livre da busca da Lista (nome/telefone do contato). Aplicado
   * client-side, após a paginação — não cobre conteúdo da última mensagem
   * (isso exigiria a mesma 2ª query em lote de `_app.inbox.tsx`, fora de
   * proporção para um export). */
  search?: string;
  /** Canal selecionado no seletor da Lista ("todos" não é passado aqui). */
  channelType?: "whatsapp" | "email" | "instagram" | "messenger" | "simulator";
  /** Status de IA selecionado no seletor da Lista ("todos" não é passado aqui). */
  aiActive?: boolean;
}

type ExportRow = {
  id: string;
  status: string;
  awaiting_human: boolean;
  last_message_at: string | null;
  created_at: string;
  contact: { name: string; phone: string | null; deleted_at: string | null } | null;
  channel: { type: string } | null;
};

function statusLabel(status: string): string {
  if (status === "open") return "Aberta";
  if (status === "closed") return "Fechada";
  return status;
}

function channelLabel(type: string | undefined): string {
  if (type === "email") return "E-mail";
  if (type === "whatsapp") return "WhatsApp";
  if (type === "simulator") return "SIMULAÇÃO — não entregue no WhatsApp";
  return type ?? "";
}

async function fetchAllConversationsForExport(
  filters: ConversationExportFilters,
): Promise<ExportRow[]> {
  let all: ExportRow[] = [];
  let page = 0;

  while (true) {
    let query = supabase.from("conversations").select(
      // Canal com `!inner`: `channel_id` é NOT NULL e `channels` não tem
      // soft-delete (sem `deleted_at`), então o inner join nunca descarta
      // conversas legítimas — e é o que permite `.eq("channel.type", ...)`
      // abaixo (PostgREST só filtra em recurso embutido com join `!inner`,
      // mesmo padrão de `use-global-search.ts`).
      "id, status, awaiting_human, last_message_at, created_at, " +
        "contact:contacts!conversations_contact_id_fkey(name, phone, deleted_at), " +
        "channel:channels!conversations_channel_id_fkey!inner(type)",
    );
    // Conversa excluída (soft-delete) não entra no export.
    query = query.is("deleted_at", null);

    if (filters.channelType) {
      query = query.eq("channel.type", filters.channelType);
    }
    if (filters.aiActive !== undefined) {
      query = query.eq("ai_active", filters.aiActive);
    }

    const from = page * EXPORT_PAGE_SIZE;
    const to = from + EXPORT_PAGE_SIZE - 1;
    // Tiebreaker por `id` — `created_at` sozinho não é único (duas conversas
    // criadas no mesmo instante ficariam em ordem indefinida entre páginas,
    // podendo repetir ou sumir na fronteira do `.range()`). Mesmo critério de
    // `use-deal-export.ts`.
    const { data, error } = await query
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to);
    if (error) throw error;

    const chunk = (data ?? []) as unknown as ExportRow[];
    // Join to-one: contato fundido/removido não deve aparecer no export
    // (mesmo critério do inbox em `_app.inbox.tsx`).
    all = all.concat(
      chunk.map((c) => ({
        ...c,
        contact: c.contact?.deleted_at ? null : c.contact,
      })),
    );
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

export interface ConversationExportResult {
  recordsCount: number;
}

/**
 * Hook de export de conversas (inbox) para CSV. Busca TODAS as conversas que
 * passam nos filtros de canal/status da IA (aplicados server-side) e no
 * texto de busca (nome/telefone do contato, aplicado client-side após a
 * paginação completa), monta o CSV com BOM UTF-8 + `;` (compatível com Excel
 * pt-BR) e dispara o download via Blob.
 *
 * Mirror de `use-contact-export.ts`/`use-deal-export.ts` — sem log de
 * auditoria: `contact_export_log` é específico de contatos, não replicado
 * aqui (mesma decisão já tomada no export de deals).
 */
export function useConversationExport() {
  const mutation = useMutation({
    mutationFn: async (filters: ConversationExportFilters): Promise<ConversationExportResult> => {
      const conversations = await fetchAllConversationsForExport(filters);

      const search = filters.search?.trim().toLowerCase();
      const rows = conversations
        .filter((c) => {
          if (!search) return true;
          const name = c.contact?.name?.toLowerCase() ?? "";
          const phone = c.contact?.phone?.toLowerCase() ?? "";
          return name.includes(search) || phone.includes(search);
        })
        .map((c) => [
          c.contact?.name || "",
          c.contact?.phone || "",
          channelLabel(c.channel?.type),
          statusLabel(c.status),
          c.awaiting_human ? "Sim" : "Não",
          c.last_message_at || "",
          c.created_at || "",
        ]);
      const csv = withUtf8Bom(stringifyCsv([EXPORT_HEADER, ...rows], ";"));

      const today = new Date().toISOString().slice(0, 10);
      triggerCsvDownload(csv, `conversas-${today}.csv`);

      return { recordsCount: rows.length };
    },
  });

  return {
    exportConversations: mutation.mutateAsync,
    isExporting: mutation.isPending,
  };
}
