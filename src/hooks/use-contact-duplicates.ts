import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";

export type DuplicateMatchType = "phone" | "email";

export interface DuplicateContactCandidate {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  created_at: string;
}

export interface DuplicateGroup {
  /** Chave estável do grupo (matchType + matchValue) — usada como React key e
   * para o estado local de "principal selecionado" na tela. */
  key: string;
  matchType: DuplicateMatchType;
  matchValue: string;
  groupSize: number;
  /** Já na ordem de `created_at` ascendente (`find_duplicate_contacts` usa
   * `array_agg(... order by created_at)`) — o primeiro é o contato mais antigo. */
  contacts: DuplicateContactCandidate[];
}

/** Shape bruto retornado por `find_duplicate_contacts` (RPC, `Returns: Json`). */
interface RawDuplicateGroup {
  match_type: DuplicateMatchType;
  match_value: string;
  contact_ids: string[];
  contact_names: string[];
  group_size: number;
}

interface ContactLookupRow {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  created_at: string;
}

async function fetchDuplicateGroups(): Promise<DuplicateGroup[]> {
  const { data, error } = await supabase.rpc("find_duplicate_contacts");
  if (error) throw error;

  const rawGroups = (data ?? []) as unknown as RawDuplicateGroup[];
  if (rawGroups.length === 0) return [];

  const allIds = Array.from(new Set(rawGroups.flatMap((g) => g.contact_ids)));
  const { data: contactsData, error: contactsError } = await supabase
    .from("contacts")
    .select("id, name, phone, email, created_at")
    .is("deleted_at", null)
    .in("id", allIds);
  if (contactsError) throw contactsError;

  const byId = new Map(((contactsData ?? []) as ContactLookupRow[]).map((c) => [c.id, c] as const));

  return (
    rawGroups
      .map((g) => ({
        key: `${g.match_type}:${g.match_value}`,
        matchType: g.match_type,
        matchValue: g.match_value,
        groupSize: g.group_size,
        contacts: g.contact_ids
          .map((id) => byId.get(id))
          .filter((c): c is DuplicateContactCandidate => !!c),
      }))
      // Um contato já pode ter sido fundido por outra sessão entre o RPC e o
      // lookup acima -- grupo fica com <2 candidatos e deixa de fazer sentido.
      .filter((g) => g.contacts.length >= 2)
  );
}

export function useDuplicateGroups() {
  return useQuery({
    queryKey: ["contact-duplicates"],
    queryFn: fetchDuplicateGroups,
  });
}

/**
 * Mensagem amigável para o erro de concorrência do `merge_contacts`: a RPC já
 * usa `FOR UPDATE` (lock ordenado por id) + guard `merged_into_id is not null`
 * para impedir um segundo merge sobre um contato que já foi fundido. Esse
 * erro NUNCA deve ser engolido em catch silencioso (PRD, riscos #4) -- a UI
 * precisa avisar o usuário para atualizar a lista.
 */
function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  // Erros do supabase-js (PostgrestError e o RPC error do plpgsql RAISE
  // EXCEPTION) chegam como objeto plano `{ message: string, ... }`, não como
  // instância de `Error` -- mesma convenção usada nos mocks de teste do projeto.
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  return String(error);
}

export function friendlyMergeErrorMessage(error: unknown): string {
  const message = extractErrorMessage(error);
  if (/already merged/i.test(message)) {
    return "Este contato já foi fundido por outra ação. Atualize a lista de duplicados.";
  }
  return message || "Erro ao fundir contatos.";
}

export interface MergeGroupInput {
  /** Contato escolhido como "principal" -- absorve os demais do grupo. */
  targetId: string;
  /** Demais contatos do grupo, fundidos um a um no `targetId`. */
  sourceIds: string[];
}

/**
 * Funde um grupo inteiro no contato "principal" escolhido pelo usuário:
 * chama `merge_contacts` uma vez por contato restante, sequencialmente (não
 * em paralelo -- cada merge depende do estado consistente deixado pelo
 * anterior). Para no primeiro erro e propaga (nunca engole) -- merges já
 * concluídos antes da falha permanecem válidos, e as queries são invalidadas
 * mesmo em falha parcial para a lista refletir o estado real do banco.
 */
export function useMergeContactGroup() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ targetId, sourceIds }: MergeGroupInput): Promise<void> => {
      for (const sourceId of sourceIds) {
        const { error } = await supabase.rpc("merge_contacts", {
          p_source_id: sourceId,
          p_target_id: targetId,
        });
        if (error) throw error;
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["contacts"] });
      qc.invalidateQueries({ queryKey: ["contact-duplicates"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}
