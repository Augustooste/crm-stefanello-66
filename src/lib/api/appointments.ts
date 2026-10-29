import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { format } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { useCurrentProfile } from "@/lib/api/session";

export type AppointmentModality = "presencial" | "online";
export type AppointmentStatus =
  "scheduled" | "confirmed" | "completed" | "no_show" | "cancelled" | "rescheduled";

export type AppointmentRow = {
  id: string;
  tenant_id: string;
  contact_id: string | null;
  title: string;
  date: string;
  time_start: string;
  time_end: string | null;
  modality: AppointmentModality;
  status: AppointmentStatus;
  notes: string | null;
  custom_fields: Record<string, unknown>;
  external_ref: string | null;
  external_source: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  contact: { id: string; name: string } | null;
};

// `appointments` (Fase 6, Sub-feature 1) ainda não está no types.ts gerado --
// o orquestrador regenera 1x depois desta wave (mesmo padrão das fases
// anteriores, ver plugins.ts/onboarding.ts). Extensão local do Database,
// mesma convenção de `channelRpcClient` (integrations.ts) para `.rpc()`, aqui
// aplicada a `.from()` -- evita `any`/`@ts-ignore` no client tipado.
type AppointmentTableRow = Omit<AppointmentRow, "contact">;
type AppointmentsTable = {
  Row: AppointmentTableRow;
  Insert: Partial<AppointmentTableRow> & {
    tenant_id: string;
    title: string;
    date: string;
    time_start: string;
  };
  Update: Partial<AppointmentTableRow>;
  Relationships: [];
};

type SupabaseWithAppointments = SupabaseClient<
  Database & {
    public: Database["public"] & {
      Tables: Database["public"]["Tables"] & { appointments: AppointmentsTable };
    };
  }
>;

const appointmentsClient = supabase as unknown as SupabaseWithAppointments;

const APPOINTMENTS_KEY = "appointments";

function weekRange(weekStart: Date): { from: string; to: string } {
  const end = new Date(weekStart);
  end.setDate(end.getDate() + 6);
  return { from: format(weekStart, "yyyy-MM-dd"), to: format(end, "yyyy-MM-dd") };
}

export function useAppointments(weekStart: Date) {
  const { from, to } = weekRange(weekStart);
  return useQuery({
    queryKey: [APPOINTMENTS_KEY, from, to],
    queryFn: async (): Promise<AppointmentRow[]> => {
      const { data, error } = await appointmentsClient
        .from("appointments")
        .select(
          "id, tenant_id, contact_id, title, date, time_start, time_end, modality, status, notes, custom_fields, external_ref, external_source, created_by, created_at, updated_at, contact:contacts(id, name)",
        )
        .gte("date", from)
        .lte("date", to)
        .order("date", { ascending: true })
        .order("time_start", { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as AppointmentRow[];
    },
  });
}

function useInvalidateAppointments() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: [APPOINTMENTS_KEY] });
}

export type AppointmentFormInput = {
  contactId: string | null;
  title: string;
  date: string;
  timeStart: string;
  timeEnd: string | null;
  modality: AppointmentModality;
  notes: string | null;
};

export function useCreateAppointment() {
  const invalidate = useInvalidateAppointments();
  const { data: profile } = useCurrentProfile();

  return useMutation({
    mutationFn: async (input: AppointmentFormInput): Promise<void> => {
      if (!profile) throw new Error("Sessão inválida");
      const { error } = await appointmentsClient.from("appointments").insert({
        tenant_id: profile.tenant_id,
        contact_id: input.contactId,
        title: input.title,
        date: input.date,
        time_start: input.timeStart,
        time_end: input.timeEnd,
        modality: input.modality,
        notes: input.notes,
        created_by: profile.id,
      });
      if (error) throw error;
    },
    onSuccess: invalidate,
  });
}

export type UpdateAppointmentInput = AppointmentFormInput & {
  id: string;
  status: AppointmentStatus;
};

export function useUpdateAppointment() {
  const invalidate = useInvalidateAppointments();
  return useMutation({
    mutationFn: async (input: UpdateAppointmentInput): Promise<void> => {
      const { error } = await appointmentsClient
        .from("appointments")
        .update({
          contact_id: input.contactId,
          title: input.title,
          date: input.date,
          time_start: input.timeStart,
          time_end: input.timeEnd,
          modality: input.modality,
          status: input.status,
          notes: input.notes,
        })
        .eq("id", input.id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });
}

export function useDeleteAppointment() {
  const invalidate = useInvalidateAppointments();
  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const { error } = await appointmentsClient.from("appointments").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });
}
