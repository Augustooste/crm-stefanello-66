import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderOptions, type RenderResult } from "@testing-library/react";

/** QueryClient sem retry/cache — falhas e estados de loading ficam determinísticos nos testes. */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

type RenderWithQueryClientOptions = Omit<RenderOptions, "wrapper"> & {
  queryClient?: QueryClient;
};

export type RenderWithQueryClientResult = RenderResult & { queryClient: QueryClient };

/** Renderiza um componente de rota já envolto no QueryClientProvider usado pela app real. */
export function renderWithQueryClient(
  ui: ReactElement,
  options: RenderWithQueryClientOptions = {},
): RenderWithQueryClientResult {
  const { queryClient = createTestQueryClient(), ...renderOptions } = options;
  const result = render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
    renderOptions,
  );
  return { ...result, queryClient };
}
