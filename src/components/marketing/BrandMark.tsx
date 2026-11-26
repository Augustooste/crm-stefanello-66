import { cn } from "@/lib/utils";

type BrandMarkProps = {
  compact?: boolean;
  className?: string;
};

/** Logo oficial compartilhado pelos pontos de identidade visual. */
export function BrandMark({ compact = false, className }: BrandMarkProps) {
  return (
    <img
      src="/stefanello-logo.png"
      alt="Laticínio Stefanello"
      width={600}
      height={181}
      className={cn(
        "block max-w-full object-contain",
        compact ? "h-8 w-auto" : "h-10 w-auto",
        className,
      )}
    />
  );
}
