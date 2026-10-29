import { describe, expect, it, vi } from "vitest";

const getSessionMock = vi.fn();

vi.mock("@tanstack/react-start", () => ({
  createMiddleware: () => ({
    client: (fn: unknown) => fn,
  }),
}));

vi.mock("./client", () => ({
  supabase: { auth: { getSession: getSessionMock } },
}));

const { attachSupabaseAuth } = await import("./auth-attacher");

type NextFn = (opts: { headers: Record<string, string> }) => unknown;
type AttacherFn = (args: { next: NextFn }) => Promise<unknown>;
const attacher = attachSupabaseAuth as unknown as AttacherFn;

describe("attachSupabaseAuth", () => {
  it("anexa o header Authorization com o access_token quando há sessão", async () => {
    getSessionMock.mockResolvedValue({ data: { session: { access_token: "token-123" } } });
    const next = vi.fn().mockReturnValue("next-result");

    const result = await attacher({ next });

    expect(next).toHaveBeenCalledWith({ headers: { Authorization: "Bearer token-123" } });
    expect(result).toBe("next-result");
  });

  it("não anexa Authorization quando não há sessão ativa", async () => {
    getSessionMock.mockResolvedValue({ data: { session: null } });
    const next = vi.fn().mockReturnValue("next-result");

    await attacher({ next });

    expect(next).toHaveBeenCalledWith({ headers: {} });
  });
});
