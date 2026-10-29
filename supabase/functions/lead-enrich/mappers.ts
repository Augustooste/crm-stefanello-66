// Mapeadores puros (sem I/O) do output cru de cada Actor Apify para um patch de
// contato do CRM. Isolados aqui para serem testáveis por fixture — o handler
// (index.ts) só faz auth, chama os Actors e aplica o merge.
//
// LGPD: só fontes públicas (perfil Instagram, contatos do site, e dados de
// NEGÓCIO do WhatsApp Business que a empresa publicou). Nada pessoal (about/foto)
// é auto-preenchido em coluna, e nenhum dado de vazamento/breach é mapeado.
//
// VALIDADO AO VIVO (2026-07-24, conta free com Store access):
// - instagram-profile-scraper: fullName/externalUrl(string)/externalUrls(array de
//   obj com .url)/biography confirmados no perfil real @natgeo. (email/phone não
//   vêm nesse Actor sem add-on — mapeamento defensivo só preenche se vier.)
// - contact-info-scraper: emails/phones/phonesUncertain/instagrams/linkedIns
//   confirmados (nomes exatos das chaves) no site apify.com.
// - vero-api/whatsapp-scraper: hasWhatsApp/accountType/business{email,websites}
//   confirmados ao vivo no plano FREE (não exige plano pago, não é leak). Só os
//   campos de NEGÓCIO viram coluna; about/foto pessoal ficam só no raw.
// Getters seguem defensivos + item cru inteiro em custom_fields.enrichment.sources.

export interface ContactPatch {
  name?: string;
  email?: string;
  phone?: string;
  website?: string;
  instagram?: string;
  linkedin?: string;
  job_title?: string;
  description?: string;
}

function str(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

// Primeiro valor não-vazio entre chaves candidatas (nomes divergem entre Actors/builds).
function pick(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const s = str(obj[k]);
    if (s) return s;
  }
  return undefined;
}

// Primeiro valor não-vazio entre os candidatos, na ordem. Variádico de propósito:
// `firstOf(a, b)` recua para `b` quando `a` é presente-mas-vazio (`[]`/`""`) — o
// que `firstOf(a ?? b)` NÃO fazia (o `??` fica no `[]` e ignora `b`).
function firstOf(...vs: unknown[]): string | undefined {
  for (const v of vs) {
    if (Array.isArray(v)) {
      for (const el of v) {
        const s = typeof el === "string" ? str(el) : str((el as Record<string, unknown>)?.url);
        if (s) return s;
      }
    } else {
      const s = str(v);
      if (s) return s;
    }
  }
  return undefined;
}

// Extrai o @handle de uma URL/entrada de Instagram ("https://instagram.com/foo/" -> "foo").
export function instagramHandle(v: unknown): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  const m = s.match(/instagram\.com\/([^/?#]+)/i);
  const handle = (m ? m[1] : s).replace(/^@/, "").trim();
  // Username IG válido = letras/números/./_ até 30 chars. Descarta URL crua sem
  // handle ("https://instagram.com/") — que senão viraria "handle" e queimaria
  // uma chamada paga — e as rotas do IG (p/reel/explore/stories).
  if (!/^[a-zA-Z0-9._]{1,30}$/.test(handle)) return undefined;
  if (/^(p|reel|explore|stories)$/i.test(handle)) return undefined;
  return handle;
}

// apify/instagram-profile-scraper -> patch
export function mapInstagram(item: Record<string, unknown>): ContactPatch {
  const patch: ContactPatch = {};
  const name = pick(item, ["fullName", "full_name", "name"]);
  if (name) patch.name = name;
  const website = firstOf(item.externalUrl, item.externalUrls, item.external_url);
  if (website) patch.website = website;
  const email = pick(item, ["businessEmail", "public_email", "email"]);
  if (email) patch.email = email.toLowerCase();
  const bio = pick(item, ["biography", "bio"]);
  if (bio) patch.description = bio.slice(0, 500);
  return patch;
}

// vdrmota/contact-info-scraper -> patch
export function mapWebsite(item: Record<string, unknown>): ContactPatch {
  const patch: ContactPatch = {};
  const email = firstOf(item.emails);
  if (email) patch.email = email.toLowerCase();
  const phone = firstOf(item.phones, item.phonesUncertain);
  if (phone) patch.phone = phone;
  const ig = instagramHandle(firstOf(item.instagrams));
  if (ig) patch.instagram = ig;
  const linkedin = firstOf(item.linkedIns, item.linkedins);
  if (linkedin) patch.linkedin = linkedin;
  return patch;
}

export interface WhatsappResult {
  hasWhatsapp: boolean;
  accountType?: string;
  // Só dados de NEGÓCIO (empresa publicou público no WhatsApp Business) viram
  // patch de coluna. Nada pessoal (about/foto) é auto-preenchido — fica no raw.
  patch: ContactPatch;
}

// vero-api/whatsapp-scraper -> has-WhatsApp + tipo de conta + dados públicos de
// negócio. Roda no plano free (validado ao vivo) e NÃO é lastreado em vazamento
// (query WhatsApp ao vivo). Getters defensivos aceitam também as chaves dos
// validadores alternativos (on_whatsapp / is_on_whatsapp / exists).
export function mapWhatsapp(item: Record<string, unknown>): WhatsappResult {
  const raw = item.hasWhatsApp ?? item.hasWhatsapp ?? item.on_whatsapp ??
    item.is_on_whatsapp ?? item.isWhatsApp ?? item.exists ?? item.valid ?? item.isValid;
  const hasWhatsapp = raw === true || raw === "true" || raw === "yes" || raw === 1;
  const accountType = str(item.accountType ?? item.account_type ?? item.type);
  const patch: ContactPatch = {};
  const biz = item.business as Record<string, unknown> | undefined;
  if (biz && typeof biz === "object") {
    const email = str(biz.email);
    if (email) patch.email = email.toLowerCase();
    const website = firstOf(biz.websites, biz.website);
    if (website) patch.website = website;
  }
  return { hasWhatsapp, accountType, patch };
}

// Empty-fill: só preenche coluna que está vazia no contato. NUNCA sobrescreve
// dado que o usuário (ou outra fonte) já colocou. Retorna só as chaves a gravar.
export function mergeEmptyOnly(
  contact: Record<string, unknown>,
  patch: ContactPatch,
): ContactPatch {
  const out: ContactPatch = {};
  for (const [k, v] of Object.entries(patch) as [keyof ContactPatch, string | undefined][]) {
    if (v == null || v === "") continue;
    const current = str(contact[k]);
    if (!current) out[k] = v;
  }
  return out;
}
