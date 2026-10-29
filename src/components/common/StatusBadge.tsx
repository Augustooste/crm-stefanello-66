import { cn } from "@/lib/utils";

type Variant = "success" | "warning" | "destructive" | "neutral" | "brand" | "outline";

const styles: Record<Variant, string> = {
  success: "bg-success/12 text-success border-success/25",
  // `--warning-foreground` é a cor para fundo warning SÓLIDO e não inverte no
  // tema escuro; sobre `bg-warning/15` (15% sobre fundo escuro) ela fica quase
  // invisível. No claro é o contrário — o token escuro é o legível. Daí o par.
  warning: "bg-warning/15 text-warning-foreground dark:text-warning border-warning/35",
  destructive: "bg-destructive/12 text-destructive border-destructive/25",
  neutral: "bg-muted text-muted-foreground border-border",
  brand: "bg-primary/12 text-primary border-primary/25",
  outline: "bg-transparent text-foreground border-border",
};

// DS §8/§2.5: cor nunca é o único sinal — dot tipado sempre acompanha o rótulo.
const dotColors: Record<Variant, string> = {
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
  neutral: "bg-muted-foreground",
  brand: "bg-primary",
  outline: "bg-muted-foreground",
};

export function StatusBadge({
  variant = "neutral",
  children,
  className,
  showDot = true,
}: {
  variant?: Variant;
  children: React.ReactNode;
  className?: string;
  showDot?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-0.5 text-caption font-medium",
        styles[variant],
        className,
      )}
    >
      {showDot && (
        <span
          className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dotColors[variant])}
          aria-hidden="true"
        />
      )}
      {children}
    </span>
  );
}
