import {
  format,
  formatDistanceToNow,
  isToday,
  isPast,
  isSameDay,
  startOfDay,
  isAfter,
} from "date-fns";
import { ptBR } from "date-fns/locale";

export const formatBRL = (v: number) =>
  v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });

// Custo Apify vem em USD (billing da própria Apify) — formato simples "US$
// X.XX", sem depender de locale (evita "US$1,23" vs "US$1.23" ambíguo).
export const formatUSD = (v: number) => `US$ ${v.toFixed(2)}`;

export const formatDate = (d: Date | string) => format(new Date(d), "dd/MM/yyyy", { locale: ptBR });

export const formatDateTime = (d: Date | string) =>
  format(new Date(d), "dd/MM HH:mm", { locale: ptBR });

export const formatTime = (d: Date | string) => format(new Date(d), "HH:mm", { locale: ptBR });

export const relativeFromNow = (d: Date | string) =>
  formatDistanceToNow(new Date(d), { locale: ptBR, addSuffix: true });

export { isToday, isPast, isSameDay, startOfDay, isAfter };
