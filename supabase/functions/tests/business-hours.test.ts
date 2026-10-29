import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DEFAULT_BUSINESS_HOURS,
  janelaDeEnvio,
  parseBusinessHours,
} from "../_shared/business-hours.ts";

// Relógio fixo em UTC. America/Sao_Paulo = UTC-3 o ano inteiro (sem horário de
// verão desde 2019), então 12:00Z é 09:00 local.
const SEG_12H_UTC = new Date("2026-08-03T12:00:00Z"); // segunda, 09:00 local
const SEG_17H_UTC = new Date("2026-08-03T17:00:00Z"); // segunda, 14:00 local
const SEG_06H_UTC = new Date("2026-08-03T06:00:00Z"); // segunda, 03:00 local
const SEG_23H_UTC = new Date("2026-08-03T23:00:00Z"); // segunda, 20:00 local
const SAB_17H_UTC = new Date("2026-08-08T17:00:00Z"); // sábado, 14:00 local

Deno.test("dentro do horário: meio da tarde de um dia útil", () => {
  assertEquals(janelaDeEnvio(DEFAULT_BUSINESS_HOURS, SEG_17H_UTC), { dentro: true });
});

Deno.test("na abertura em ponto já está dentro", () => {
  assertEquals(janelaDeEnvio(DEFAULT_BUSINESS_HOURS, SEG_12H_UTC), { dentro: true });
});

Deno.test("madrugada: adia para a abertura do mesmo dia", () => {
  const r = janelaDeEnvio(DEFAULT_BUSINESS_HOURS, SEG_06H_UTC);
  assertEquals(r.dentro, false);
  if (r.dentro) return;
  assertEquals(r.proximaAbertura?.toISOString(), "2026-08-03T12:00:00.000Z");
});

Deno.test("depois de fechar: adia para a abertura do dia seguinte", () => {
  const r = janelaDeEnvio(DEFAULT_BUSINESS_HOURS, SEG_23H_UTC);
  assertEquals(r.dentro, false);
  if (r.dentro) return;
  assertEquals(r.proximaAbertura?.toISOString(), "2026-08-04T12:00:00.000Z");
});

Deno.test("dia desabilitado: pula o fim de semana inteiro até segunda", () => {
  const r = janelaDeEnvio(DEFAULT_BUSINESS_HOURS, SAB_17H_UTC);
  assertEquals(r.dentro, false);
  if (r.dentro) return;
  assertEquals(r.proximaAbertura?.toISOString(), "2026-08-10T12:00:00.000Z");
});

Deno.test("nenhum dia habilitado: não existe próxima abertura", () => {
  const fechado = Object.fromEntries(
    Object.entries(DEFAULT_BUSINESS_HOURS).map(([d, v]) => [d, { ...v, enabled: false }]),
  );
  const r = janelaDeEnvio(fechado, SEG_17H_UTC);
  assertEquals(r.dentro, false);
  if (r.dentro) return;
  assertEquals(r.proximaAbertura, null);
});

Deno.test("horário do tenant substitui o default", () => {
  const noturno = parseBusinessHours({
    mon: { enabled: true, open: "18:00", close: "22:00" },
  });
  assertEquals(janelaDeEnvio(noturno, SEG_17H_UTC).dentro, false);
  assertEquals(janelaDeEnvio(noturno, new Date("2026-08-03T22:00:00Z")).dentro, true);
});

Deno.test("hours ausente ou malformado cai no default, não trava o envio", () => {
  assertEquals(parseBusinessHours(undefined), DEFAULT_BUSINESS_HOURS);
  assertEquals(parseBusinessHours({}), DEFAULT_BUSINESS_HOURS);
  // Dia com horário inválido preserva o default daquele dia.
  assertEquals(
    parseBusinessHours({ mon: { enabled: true, open: "banana", close: "18:00" } }).mon,
    DEFAULT_BUSINESS_HOURS.mon,
  );
  // Já um dia válido sobrescreve.
  assertEquals(parseBusinessHours({ sat: { enabled: true, open: "10:00", close: "14:00" } }).sat, {
    enabled: true,
    open: "10:00",
    close: "14:00",
  });
});

Deno.test("00:00 às 24:00 cobre o dia inteiro, inclusive o último minuto", () => {
  const sempre = parseBusinessHours(
    Object.fromEntries(
      ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [
        d,
        { enabled: true, open: "00:00", close: "24:00" },
      ]),
    ),
  );
  assertEquals(janelaDeEnvio(sempre, SEG_06H_UTC).dentro, true);
  assertEquals(janelaDeEnvio(sempre, new Date("2026-08-04T02:59:00Z")).dentro, true); // 23:59 local
  assertEquals(janelaDeEnvio(sempre, SAB_17H_UTC).dentro, true);
});

Deno.test("fechamento antes da abertura é ignorado como configuração inválida", () => {
  const invertido = parseBusinessHours({
    mon: { enabled: true, open: "18:00", close: "09:00" },
    tue: { enabled: true, open: "09:00", close: "18:00" },
  });
  const r = janelaDeEnvio(invertido, SEG_17H_UTC);
  assertEquals(r.dentro, false);
  if (r.dentro) return;
  assertEquals(r.proximaAbertura?.toISOString(), "2026-08-04T12:00:00.000Z");
});
