import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { reportLovableError } from "@/lib/lovable-error-reporting";

export interface EnrollInManualNurtureSequenceInput {
  tenantId: string;
  contactId: string;
  appointmentAt: Date;
}

/**
 * Inscrição best-effort via RPC tenant-scoped. A RPC deriva o tenant da
 * sessão, valida o contato e faz INSERT idempotente com SECURITY DEFINER.
 * Falhas não bloqueiam o agendamento principal, mas são enviadas à telemetria
 * do cliente em vez de desaparecerem silenciosamente.
 *
 * Devolve se a inscrição aconteceu. `false` sem `error` é o caso comum e o
 * motivo deste retorno existir: a RPC responde `false` quando o tenant não tem
 * nenhuma sequência com `trigger_type='manual'` ativa, e também quando o
 * contato já está inscrito numa (`on conflict do nothing`). Antes, o chamador
 * olhava só `error` e anunciava sucesso nos dois casos.
 */
export async function enrollInManualNurtureSequence(
  supabase: SupabaseClient<Database>,
  input: EnrollInManualNurtureSequenceInput,
): Promise<boolean> {
  const { data, error } = await supabase.rpc("enroll_manual_nurture_sequence", {
    p_contact_id: input.contactId,
    p_appointment_at: input.appointmentAt.toISOString(),
  });
  if (error) {
    reportLovableError(error, {
      operation: "retornos.enroll_manual_nurture_sequence",
      tenant_id: input.tenantId,
      contact_id: input.contactId,
    });
    return false;
  }
  return data === true;
}
