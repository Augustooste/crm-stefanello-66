import { useMutation, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { runInBatches, type BatchReport } from "@/lib/batch-runner";

/** Mesma concorrência do padrão medflow (`useBulkDeleteContacts`): lotes de 3,
 * nunca todos os selecionados de uma vez. */
const BULK_CONCURRENCY = 3;

export type ContactBulkActionReport = BatchReport<string>;

interface ApplyTagArgs {
  contactIds: string[];
  tag: string;
}

/**
 * Operações em lote sobre contatos (tag em lote e soft-delete em lote).
 *
 * "Mudar responsável/owner" e "mover de estágio" foram deliberadamente
 * deixadas de fora: `contacts` não tem `owner_id` nem `stage_id` — essas
 * colunas existem só em `deals` (ver `src/integrations/supabase/types.ts`).
 * Bulk-assign de responsável e bulk-move de estágio pertencem à tela de
 * negócios (deals/kanban), não à lista de contatos.
 *
 * Concorrência limitada via `runInBatches` (lotes de 3, `Promise.allSettled`)
 * — nunca dispara todos os selecionados de uma vez.
 */
export function useBulkContactActions() {
  const qc = useQueryClient();

  const invalidateContacts = () => {
    qc.invalidateQueries({ queryKey: ["contacts"] });
    qc.invalidateQueries({ queryKey: ["dashboard"] });
  };

  const applyTagMutation = useMutation({
    mutationFn: async ({ contactIds, tag }: ApplyTagArgs): Promise<ContactBulkActionReport> => {
      return runInBatches(contactIds, BULK_CONCURRENCY, async (id) => {
        // Busca as tags atuais direto do servidor no momento da operação --
        // usar o cache client-side (lista da tela, possivelmente limitada a
        // uma janela de N contatos) como fonte de verdade para um WRITE
        // arriscaria apagar tags reais de um contato fora dessa janela
        // (current=[] por engano) em vez de só adicionar a nova.
        const { data: current, error: readError } = await supabase
          .from("contacts")
          .select("tags")
          .eq("id", id)
          .single();
        if (readError) throw new Error(readError.message);
        const currentTags = current.tags ?? [];
        if (currentTags.includes(tag)) return; // já tem a etiqueta — no-op, conta como sucesso
        const { error } = await supabase
          .from("contacts")
          .update({ tags: [...currentTags, tag] })
          .eq("id", id);
        if (error) throw new Error(error.message);
      });
    },
    onSettled: invalidateContacts,
  });

  const bulkSoftDeleteMutation = useMutation({
    mutationFn: async (contactIds: string[]): Promise<ContactBulkActionReport> => {
      const deletedAt = new Date().toISOString();
      return runInBatches(contactIds, BULK_CONCURRENCY, async (id) => {
        // Soft delete — nunca DELETE físico aqui, que dispararia cascade em
        // conversations/messages e apagaria histórico de conversa sem aviso.
        const { error } = await supabase
          .from("contacts")
          .update({ deleted_at: deletedAt })
          .eq("id", id);
        if (error) throw new Error(error.message);
      });
    },
    onSettled: invalidateContacts,
  });

  return {
    applyTag: applyTagMutation.mutateAsync,
    isApplyingTag: applyTagMutation.isPending,
    bulkSoftDelete: bulkSoftDeleteMutation.mutateAsync,
    isBulkDeleting: bulkSoftDeleteMutation.isPending,
  };
}
