/**
 * Detector de intenção de follow-up em mensagens de contatos/leads.
 * Analisa frases em português e infere uma data sugerida de recontato.
 *
 * Portado quase linha a linha de clientes/pedro/medflow-v0/lib/ai/follow-up-detector.ts
 * (arquivo já 100% agnóstico de nicho — nenhuma palavra clínica nos regex).
 *
 * Isto é heurística determinística (regex), não IA — frases fora dos padrões
 * cobertos (ex.: "só depois do carnaval") simplesmente não disparam. O botão
 * manual de criar follow-up deve estar sempre visível; este detector é um
 * atalho, nunca o único caminho (PRD, riscos/armadilhas #7).
 */

export interface FollowUpSuggestion {
  detected: boolean;
  phrases: string[];
  suggestedDate: Date | null;
  confidence: "high" | "medium" | "low";
}

type PatternRule = {
  pattern: RegExp;
  priority: number; // maior = mais específico (ganha em conflito)
  resolve: (match: RegExpMatchArray, now: Date) => Date | null;
};

const WEEKDAY_MAP: Record<string, number> = {
  domingo: 0,
  segunda: 1,
  "segunda-feira": 1,
  terca: 2,
  terça: 2,
  "terca-feira": 2,
  "terça-feira": 2,
  quarta: 3,
  "quarta-feira": 3,
  quinta: 4,
  "quinta-feira": 4,
  sexta: 5,
  "sexta-feira": 5,
  sabado: 6,
  sábado: 6,
};

function nextWeekday(targetDay: number, now: Date): Date {
  const result = new Date(now);
  const currentDay = result.getDay();
  const daysUntil = (targetDay - currentDay + 7) % 7 || 7; // nunca 0 (mínimo 1 dia)
  result.setDate(result.getDate() + daysUntil);
  result.setHours(9, 0, 0, 0);
  return result;
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  d.setHours(9, 0, 0, 0);
  return d;
}

function nextDayOfMonth(dayNum: number, now: Date): Date {
  const result = new Date(now);
  result.setHours(9, 0, 0, 0);

  // Se o dia já passou neste mês, vai pro próximo mês
  if (dayNum <= result.getDate()) {
    result.setMonth(result.getMonth() + 1);
  }
  result.setDate(dayNum);
  return result;
}

const PATTERN_RULES: PatternRule[] = [
  // "dia 15", "dia 25" — data específica (priority alta)
  {
    pattern: /\bdia\s+(\d{1,2})\b/i,
    priority: 10,
    resolve: (match, now) => {
      const day = parseInt(match[1], 10);
      if (day < 1 || day > 31) return null;
      return nextDayOfMonth(day, now);
    },
  },
  // "semana que vem" → D+7
  {
    pattern: /\bsemana\s+que\s+vem\b/i,
    priority: 8,
    resolve: (_, now) => addDays(now, 7),
  },
  // dias da semana: "segunda", "terça", etc.
  {
    pattern:
      /\b(segunda(?:-feira)?|ter[cç]a(?:-feira)?|quarta(?:-feira)?|quinta(?:-feira)?|sexta(?:-feira)?|s[aá]bado|domingo)\b/i,
    priority: 7,
    resolve: (match, now) => {
      const raw = match[1]
        .toLowerCase()
        .normalize("NFD")
        // Remove combining diacritical marks (U+0300–U+036F) — escrito como
        // \u-range, não como caracteres literais, para não depender de
        // copy-paste preservar bytes combinantes intactos.
        .replace(/[\u0300-\u036f]/g, "");
      const targetDay = WEEKDAY_MAP[raw] ?? WEEKDAY_MAP[match[1].toLowerCase()];
      if (targetDay === undefined) return null;
      return nextWeekday(targetDay, now);
    },
  },
  // "retorno", "vou retornar" → D+3
  {
    pattern: /\b(retorno|vou retornar|vou voltar)\b/i,
    priority: 5,
    resolve: (_, now) => addDays(now, 3),
  },
  // "vou decidir" → D+2
  {
    pattern: /\bvou decidir\b/i,
    priority: 5,
    resolve: (_, now) => addDays(now, 2),
  },
  // "me chama", "me liga" → D+1
  {
    pattern: /\b(me chama|me liga|pode me ligar|me contata)\b/i,
    priority: 6,
    resolve: (_, now) => addDays(now, 1),
  },
  // "depois", "mais tarde" → D+1
  {
    pattern: /\b(depois|mais tarde)\b/i,
    priority: 3,
    resolve: (_, now) => addDays(now, 1),
  },
];

interface ResolvedPattern {
  phrase: string;
  priority: number;
  date: Date | null;
}

/**
 * Detecta intenção de follow-up em uma lista de mensagens.
 * Quando múltiplas frases são detectadas, usa a de maior prioridade (mais específica).
 */
export function detectFollowUpIntent(messages: string[]): FollowUpSuggestion {
  const now = new Date();
  const combined = messages.join(" ");

  const resolved: ResolvedPattern[] = [];

  for (const rule of PATTERN_RULES) {
    const matches = [...combined.matchAll(new RegExp(rule.pattern, "gi"))];
    for (const match of matches) {
      const date = rule.resolve(match, now);
      resolved.push({
        phrase: match[0],
        priority: rule.priority,
        date,
      });
    }
  }

  if (resolved.length === 0) {
    return { detected: false, phrases: [], suggestedDate: null, confidence: "low" };
  }

  // Ordena pela maior prioridade (mais específico ganha)
  resolved.sort((a, b) => b.priority - a.priority);

  const uniquePhrases = [...new Set(resolved.map((r) => r.phrase.toLowerCase()))];
  const best = resolved[0];

  let confidence: "high" | "medium" | "low";
  if (best.priority >= 8) confidence = "high";
  else if (best.priority >= 5) confidence = "medium";
  else confidence = "low";

  return {
    detected: true,
    phrases: uniquePhrases,
    suggestedDate: best.date,
    confidence,
  };
}
