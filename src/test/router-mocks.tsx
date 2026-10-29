import type { AnchorHTMLAttributes, ReactNode } from "react";
import { vi } from "vitest";

/**
 * Spy compartilhado para useNavigate(). Chame `navigateMock.mockClear()` em
 * beforeEach quando o teste precisar contar chamadas com precisão.
 */
export const navigateMock = vi.fn();

interface LinkStubProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  to?: string;
  params?: Record<string, string>;
  hash?: string;
  children?: ReactNode;
}

/** Substitui <Link> do TanStack Router por uma <a> simples — dispensa RouterProvider real. */
export function LinkStub({ to = "#", params, hash, children, ...rest }: LinkStubProps) {
  const path = params ? Object.values(params).reduce((p, v) => p.replace(/\$\w+/, v), to) : to;
  const href = hash ? `${path}#${hash}` : path;
  return (
    <a href={href} {...rest}>
      {children}
    </a>
  );
}

/**
 * Overrides parciais de "@tanstack/react-router" para uso em vi.mock:
 *
 * vi.mock("@tanstack/react-router", async (importOriginal) => {
 *   const actual = await importOriginal<typeof import("@tanstack/react-router")>();
 *   const { routerOverrides } = await import("@/test/router-mocks");
 *   return { ...actual, ...routerOverrides() };
 * });
 */
export function routerOverrides() {
  return {
    Link: LinkStub,
    useNavigate: () => navigateMock,
  };
}
