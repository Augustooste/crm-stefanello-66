import { useState } from "react";
import { vi } from "vitest";

/** Resultado mínimo de `useQuery` que os componentes de desenvolvedor consomem. */
export function queryResult<T>(
  data: T | undefined,
  over: Partial<{ isLoading: boolean; isFetching: boolean; error: Error | null }> = {},
) {
  return { data, isLoading: false, isFetching: false, error: null, refetch: vi.fn(), ...over };
}

/**
 * Mutation falsa com estado real: `data` só existe depois de `mutateAsync` e
 * some em `reset()`, como o `useMutation` de verdade (segredo vive só ali).
 */
export function fakeMutation<I, O>(run: (input: I) => Promise<O>, onReset?: () => void) {
  return () => {
    const [data, setData] = useState<O | undefined>(undefined);
    const [isPending, setPending] = useState(false);
    return {
      data,
      isPending,
      error: null,
      mutateAsync: async (input: I) => {
        setPending(true);
        try {
          const result = await run(input);
          setData(result);
          return result;
        } finally {
          setPending(false);
        }
      },
      reset: () => {
        onReset?.();
        setData(undefined);
      },
    };
  };
}
