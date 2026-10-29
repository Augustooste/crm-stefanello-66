import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

type AuthState = { user: User | null; isReady: boolean };

const AuthContext = createContext<AuthState>({ user: null, isReady: false });

// O marcador de identidade vive DENTRO do queryClient, não num `useRef`: o
// AuthProvider desmonta e remonta na navegação entre /auth e /app, e um ref
// remontado nasce já com a identidade NOVA — o guard comparava B com B e nunca
// limpava nada. O queryClient é justamente o objeto cujo cache queremos
// proteger: sobrevive ao remount e nasce vazio no reload da página, que é
// quando não há mesmo nada a limpar.
const IDENTIDADE_KEY = ["__identidade-da-sessao"] as const;

export function AuthProvider({
  children,
  initialUser = null,
}: {
  children: ReactNode;
  initialUser?: User | null;
}) {
  const [user, setUser] = useState<User | null>(initialUser);
  const [isReady, setIsReady] = useState<boolean>(!!initialUser);

  // Zera o cache do react-query quando a identidade muda (logout, ou login com
  // outra conta sem reload). Sem isso, uma queryKey sem discriminante de
  // identidade -- ["my-capabilities"], ["tenant-profiles"], ["ai-failure-logs",
  // page] -- serve à conta nova o dado que ficou da anterior. Feito aqui, e não
  // discriminando cada queryKey, porque discriminar depende de ninguém esquecer
  // na próxima query; isto não depende.
  const queryClient = useQueryClient();

  useEffect(() => {
    const identidadeAtual = user?.id ?? null;
    const identidadeAnterior = queryClient.getQueryData<string | null>(IDENTIDADE_KEY) ?? null;
    // Só limpa quando havia identidade anterior E ela mudou. No primeiro
    // carregamento não há marcador, e limpar ali descartaria o que os loaders de
    // rota já buscaram sem ter nada a proteger.
    if (identidadeAnterior !== null && identidadeAnterior !== identidadeAtual) {
      queryClient.clear();
    }
    queryClient.setQueryData(IDENTIDADE_KEY, identidadeAtual);
  }, [user, queryClient]);

  useEffect(() => {
    let mounted = true;

    // Subscribe FIRST so we never miss an event; fire-and-forget inside callback.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;
      setUser(session?.user ?? null);
      setIsReady(true);
    });

    // Single getSession() call to hydrate — reads from storage, no lock contention with queries.
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setUser(data.session?.user ?? null);
      setIsReady(true);
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return <AuthContext.Provider value={{ user, isReady }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
