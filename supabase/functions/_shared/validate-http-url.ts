// validate-http-url.ts — anti-SSRF: valida uma URL fornecida por um admin
// (via UI de integração) antes de qualquer fetch dela a partir da infra de
// edge functions. Rejeita:
//   - qualquer scheme != https
//   - hostnames localhost/*.local/*.internal
//   - IPs literais em faixas privadas (RFC1918), loopback, link-local
//     (169.254.0.0/16, incluindo o endpoint de metadata 169.254.169.254),
//     multicast e broadcast
//   - domínios conhecidos de metadata de cloud (metadata.google.internal etc)
//
// Best-effort quanto a DNS rebinding: quando `Deno.resolveDns` está
// disponível (edge runtime), resolvemos o hostname e reprovamos se qualquer
// IP resolvido cair numa das faixas bloqueadas. Sem resolveDns disponível
// (dev/test), a checagem por hostname literal ainda é aplicada.

const BLOCKED_HOST_SUFFIXES = [
  ".local",
  ".internal",
  ".localhost",
];

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
  "instance-data",
]);

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = nums;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 127.0.0.0/8 loopback
  if (a === 127) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 (link-local + metadata)
  if (a === 169 && b === 254) return true;
  // 100.64.0.0/10 CGNAT
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 0.0.0.0/8
  if (a === 0) return true;
  // multicast 224.0.0.0/4, reserved 240.0.0.0/4
  if (a >= 224) return true;
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const groups = expandIpv6(ip.toLowerCase());
  if (!groups) return true; // não parseável: falha fechado
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  const embeddedV4 = `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
  const upperZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (upperZero && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true; // :: e ::1
  // IPv4-mapped (::ffff:a.b.c.d) e IPv4-compatível (::a.b.c.d): vale a regra do IPv4 embutido.
  if (upperZero && (g5 === 0xffff || g5 === 0)) return isPrivateIpv4(embeddedV4);
  // NAT64 64:ff9b::/96 e 64:ff9b:1::/48 (RFC 8215): alcança IPv4 interno via gateway.
  if (g0 === 0x64 && g1 === 0xff9b) return true;
  if ((g0 & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g0 & 0xffc0) === 0xfec0) return true; // site-local fec0::/10 (deprecated)
  if ((g0 & 0xff00) === 0xff00) return true; // multicast ff00::/8
  if (g0 === 0x2002) return true; // 6to4 2002::/16
  return false;
}

/** Expande IPv6 textual (com `::` e/ou IPv4 final) em 8 grupos de 16 bits; null se inválido. */
function expandIpv6(ip: string): number[] | null {
  let text = ip;
  const dotted = text.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const o = dotted.slice(2).map(Number);
    if (o.some((n) => n > 255)) return null;
    text = `${dotted[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const toGroups = (s: string) => (s === "" ? [] : s.split(":"));
  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const all = [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  const nums = all.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return nums.length === 8 && nums.every((n) => !Number.isNaN(n)) ? nums : null;
}

function isIpLiteralBlocked(host: string): boolean {
  // strip brackets from IPv6
  const h = host.replace(/^\[/, "").replace(/\]$/, "");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return isPrivateIpv4(h);
  if (h.includes(":")) return isPrivateIpv6(h);
  return false;
}

export interface ValidateResult {
  ok: boolean;
  error?: string;
}

type ResolveDns = (name: string, kind: "A" | "AAAA") => Promise<string[]>;

export interface ValidateOptions {
  /** Injeção para teste; padrão: Deno.resolveDns quando existir. */
  resolveDns?: ResolveDns;
  /** Teto da resolução DNS (padrão 3 s quando failClosedOnDnsTimeout); sem as duas opções, não há teto. */
  dnsTimeoutMs?: number;
  /**
   * Reprova quando o DNS estoura o teto. Padrão false (comportamento antigo dos
   * chamadores sem teste); o worker de webhook liga para não estourar o lease.
   */
  failClosedOnDnsTimeout?: boolean;
}

const DEFAULT_DNS_TIMEOUT_MS = 3000;
const DNS_TIMEOUT = Symbol("dns-timeout");

export async function validatePublicHttpsUrl(
  rawUrl: string,
  options: ValidateOptions = {},
): Promise<ValidateResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: "URL inválida — informe uma URL completa começando com https://." };
  }

  if (parsed.protocol !== "https:") {
    return { ok: false, error: "Somente URLs https:// são aceitas." };
  }

  const host = parsed.hostname.toLowerCase();
  if (!host) return { ok: false, error: "URL sem host." };

  if (BLOCKED_HOSTNAMES.has(host)) {
    return { ok: false, error: "Host bloqueado (endpoint interno/metadata)." };
  }
  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (host.endsWith(suffix)) {
      return { ok: false, error: "Host bloqueado (domínio interno)." };
    }
  }

  if (isIpLiteralBlocked(host)) {
    return { ok: false, error: "IP privado/loopback/link-local não é permitido." };
  }

  // Best-effort DNS check: alguns runtimes de teste não expõem Deno.resolveDns.
  const resolveDns = options.resolveDns ??
    (globalThis as { Deno?: { resolveDns?: ResolveDns } }).Deno?.resolveDns;
  if (resolveDns && !/^\d+\.\d+\.\d+\.\d+$/.test(host) && !host.includes(":")) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const lookup = Promise.allSettled([resolveDns(host, "A"), resolveDns(host, "AAAA")]);
      // Teto só quando o chamador pede: sem opção, espera o resolver como antes
      // (pular a checagem de IP por timeout abriria bypass de SSRF por DNS lento).
      const bounded = options.failClosedOnDnsTimeout || options.dnsTimeoutMs !== undefined;
      const settled = bounded
        ? await Promise.race([
          lookup,
          new Promise<typeof DNS_TIMEOUT>((resolve) => {
            timer = setTimeout(() => resolve(DNS_TIMEOUT), options.dnsTimeoutMs ?? DEFAULT_DNS_TIMEOUT_MS);
          }),
        ])
        : await lookup;
      if (settled === DNS_TIMEOUT) {
        if (options.failClosedOnDnsTimeout) {
          return { ok: false, error: "Resolução DNS excedeu o tempo limite." };
        }
      } else {
        const [ipv4, ipv6] = settled;
        const ips: string[] = [];
        if (ipv4.status === "fulfilled") ips.push(...ipv4.value);
        if (ipv6.status === "fulfilled") ips.push(...ipv6.value);
        for (const ip of ips) {
          if (isIpLiteralBlocked(ip)) {
            return { ok: false, error: "Host resolve para IP privado/interno — rejeitado." };
          }
        }
      }
    } catch {
      // DNS indisponível — não bloqueia; a checagem literal acima já cobre o essencial.
    } finally {
      clearTimeout(timer);
    }
  }

  return { ok: true };
}
