// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare as a default target),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { loadEnv, type ConfigEnv } from "vite";

export default function config(configEnv: ConfigEnv) {
  const { mode } = configEnv;
  const env = loadEnv(mode, process.cwd(), "");
  // Fallback load-bearing no rebuild via GitHub (o .env pode não chegar), mas
  // ele vale SÓ para este projeto. Num remix o backend é outro: usar o fallback
  // ali faria o app clonado apontar para o backend errado e falhar em toda tela.
  const FALLBACK_PROJECT_ID = "dpdtgddkvdgswndzuofv";
  const fallbackSupabaseUrl = `https://${FALLBACK_PROJECT_ID}.supabase.co`;
  const fallbackSupabasePublishableKey = "sb_publishable_nbHDSIpyRbePTlV-XRepHw_-U4ps2-2";
  const envProjectId = env.VITE_SUPABASE_PROJECT_ID || env.SUPABASE_PROJECT_ID || "";
  const fallbackAllowed = envProjectId === "" || envProjectId === FALLBACK_PROJECT_ID;
  const supabaseUrl =
    env.VITE_SUPABASE_URL || env.SUPABASE_URL || (fallbackAllowed ? fallbackSupabaseUrl : "");
  const supabasePublishableKey =
    env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    env.SUPABASE_PUBLISHABLE_KEY ||
    (fallbackAllowed ? fallbackSupabasePublishableKey : "");

  return defineConfig({
    tanstackStart: {
      // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
      // nitro/vite builds from this
      server: { entry: "server" },
    },
    vite: {
      define: {
        "import.meta.env.VITE_SUPABASE_URL": JSON.stringify(supabaseUrl),
        "import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY": JSON.stringify(supabasePublishableKey),
        "process.env.SUPABASE_URL": JSON.stringify(supabaseUrl),
        "process.env.SUPABASE_PUBLISHABLE_KEY": JSON.stringify(supabasePublishableKey),
      },
    },
  })(configEnv);
}
