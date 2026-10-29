import { assertEquals } from "jsr:@std/assert@1";
import { validatePublicHttpsUrl } from "../_shared/validate-http-url.ts";

// IP literais: bloqueados antes de qualquer DNS, entao roda offline.
const BLOCKED = [
  "https://127.0.0.1/",
  "https://169.254.169.254/",
  "https://[::1]/",
  "https://[::ffff:127.0.0.1]/", // o parser normaliza para ::ffff:7f00:1
  "https://[::ffff:7f00:1]/",
  "https://[::ffff:169.254.169.254]/",
  "https://[::ffff:a9fe:a9fe]/",
  "https://[::ffff:10.0.0.1]/",
  "https://[::7f00:1]/", // IPv4-compativel (deprecated)
  "https://[::a9fe:a9fe]/",
  "https://[64:ff9b::7f00:1]/", // NAT64
  "https://[64:ff9b::a9fe:a9fe]/",
  "https://[2002:7f00:1::]/", // 6to4
  "https://[fec0::1]/", // site-local
  "https://[ff02::1]/", // multicast
  "https://[fd00::1]/",
  "https://[fe80::1]/",
];
for (const url of BLOCKED) {
  Deno.test(`validatePublicHttpsUrl bloqueia ${url}`, async () => {
    assertEquals((await validatePublicHttpsUrl(url)).ok, false);
  });
}

Deno.test("validatePublicHttpsUrl aceita IPv4 e IPv6 publicos literais", async () => {
  assertEquals((await validatePublicHttpsUrl("https://8.8.8.8/")).ok, true);
  assertEquals((await validatePublicHttpsUrl("https://[::ffff:808:808]/")).ok, true); // 8.8.8.8 mapeado
  assertEquals((await validatePublicHttpsUrl("https://[2606:4700:4700::1111]/")).ok, true);
});

// DNS lento não pode segurar o lote do worker além do lease de 60 s.
const dnsLento = () => new Promise<string[]>((resolve) => setTimeout(() => resolve(["93.184.216.34"]), 200));

Deno.test("DNS lento além do teto reprova quando failClosedOnDnsTimeout", async () => {
  const inicio = Date.now();
  const r = await validatePublicHttpsUrl("https://lento.example.com/h", {
    resolveDns: dnsLento,
    dnsTimeoutMs: 20,
    failClosedOnDnsTimeout: true,
  });
  if (r.ok) throw new Error("deveria reprovar com DNS lento");
  if (Date.now() - inicio >= 200) throw new Error("esperou o DNS em vez do teto");
});

Deno.test("sem opções não há teto: DNS lento que resolve para IP privado ainda reprova", async () => {
  const lentoPrivado = () => new Promise<string[]>((resolve) => setTimeout(() => resolve(["10.0.0.5"]), 200));
  const r = await validatePublicHttpsUrl("https://lento.example.com/h", { resolveDns: lentoPrivado });
  if (r.ok) throw new Error("padrão deveria esperar o DNS e reprovar o IP privado");
});

Deno.test("DNS rápido dentro do teto continua checando IP resolvido", async () => {
  const r = await validatePublicHttpsUrl("https://interno.example.com/h", {
    resolveDns: () => Promise.resolve(["10.0.0.5"]),
    failClosedOnDnsTimeout: true,
  });
  if (r.ok) throw new Error("IP privado resolvido deveria reprovar");
});
