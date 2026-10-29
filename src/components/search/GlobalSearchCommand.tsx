import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle, Briefcase, Loader2, MessageCircle, User } from "lucide-react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useGlobalSearch } from "@/hooks/use-global-search";

/**
 * Busca global cross-entity (contatos, conversas, negócios) via Cmd+K/Ctrl+K.
 * Montada uma única vez no shell autenticado (`_app.tsx`), como um singleton
 * global — não em cada página.
 */
export function GlobalSearchCommand() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const { results, isSearching, hasError } = useGlobalSearch(term);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  function closeAndReset() {
    setOpen(false);
    setTerm("");
  }

  function goToContact(id: string) {
    closeAndReset();
    navigate({ to: "/contatos/$id", params: { id } });
  }

  function goToConversation(conversationId: string) {
    closeAndReset();
    navigate({ to: "/inbox", search: { conversationId } });
  }

  function goToDeal() {
    // A rota de pipeline ainda não suporta focar um negócio específico via
    // URL — só navega pro board; ver PRD Fase 1, riscos/armadilhas.
    closeAndReset();
    navigate({ to: "/pipeline" });
  }

  const hasQuery = term.trim().length > 0;
  const hasResults =
    results.contacts.length > 0 || results.conversations.length > 0 || results.deals.length > 0;

  return (
    <CommandDialog open={open} onOpenChange={setOpen} shouldFilter={false}>
      <CommandInput
        placeholder="Buscar contatos, conversas ou negócios..."
        value={term}
        onValueChange={setTerm}
      />
      <CommandList>
        {hasQuery && isSearching && !hasResults && (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Buscando...
          </div>
        )}
        {/*
          "Nenhum resultado" só pode aparecer quando a busca REALMENTE rodou.
          Com erro de query (RLS/rede) a mensagem antiga levava o usuário a
          concluir que o dado tinha sumido — ver code review 10/08, 05 · H4.
        */}
        {hasQuery && !isSearching && !hasResults && !hasError && (
          <CommandEmpty>Nenhum resultado encontrado.</CommandEmpty>
        )}
        {hasQuery && !isSearching && hasError && (
          <div
            role="alert"
            className="flex items-center justify-center gap-2 px-4 py-6 text-center text-sm text-destructive"
          >
            <AlertTriangle className="h-4 w-4 shrink-0" />
            Não foi possível concluir a busca. Verifique a conexão e tente de novo.
          </div>
        )}
        {!hasQuery && (
          <div className="py-6 text-center text-sm text-muted-foreground">
            Digite para buscar em contatos, conversas e negócios.
          </div>
        )}

        {results.contacts.length > 0 && (
          <CommandGroup heading="Contatos">
            {results.contacts.map((contact) => (
              <CommandItem
                key={contact.id}
                value={`contact-${contact.id}`}
                onSelect={() => goToContact(contact.id)}
              >
                <User />
                <div className="flex flex-col">
                  <span>{contact.name}</span>
                  {(contact.phone || contact.email) && (
                    <span className="text-caption text-muted-foreground">
                      {contact.phone ?? contact.email}
                    </span>
                  )}
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {results.conversations.length > 0 && (
          <CommandGroup heading="Conversas">
            {results.conversations.map((conversation) => (
              <CommandItem
                key={conversation.id}
                value={`conversation-${conversation.id}`}
                onSelect={() => goToConversation(conversation.id)}
              >
                <MessageCircle />
                <span>{conversation.contactName}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {results.deals.length > 0 && (
          <CommandGroup heading="Negócios">
            {results.deals.map((deal) => (
              <CommandItem key={deal.id} value={`deal-${deal.id}`} onSelect={() => goToDeal()}>
                <Briefcase />
                <span>{deal.title}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
