import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import {
  isSupportedProviderSlug,
  providerSupportsAudio,
  sendAudioViaProvider,
  sendViaProvider,
} from "../_shared/messaging/provider-send.ts";

Deno.test("simulador entrega texto e áudio sem credencial, telefone ou fetch externo", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = () => {
    fetchCalls++;
    throw new Error("O simulador não pode acessar um provedor externo.");
  };
  try {
    const slug: string = "simulator";
    assert(isSupportedProviderSlug(slug), "Simulador ausente do registro de providers");
    const admin = createClient("http://sb.local", "sr-key", {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const text = await sendViaProvider({ admin, providerSlug: slug, cred: {}, content: "Olá" });
    assert(text.ok);
    assertMatch(text.external_id!, /^simulator:/);
    assert(providerSupportsAudio(slug));
    const audio = await sendAudioViaProvider({
      providerSlug: slug,
      cred: {},
      phone: null,
      audio: { bytes: new Uint8Array([73, 68, 51, 1]).buffer, mime: "audio/mpeg" },
    });
    assert(audio.ok);
    assertMatch(audio.external_id!, /^simulator:/);
    assert(text.external_id !== audio.external_id);
    assertEquals(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
