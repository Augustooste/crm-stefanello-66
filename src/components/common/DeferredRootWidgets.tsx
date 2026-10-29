import { Suspense, lazy, useEffect, useState } from "react";

/**
 * Widgets globais que não fazem parte da primeira pintura (toaster, PWA).
 * São carregados em chunks separados e montados só depois da hidratação,
 * para tirar esse JS do caminho crítico sem mudar comportamento nem visual.
 */
const Toaster = lazy(() => import("@/components/ui/sonner").then((m) => ({ default: m.Toaster })));
const ServiceWorkerRegister = lazy(() =>
  import("@/components/pwa/ServiceWorkerRegister").then((m) => ({
    default: m.ServiceWorkerRegister,
  })),
);
const InstallBanner = lazy(() =>
  import("@/components/pwa/InstallBanner").then((m) => ({ default: m.InstallBanner })),
);

export function DeferredRootWidgets() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  return (
    <Suspense fallback={null}>
      <Toaster />
      <ServiceWorkerRegister />
      <InstallBanner />
    </Suspense>
  );
}
