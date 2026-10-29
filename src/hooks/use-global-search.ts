import { useEffect, useRef, useState } from "react";

import { supabase } from "@/integrations/supabase/client";
import { logClientError } from "@/lib/client-error-telemetry";

/** Espera esse tempo sem digitação antes de disparar as 3 queries (PRD Fase 1 — Busca global). */
export const GLOBAL_SEARCH_DEBOUNCE_MS = 250;
/** Teto de resultados por entidade — nunca `.select("*")` sem `.limit()` (PRD, riscos/armadilhas #6). */
const RESULT_LIMIT = 5;

export interface GlobalSearchContact {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
}

export interface GlobalSearchConversation {
  id: string;
  contactId: string;
  contactName: string;
}

export interface GlobalSearchDeal {
  id: string;
  title: string;
  contactId: string | null;
}

export interface GlobalSearchResults {
  contacts: GlobalSearchContact[];
  conversations: GlobalSearchConversation[];
  deals: GlobalSearchDeal[];
}

const EMPTY_RESULTS: GlobalSearchResults = { contacts: [], conversations: [], deals: [] };

type RawContactRow = { id: string; name: string; phone: string | null; email: string | null };
type RawConversationRow = { id: string; contact_id: string; contact: { name: string } | null };
type RawDealRow = { id: string; title: string; contact_id: string | null };

/**
 * Busca global cross-entity (Cmd+K): debounce de 250ms e 3 queries paralelas
 * (contacts/conversations/deals), cada uma limitada a 5 resultados.
 *
 * Cancelamento de busca obsoleta: em vez de `AbortController`, usa um
 * contador de requisição local (`requestIdRef`) — a resposta só é aplicada
 * ao estado se ainda for a busca mais recente disparada, então uma busca
 * anterior que resolve depois de uma mais nova é descartada.
 */
export function useGlobalSearch(term: string): {
  results: GlobalSearchResults;
  isSearching: boolean;
  /**
   * `true` quando pelo menos uma das 3 queries falhou (RLS, rede, timeout).
   * Existe para a UI distinguir "não achei nada" de "não consegui procurar":
   * sem isso, erro de query virava lista vazia e o usuário concluía que o
   * dado tinha sumido (code review 10/08, achado 05 · H4).
   */
  hasError: boolean;
} {
  const [results, setResults] = useState<GlobalSearchResults>(EMPTY_RESULTS);
  const [isSearching, setIsSearching] = useState(false);
  const [hasError, setHasError] = useState(false);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const trimmed = term.trim();
    if (!trimmed) {
      // Invalida qualquer busca em voo — o resultado dela não deve mais aparecer.
      requestIdRef.current += 1;
      setResults(EMPTY_RESULTS);
      setIsSearching(false);
      setHasError(false);
      return;
    }

    setIsSearching(true);
    const timer = setTimeout(() => {
      const requestId = ++requestIdRef.current;
      void runSearch(trimmed)
        .then((found) => {
          // Uma busca mais nova já começou nesse meio-tempo — descarta resultado obsoleto.
          if (requestId !== requestIdRef.current) return;
          setIsSearching(false);
          setResults(found.results);
          setHasError(found.failed);
        })
        .catch((error: unknown) => {
          // Rejeição (não `{error}`): sem este catch, `isSearching` ficava
          // preso em true para sempre e nada era registrado.
          if (requestId !== requestIdRef.current) return;
          setIsSearching(false);
          setResults(EMPTY_RESULTS);
          setHasError(true);
          void logClientError(error, { origin: "query", operation: "global-search" });
        });
    }, GLOBAL_SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [term]);

  return { results, isSearching, hasError };
}

/**
 * Erro de query NÃO é silenciado: cada falha vira uma linha em
 * `public.system_events` (via `log_client_error`) com `operation` dizendo qual
 * das 3 entidades quebrou, e devolve `failed: true` para a UI avisar o
 * usuário. A entidade que respondeu continua aparecendo — falha parcial não
 * pode apagar o resultado bom.
 */
async function runSearch(
  query: string,
): Promise<{ results: GlobalSearchResults; failed: boolean }> {
  const pattern = `%${query}%`;

  const [contactsRes, conversationsRes, dealsRes] = await Promise.all([
    supabase
      .from("contacts")
      .select("id, name, phone, email")
      .is("deleted_at", null)
      .ilike("name", pattern)
      .limit(RESULT_LIMIT),
    supabase
      .from("conversations")
      .select("id, contact_id, contact:contacts!conversations_contact_id_fkey!inner(name)")
      .is("deleted_at", null)
      .ilike("contact.name", pattern)
      .limit(RESULT_LIMIT),
    supabase
      .from("deals")
      .select("id, title, contact_id")
      .ilike("title", pattern)
      .limit(RESULT_LIMIT),
  ]);

  let failed = false;
  function report(entity: "contacts" | "conversations" | "deals", error: unknown): void {
    failed = true;
    // logClientError nunca lança e é no-op no SSR — telemetria não pode virar
    // um segundo erro em cima do primeiro.
    void logClientError(error, { origin: "query", operation: `global-search:${entity}` });
  }

  if (contactsRes.error) report("contacts", contactsRes.error);
  if (conversationsRes.error) report("conversations", conversationsRes.error);
  if (dealsRes.error) report("deals", dealsRes.error);

  const contacts = (
    contactsRes.error ? [] : ((contactsRes.data ?? []) as unknown as RawContactRow[])
  ).map((c) => ({ id: c.id, name: c.name, phone: c.phone, email: c.email }));

  const conversations = (
    conversationsRes.error ? [] : ((conversationsRes.data ?? []) as unknown as RawConversationRow[])
  ).map((c) => ({ id: c.id, contactId: c.contact_id, contactName: c.contact?.name ?? "" }));

  const deals = (dealsRes.error ? [] : ((dealsRes.data ?? []) as unknown as RawDealRow[])).map(
    (d) => ({ id: d.id, title: d.title, contactId: d.contact_id }),
  );

  return { results: { contacts, conversations, deals }, failed };
}
