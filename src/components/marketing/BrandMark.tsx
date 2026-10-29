import { Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";

type BrandMarkProps = {
  compact?: boolean;
  className?: string;
};

/** A marca é deliberadamente simples para funcionar tanto na landing quanto no produto white-label. */
export function BrandMark({ compact = false, className }: BrandMarkProps) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <span
        aria-hidden="true"
        className="grid h-10 w-10 place-items-center rounded-xl border border-primary/30 bg-primary/15 text-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]"
      >
        <Sparkles className="h-5 w-5" strokeWidth={2.2} />
      </span>
      {!compact && (
        <span className="leading-tight">
          <span className="block text-base font-semibold tracking-[-0.03em] text-foreground">
            Stefanello
          </span>
          <span className="block text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Laticínios e embutidos
          </span>
        </span>
      )}
    </div>
  );
}
