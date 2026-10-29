// Fixture de mídia cifrada do WhatsApp: cifra um conteúdo conhecido com a mesma
// derivação do protocolo, para os testes exercitarem o caminho real sem guardar
// um `.enc` de produção no repo (o arquivo real tem áudio de um lead e o link da
// CDN expira).
//
// A cifragem aqui é INDEPENDENTE da implementação sob teste — repete a receita
// do protocolo em vez de importar `whatsapp-media.ts`. Assim o teste continua
// sendo um oráculo: se alguém trocar o rótulo HKDF ou a ordem dos bytes lá, o
// MAC daqui não confere e o teste cai.

/** Chave de 32 bytes usada pelas fixtures. Base64 igual ao que o webhook recebe. */
export const MEDIA_KEY_BYTES = new Uint8Array(new ArrayBuffer(32)).map(
  (_, i) => (i * 7 + 3) % 256,
);

export const MEDIA_KEY_BASE64 = btoa(String.fromCharCode(...MEDIA_KEY_BYTES));

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(a.byteLength + b.byteLength));
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

async function expandir(mediaKey: Uint8Array<ArrayBuffer>, info: string) {
  const key = await crypto.subtle.importKey("raw", mediaKey, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(new ArrayBuffer(32)),
      info: new TextEncoder().encode(info),
    },
    key,
    112 * 8,
  );
  const e = new Uint8Array(bits);
  const fatiar = (i: number, f: number) => {
    const out = new Uint8Array(new ArrayBuffer(f - i));
    out.set(e.subarray(i, f));
    return out;
  };
  return { iv: fatiar(0, 16), cipherKey: fatiar(16, 48), macKey: fatiar(48, 80) };
}

/** OGG de mentira com a assinatura real que a transcrição procura. */
export function oggFalso(tamanho = 5000): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(tamanho));
  bytes.set(new TextEncoder().encode("OggS"), 0);
  for (let i = 4; i < tamanho; i++) bytes[i] = i % 251;
  return bytes;
}

/** Cifra como o WhatsApp cifra: AES-256-CBC + 10 bytes de HMAC no fim. */
export async function cifrarMidiaWhatsApp(
  plano: Uint8Array<ArrayBuffer>,
  mediaKey: Uint8Array<ArrayBuffer> = MEDIA_KEY_BYTES,
  info = "WhatsApp Audio Keys",
): Promise<Uint8Array<ArrayBuffer>> {
  const { iv, cipherKey, macKey } = await expandir(mediaKey, info);
  const aesKey = await crypto.subtle.importKey("raw", cipherKey, { name: "AES-CBC" }, false, [
    "encrypt",
  ]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-CBC", iv }, aesKey, plano),
  );
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    macKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const assinatura = new Uint8Array(
    await crypto.subtle.sign("HMAC", hmacKey, concat(iv, ciphertext)),
  );
  return concat(ciphertext, assinatura.subarray(0, 10));
}
