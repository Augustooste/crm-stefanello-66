// Horário de atendimento do tenant — a mesma configuração que o cliente já
// preenche em Configurações > Perfil do Negócio (`tenants.business_profile.hours`,
// escrita por src/components/settings/BusinessProfileForm.tsx). Nenhuma coluna
// nova: quem respondeu "atendo de segunda a sexta, das 9h às 18h" já disse
// quando pode mandar mensagem automática.
//
// Consumido pelo nurture-runner para não disparar sequência de madrugada.

/** Um dia da semana no formato salvo pelo formulário. */
export interface BusinessHoursDay {
  enabled: boolean;
  /** "HH:MM" no fuso do tenant. */
  open: string;
  close: string;
}

export type BusinessHours = Record<string, BusinessHoursDay>;

/** Índice de `Date.getUTCDay()` para a chave usada no formulário. */
const DIAS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

// aceleraflow não tem fuso por tenant (confirmado em `tenants` — sem coluna).
// Mesmo default de _shared/ai/context-builder.ts: enquanto a base é toda
// brasileira, um segundo lugar assumindo o mesmo fuso é mais honesto que uma
// coluna que ninguém preenche.
export const DEFAULT_TIMEZONE = "America/Sao_Paulo";

/**
 * Usado quando o tenant nunca salvou o Perfil do Negócio (a coluna nasce
 * `'{}'::jsonb`). Espelha o default do formulário — seg a sex, 9h às 18h.
 *
 * Nem abrir tudo nem fechar tudo: liberar geral traria de volta o envio de
 * madrugada que esta função existe para impedir, e bloquear tudo faria a
 * sequência nunca sair para quem não mexeu em configurações, uma falha que
 * ninguém veria.
 */
export const DEFAULT_BUSINESS_HOURS: BusinessHours = {
  mon: { enabled: true, open: "09:00", close: "18:00" },
  tue: { enabled: true, open: "09:00", close: "18:00" },
  wed: { enabled: true, open: "09:00", close: "18:00" },
  thu: { enabled: true, open: "09:00", close: "18:00" },
  fri: { enabled: true, open: "09:00", close: "18:00" },
  sat: { enabled: false, open: "09:00", close: "18:00" },
  sun: { enabled: false, open: "09:00", close: "18:00" },
};

/**
 * "HH:MM" em minutos desde a meia-noite. Aceita "24:00" como fim do dia — é a
 * única forma de dizer "atende o dia inteiro" sem deixar o último minuto de
 * fora.
 */
function minutosDe(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min > 0)) return null;
  return h * 60 + min;
}

/**
 * Lê o `business_profile.hours` cru do banco. Dia ausente ou malformado cai no
 * default daquele dia, em vez de derrubar o envio inteiro: é jsonb sem
 * constraint, então o formato só é garantido por quem escreveu por último.
 */
export function parseBusinessHours(raw: unknown): BusinessHours {
  if (!raw || typeof raw !== "object") return DEFAULT_BUSINESS_HOURS;
  const entrada = raw as Record<string, unknown>;
  const saida: BusinessHours = { ...DEFAULT_BUSINESS_HOURS };
  for (const dia of DIAS) {
    const v = entrada[dia];
    if (!v || typeof v !== "object") continue;
    const d = v as Record<string, unknown>;
    const open = typeof d.open === "string" ? d.open : "";
    const close = typeof d.close === "string" ? d.close : "";
    if (minutosDe(open) === null || minutosDe(close) === null) continue;
    saida[dia] = { enabled: d.enabled === true, open, close };
  }
  return saida;
}

interface PartesLocais {
  ano: number;
  mes: number;
  dia: number;
  minutos: number;
  diaSemana: number;
}

function partesLocais(instante: Date, timeZone: string): PartesLocais {
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  }).formatToParts(instante);
  const get = (tipo: string) => partes.find((p) => p.type === tipo)?.value ?? "";
  const semana = get("weekday").toLowerCase().slice(0, 3);
  return {
    ano: Number(get("year")),
    mes: Number(get("month")),
    dia: Number(get("day")),
    minutos: Number(get("hour")) * 60 + Number(get("minute")),
    diaSemana: Math.max(0, DIAS.indexOf(semana as (typeof DIAS)[number])),
  };
}

/**
 * Converte uma hora "de parede" no fuso do tenant para o instante absoluto.
 *
 * ponytail: usa o deslocamento vigente no palpite, sem iterar. Uma virada de
 * horário de verão exatamente entre o palpite e o alvo erraria em 1h — o Brasil
 * não tem horário de verão desde 2019 e o efeito seria adiar ou antecipar um
 * envio em uma hora. Se algum dia isto atender fuso com DST, iterar duas vezes
 * resolve.
 */
function instanteLocal(
  ano: number,
  mes: number,
  dia: number,
  minutos: number,
  timeZone: string,
): Date {
  const palpite = Date.UTC(ano, mes - 1, dia, Math.floor(minutos / 60), minutos % 60);
  const p = partesLocais(new Date(palpite), timeZone);
  const comoUtc = Date.UTC(p.ano, p.mes - 1, p.dia, Math.floor(p.minutos / 60), p.minutos % 60);
  return new Date(palpite - (comoUtc - palpite));
}

export type JanelaDeEnvio =
  | { dentro: true }
  | { dentro: false; proximaAbertura: Date | null };

/**
 * Responde se `agora` está dentro do horário de atendimento e, quando não está,
 * quando a próxima janela abre.
 *
 * `proximaAbertura: null` significa que nenhum dia da semana está habilitado —
 * não existe "próxima abertura" e quem chama decide o que fazer (o runner adia
 * um dia e segue).
 */
export function janelaDeEnvio(
  hours: BusinessHours,
  agora: Date,
  timeZone: string = DEFAULT_TIMEZONE,
): JanelaDeEnvio {
  const p = partesLocais(agora, timeZone);

  // Offset 0 é hoje e só conta se a abertura ainda não passou; depois de
  // fechado, a próxima janela é a de outro dia.
  for (let offset = 0; offset <= 7; offset++) {
    const alvo = new Date(Date.UTC(p.ano, p.mes - 1, p.dia + offset));
    const cfg = hours[DIAS[alvo.getUTCDay()]];
    if (!cfg?.enabled) continue;

    const abre = minutosDe(cfg.open);
    const fecha = minutosDe(cfg.close);
    if (abre === null || fecha === null || fecha <= abre) continue;

    if (offset === 0) {
      if (p.minutos >= abre && p.minutos < fecha) return { dentro: true };
      if (p.minutos >= fecha) continue;
    }
    return {
      dentro: false,
      proximaAbertura: instanteLocal(
        alvo.getUTCFullYear(),
        alvo.getUTCMonth() + 1,
        alvo.getUTCDate(),
        abre,
        timeZone,
      ),
    };
  }

  return { dentro: false, proximaAbertura: null };
}
