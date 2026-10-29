// Service worker mínimo: só existe para satisfazer o critério de
// instalabilidade PWA (manifest + SW registrado). Sem cache/offline
// deliberadamente — fora do escopo desta etapa (ver PROJECT_CONTEXT.md).
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
