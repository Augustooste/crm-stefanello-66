import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { vi } from "vitest";

export type PostgrestLikeResult<T> = { data: T; error: unknown; count?: number | null };

export type ChainMock<T> = {
  select: (...args: unknown[]) => ChainMock<T>;
  eq: (...args: unknown[]) => ChainMock<T>;
  in: (...args: unknown[]) => ChainMock<T>;
  is: (...args: unknown[]) => ChainMock<T>;
  not: (...args: unknown[]) => ChainMock<T>;
  gte: (...args: unknown[]) => ChainMock<T>;
  lte: (...args: unknown[]) => ChainMock<T>;
  order: (...args: unknown[]) => ChainMock<T>;
  limit: (...args: unknown[]) => ChainMock<T>;
  update: (...args: unknown[]) => ChainMock<T>;
  insert: (...args: unknown[]) => ChainMock<T>;
  upsert: (...args: unknown[]) => ChainMock<T>;
  maybeSingle: () => Promise<PostgrestLikeResult<T>>;
  single: () => Promise<PostgrestLikeResult<T>>;
  then: <TResult1 = PostgrestLikeResult<T>, TResult2 = never>(
    onFulfilled?: ((value: PostgrestLikeResult<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) => Promise<TResult1 | TResult2>;
};

/**
 * Chainable stand-in for the supabase-js PostgrestFilterBuilder. Every filter
 * method returns the same chain; the chain is itself thenable so call sites
 * that `await` it directly (no terminal `.single()`/`.maybeSingle()`) resolve
 * to `result` too.
 */
export function createChain<T>(result: PostgrestLikeResult<T>): ChainMock<T> {
  const chain: ChainMock<T> = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    in: vi.fn(() => chain),
    is: vi.fn(() => chain),
    not: vi.fn(() => chain),
    gte: vi.fn(() => chain),
    lte: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    update: vi.fn(() => chain),
    insert: vi.fn(() => chain),
    upsert: vi.fn(() => chain),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
    single: vi.fn(() => Promise.resolve(result)),
    then: (onFulfilled, onRejected) =>
      Promise.resolve(result).then(onFulfilled ?? undefined, onRejected ?? undefined),
  };
  return chain;
}

export function createQueryWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}
