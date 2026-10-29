import {
  AI_GATEWAY_TIMEOUT_MS,
  AI_MEDIA_SEND_TIMEOUT_MS,
  AI_RESPONSE_CALLER_TIMEOUT_MS,
  AI_RESPONSE_LOCK_TTL_MS,
  AI_STT_TOTAL_BUDGET_MS,
  AI_TTS_TOTAL_BUDGET_MS,
  SUPABASE_EDGE_REQUEST_IDLE_TIMEOUT_MS,
} from "../_shared/ai/execution-budget.ts";

Deno.test("orçamento do ai-respond mantém lock e caller acima do pior caso externo", () => {
  const worstCaseExternalMs = AI_STT_TOTAL_BUDGET_MS +
    2 * AI_GATEWAY_TIMEOUT_MS +
    AI_TTS_TOTAL_BUDGET_MS +
    AI_MEDIA_SEND_TIMEOUT_MS;

  if (AI_RESPONSE_LOCK_TTL_MS < worstCaseExternalMs + 20_000) {
    throw new Error(
      `lock sem folga: ${AI_RESPONSE_LOCK_TTL_MS}ms para ${worstCaseExternalMs}ms externos`,
    );
  }
  if (AI_RESPONSE_CALLER_TIMEOUT_MS < AI_RESPONSE_LOCK_TTL_MS + 15_000) {
    throw new Error(
      `caller precisa sobreviver ao lock e cleanup: ${AI_RESPONSE_CALLER_TIMEOUT_MS}ms`,
    );
  }
  if (AI_RESPONSE_CALLER_TIMEOUT_MS > SUPABASE_EDGE_REQUEST_IDLE_TIMEOUT_MS - 5_000) {
    throw new Error(
      `caller ultrapassa o idle timeout do Supabase: ${AI_RESPONSE_CALLER_TIMEOUT_MS}ms`,
    );
  }
});
