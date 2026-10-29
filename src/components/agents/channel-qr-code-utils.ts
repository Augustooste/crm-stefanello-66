import type { AgentPlatformQrCode } from "@/lib/api/agent-platform-contract";

const POLL_INTERVAL_MS = 4000;

/** Decisão pura: só continua o polling enquanto o canal não conectou e a
 * última chamada não falhou. Extraída pra ser testável sem timer real. */
export function qrRefetchInterval(
  data: AgentPlatformQrCode | undefined,
  isError: boolean,
): number | false {
  if (isError) return false;
  if (data && "connected" in data && data.connected === true) return false;
  return POLL_INTERVAL_MS;
}
