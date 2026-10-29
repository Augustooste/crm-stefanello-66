import { useEffect } from "react";

/**
 * Registra o service worker mínimo (public/sw.js) só para satisfazer o
 * critério de instalabilidade PWA — sem cache/offline. Client-only: nunca
 * roda durante o SSR nem no primeiro render (efeito, não corpo do componente).
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;

    navigator.serviceWorker.register("/sw.js").catch((error: unknown) => {
      // Registro best-effort — falha não deve quebrar o app, mas precisa
      // aparecer no console (senão um 404/MIME errado/CSP bloqueado em prod
      // falha 100% silencioso, sem nenhum sinal de que a PWA não instala).
      console.error("Falha ao registrar service worker:", error);
    });
  }, []);

  return null;
}
