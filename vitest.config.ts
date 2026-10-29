import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    // CI e clones limpos nao tem .env.local. O client Supabase (Proxy lazy) e
    // instanciado no primeiro acesso a uma prop; workspaces.ts toca supabase.rpc
    // no top-level do modulo, entao qualquer teste que importa a cadeia
    // session -> workspaces dispara createSupabaseClient() e lanca "Missing
    // Supabase environment variable(s)". Valores dummy tornam a suite
    // auto-contida (so o client browser via VITE_*; nao mexe no client server
    // que le SUPABASE_URL/SERVICE_ROLE_KEY). Testes de comportamento real mockam
    // o client; os que testam o throw usam vi.stubEnv (precedencia em runtime).
    env: {
      VITE_SUPABASE_URL: "https://test.supabase.co",
      VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
    },
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/routeTree.gen.ts",
        "src/components/ui/**",
        "src/integrations/supabase/types.ts",
        "src/test/**",
        "src/**/*.test.{ts,tsx}",
      ],
      reporter: ["text-summary", "html"],
    },
  },
});
