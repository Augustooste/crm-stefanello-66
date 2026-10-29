import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import {
  useAppointments,
  useCreateAppointment,
  useUpdateAppointment,
  useDeleteAppointment,
  type AppointmentRow,
} from "./appointments";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile, type CurrentProfile } from "@/lib/api/session";
import { createQueryWrapper } from "@/test/query-mocks";
import { asFromMock, createQueryBuilder, ok, fail } from "@/test/supabase-mock";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn() },
}));
vi.mock("@/lib/api/session", () => ({ useCurrentProfile: vi.fn() }));

function mockProfile(profile: CurrentProfile | null) {
  vi.mocked(useCurrentProfile).mockReturnValue({
    data: profile,
  } as unknown as ReturnType<typeof useCurrentProfile>);
}

const PROFILE: CurrentProfile = { id: "u1", tenant_id: "t1", name: "Ana", role: "admin" };

const APPOINTMENT: AppointmentRow = {
  id: "a1",
  tenant_id: "t1",
  contact_id: "c1",
  title: "Visita técnica",
  date: "2026-07-13",
  time_start: "10:00:00",
  time_end: "11:00:00",
  modality: "presencial",
  status: "scheduled",
  notes: null,
  custom_fields: {},
  external_ref: null,
  external_source: null,
  created_by: "u1",
  created_at: "2026-07-11T00:00:00Z",
  updated_at: "2026-07-11T00:00:00Z",
  contact: { id: "c1", name: "Cliente X" },
};

describe("useAppointments", () => {
  afterEach(() => vi.clearAllMocks());

  it("busca compromissos da semana e chama a tabela appointments", async () => {
    vi.mocked(supabase.from).mockImplementation(
      asFromMock(() => createQueryBuilder(ok([APPOINTMENT]))),
    );
    const { result } = renderHook(() => useAppointments(new Date(2026, 6, 13)), {
      wrapper: createQueryWrapper(),
    });
    await waitFor(() => expect(result.current.data).toEqual([APPOINTMENT]));
    expect(supabase.from).toHaveBeenCalledWith("appointments");
  });

  it("retorna array vazio quando data é null", async () => {
    vi.mocked(supabase.from).mockImplementation(asFromMock(() => createQueryBuilder(ok(null))));
    const { result } = renderHook(() => useAppointments(new Date(2026, 6, 13)), {
      wrapper: createQueryWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
  });

  it("propaga erro da consulta", async () => {
    vi.mocked(supabase.from).mockImplementation(asFromMock(() => createQueryBuilder(fail("boom"))));
    const { result } = renderHook(() => useAppointments(new Date(2026, 6, 13)), {
      wrapper: createQueryWrapper(),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe("useCreateAppointment", () => {
  afterEach(() => vi.clearAllMocks());

  it("rejeita sem sessão", async () => {
    mockProfile(null);
    const { result } = renderHook(() => useCreateAppointment(), { wrapper: createQueryWrapper() });
    await expect(
      result.current.mutateAsync({
        contactId: null,
        title: "Visita",
        date: "2026-07-13",
        timeStart: "10:00",
        timeEnd: null,
        modality: "presencial",
        notes: null,
      }),
    ).rejects.toThrow("Sessão inválida");
  });

  it("insere o compromisso com tenant_id/created_by do perfil atual", async () => {
    mockProfile(PROFILE);
    const builder = createQueryBuilder(ok(null));
    vi.mocked(supabase.from).mockImplementation(asFromMock(() => builder));

    const { result } = renderHook(() => useCreateAppointment(), { wrapper: createQueryWrapper() });
    await result.current.mutateAsync({
      contactId: "c1",
      title: "Visita técnica",
      date: "2026-07-13",
      timeStart: "10:00",
      timeEnd: "11:00",
      modality: "presencial",
      notes: "trazer contrato",
    });

    expect(builder.insert).toHaveBeenCalledWith({
      tenant_id: "t1",
      contact_id: "c1",
      title: "Visita técnica",
      date: "2026-07-13",
      time_start: "10:00",
      time_end: "11:00",
      modality: "presencial",
      notes: "trazer contrato",
      created_by: "u1",
    });
  });

  it("propaga erro do insert", async () => {
    mockProfile(PROFILE);
    vi.mocked(supabase.from).mockImplementation(
      asFromMock(() => createQueryBuilder(fail("falhou"))),
    );
    const { result } = renderHook(() => useCreateAppointment(), { wrapper: createQueryWrapper() });
    await expect(
      result.current.mutateAsync({
        contactId: null,
        title: "Visita",
        date: "2026-07-13",
        timeStart: "10:00",
        timeEnd: null,
        modality: "presencial",
        notes: null,
      }),
    ).rejects.toThrow("falhou");
  });
});

describe("useUpdateAppointment", () => {
  afterEach(() => vi.clearAllMocks());

  it("atualiza o compromisso pelo id", async () => {
    const builder = createQueryBuilder(ok(null));
    vi.mocked(supabase.from).mockImplementation(asFromMock(() => builder));

    const { result } = renderHook(() => useUpdateAppointment(), { wrapper: createQueryWrapper() });
    await result.current.mutateAsync({
      id: "a1",
      contactId: "c1",
      title: "Visita remarcada",
      date: "2026-07-14",
      timeStart: "14:00",
      timeEnd: null,
      modality: "online",
      status: "confirmed",
      notes: null,
    });

    expect(builder.update).toHaveBeenCalledWith({
      contact_id: "c1",
      title: "Visita remarcada",
      date: "2026-07-14",
      time_start: "14:00",
      time_end: null,
      modality: "online",
      status: "confirmed",
      notes: null,
    });
    expect(builder.eq).toHaveBeenCalledWith("id", "a1");
  });

  it("propaga erro do update", async () => {
    vi.mocked(supabase.from).mockImplementation(
      asFromMock(() => createQueryBuilder(fail("falhou"))),
    );
    const { result } = renderHook(() => useUpdateAppointment(), { wrapper: createQueryWrapper() });
    await expect(
      result.current.mutateAsync({
        id: "a1",
        contactId: null,
        title: "Visita",
        date: "2026-07-14",
        timeStart: "14:00",
        timeEnd: null,
        modality: "online",
        status: "confirmed",
        notes: null,
      }),
    ).rejects.toThrow("falhou");
  });
});

describe("useDeleteAppointment", () => {
  afterEach(() => vi.clearAllMocks());

  it("exclui o compromisso pelo id", async () => {
    const builder = createQueryBuilder(ok(null));
    vi.mocked(supabase.from).mockImplementation(asFromMock(() => builder));

    const { result } = renderHook(() => useDeleteAppointment(), { wrapper: createQueryWrapper() });
    await result.current.mutateAsync("a1");

    expect(builder.delete).toHaveBeenCalled();
    expect(builder.eq).toHaveBeenCalledWith("id", "a1");
  });

  it("propaga erro do delete", async () => {
    vi.mocked(supabase.from).mockImplementation(
      asFromMock(() => createQueryBuilder(fail("falhou"))),
    );
    const { result } = renderHook(() => useDeleteAppointment(), { wrapper: createQueryWrapper() });
    await expect(result.current.mutateAsync("a1")).rejects.toThrow("falhou");
  });
});
