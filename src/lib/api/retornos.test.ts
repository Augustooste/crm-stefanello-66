import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { enrollInManualNurtureSequence } from "./retornos";

function fakeSupabase(rpc: ReturnType<typeof vi.fn>): SupabaseClient<Database> {
  return { rpc } as unknown as SupabaseClient<Database>;
}

const INPUT = {
  tenantId: "t1",
  contactId: "c1",
  appointmentAt: new Date("2026-07-20T09:00:00.000Z"),
};

afterEach(() => {
  delete window.__lovableEvents;
});

describe("enrollInManualNurtureSequence", () => {
  it("delega ao RPC tenant-scoped com contato e data do compromisso", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });

    await expect(enrollInManualNurtureSequence(fakeSupabase(rpc), INPUT)).resolves.toBe(true);

    expect(rpc).toHaveBeenCalledWith("enroll_manual_nurture_sequence", {
      p_contact_id: "c1",
      p_appointment_at: "2026-07-20T09:00:00.000Z",
    });
  });

  it("devolve false quando não há sequence manual ou o enrollment já existe", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: false, error: null });

    await expect(enrollInManualNurtureSequence(fakeSupabase(rpc), INPUT)).resolves.toBe(false);
  });

  it("captura falha do RPC na telemetria sem bloquear o agendamento", async () => {
    const error = { code: "42501", message: "permission denied" };
    const rpc = vi.fn().mockResolvedValue({ data: null, error });
    const captureException = vi.fn();
    window.__lovableEvents = { captureException };

    await expect(enrollInManualNurtureSequence(fakeSupabase(rpc), INPUT)).resolves.toBe(false);

    expect(captureException).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        operation: "retornos.enroll_manual_nurture_sequence",
        tenant_id: "t1",
        contact_id: "c1",
      }),
      expect.objectContaining({ handled: false, severity: "error" }),
    );
  });
});
