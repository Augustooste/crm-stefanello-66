import { ArrowUpRight, Bot, MessageCircleMore, TrendingUp } from "lucide-react";

type ProductSignalPreviewProps = {
  className?: string;
  compact?: boolean;
};

/** Visual estático de produto: explica valor sem depender de dados de um tenant. */
export function ProductSignalPreview({ className, compact = false }: ProductSignalPreviewProps) {
  return (
    <section
      aria-label="Prévia do painel CRM IA"
      className={`overflow-hidden rounded-2xl border border-white/10 bg-[var(--neutral-950)] shadow-2xl shadow-black/25 ${className ?? ""}`}
    >
      <div className="flex items-center justify-between border-b border-white/8 px-4 py-3 sm:px-5">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-primary" />
          <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
            Sinais de receita
          </span>
        </div>
        <span className="rounded-full bg-emerald-400/10 px-2 py-1 text-[10px] font-semibold text-emerald-300">
          Ao vivo
        </span>
      </div>

      <div className="grid gap-3 p-4 sm:p-5">
        <div className="grid grid-cols-[1fr_auto] gap-3 rounded-xl border border-white/8 bg-white/[0.035] p-3 sm:p-4">
          <div>
            <p className="text-caption text-slate-400">Funil aberto</p>
            <p className="mt-1 text-h4 font-semibold tracking-[-0.04em] text-white">R$ 148.200</p>
            <p className="mt-1 flex items-center gap-1 text-caption font-medium text-emerald-300">
              <TrendingUp className="h-3.5 w-3.5" /> 18% neste mês
            </p>
          </div>
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary/15 text-primary">
            <ArrowUpRight className="h-5 w-5" />
          </span>
        </div>

        {!compact && (
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-xl border border-white/8 bg-white/[0.025] p-3">
              <div className="flex items-center gap-2 text-caption font-semibold text-slate-200">
                <MessageCircleMore className="h-4 w-4 text-primary" />
                Inbox priorizado
              </div>
              <p className="mt-2 text-caption leading-5 text-slate-400">
                6 conversas aguardam a próxima ação.
              </p>
            </div>
            <div className="rounded-xl border border-white/8 bg-white/[0.025] p-3">
              <div className="flex items-center gap-2 text-caption font-semibold text-slate-200">
                <Bot className="h-4 w-4 text-primary" />
                IA em contexto
              </div>
              <p className="mt-2 text-caption leading-5 text-slate-400">
                Follow-up sugerido para não perder o timing.
              </p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
