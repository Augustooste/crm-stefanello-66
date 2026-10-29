// Testa os mapeadores puros de lead-enrich (supabase/functions/lead-enrich/mappers.ts).
// Fixtures baseadas nos shapes documentados dos Actors Apify. Sem I/O — não precisa
// de mock de rede/env. (Validação ao vivo do output real fica pendente de key elegível.)
import {
  type ContactPatch,
  instagramHandle,
  mapInstagram,
  mapWebsite,
  mapWhatsapp,
  mergeEmptyOnly,
} from "../lead-enrich/mappers.ts";

function assertEq(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: esperado ${e}, obtido ${a}`);
}

Deno.test("instagramHandle", async (t) => {
  await t.step("extrai handle de URL", () => {
    assertEq(instagramHandle("https://instagram.com/natgeo/"), "natgeo", "url");
  });
  await t.step("tira o @", () => assertEq(instagramHandle("@natgeo"), "natgeo", "@"));
  await t.step("aceita handle cru", () => assertEq(instagramHandle("natgeo"), "natgeo", "cru"));
  await t.step("descarta rota /p/ /reel/", () => {
    assertEq(instagramHandle("https://instagram.com/p/abc123"), undefined, "post");
  });
  await t.step("vazio => undefined", () => assertEq(instagramHandle(""), undefined, "vazio"));
});

Deno.test("mapInstagram", async (t) => {
  await t.step("mapeia perfil de negócio", () => {
    const item = {
      username: "natgeo",
      fullName: "National Geographic",
      biography: "Experience the world.",
      externalUrl: "https://nationalgeographic.com",
      businessEmail: "PRESS@natgeo.com",
      followersCount: 280_000_000,
      isBusinessAccount: true,
    };
    assertEq(mapInstagram(item), {
      name: "National Geographic",
      website: "https://nationalgeographic.com",
      email: "press@natgeo.com",
      description: "Experience the world.",
    }, "ig-business");
  });
  await t.step("externalUrls (array) também funciona", () => {
    assertEq(
      mapInstagram({ fullName: "X", externalUrls: [{ url: "https://x.com" }] }).website,
      "https://x.com",
      "externalUrls",
    );
  });
  await t.step("item vazio => patch vazio", () => assertEq(mapInstagram({}), {}, "vazio"));
});

Deno.test("mapWebsite", async (t) => {
  await t.step("pega 1º email/telefone e redes", () => {
    const item = {
      url: "https://acme.com",
      emails: ["Contato@acme.com", "vendas@acme.com"],
      phones: ["+55 11 99999-0000"],
      instagrams: ["https://instagram.com/acme"],
      linkedIns: ["https://linkedin.com/company/acme"],
    };
    assertEq(mapWebsite(item), {
      email: "contato@acme.com",
      phone: "+55 11 99999-0000",
      instagram: "acme",
      linkedin: "https://linkedin.com/company/acme",
    }, "site");
  });
  await t.step("cai pra phonesUncertain se phones vazio", () => {
    assertEq(
      mapWebsite({ phonesUncertain: ["+551130000000"] }).phone,
      "+551130000000",
      "uncertain",
    );
  });
  await t.step("sem contatos => vazio", () => assertEq(mapWebsite({ emails: [] }), {}, "vazio"));
});

Deno.test("mapWhatsapp (vero-api/whatsapp-scraper)", async (t) => {
  await t.step("hasWhatsApp true, sem negócio", () => {
    assertEq(mapWhatsapp({ hasWhatsApp: true }), { hasWhatsapp: true, patch: {} }, "t");
  });
  await t.step("chave alternativa on_whatsapp", () => {
    assertEq(mapWhatsapp({ on_whatsapp: true }), { hasWhatsapp: true, patch: {} }, "alt");
  });
  await t.step(
    "ausente => false",
    () => assertEq(mapWhatsapp({}), { hasWhatsapp: false, patch: {} }, "false"),
  );
  await t.step("conta business preenche email/site (shape real)", () => {
    const real = {
      number: "5521999999999",
      hasWhatsApp: true,
      accountType: "business",
      about: null,
      profilePicUrl: null,
      business: {
        description: null,
        category: "Retail",
        email: "Loja@x.com",
        websites: ["https://x.com"],
        address: null,
      },
    };
    assertEq(mapWhatsapp(real), {
      hasWhatsapp: true,
      accountType: "business",
      patch: { email: "loja@x.com", website: "https://x.com" },
    }, "wa-business-real");
  });
});

// Fixtures de SHAPE REAL capturado ao vivo (2026-07-24) — travam o mapper contra
// o output de verdade dos Actors, não só o README.
Deno.test("shapes reais (validado ao vivo)", async (t) => {
  await t.step("IG @natgeo real", () => {
    const real = {
      username: "natgeo",
      fullName: "National Geographic",
      biography: "Step into wonder and find your inner explorer.",
      externalUrl: "http://visitstore.bio/natgeo",
      externalUrls: [{ url: "http://visitstore.bio/natgeo", link_type: "external" }],
      isBusinessAccount: true,
      followersCount: 280000000,
    };
    assertEq(mapInstagram(real), {
      name: "National Geographic",
      website: "http://visitstore.bio/natgeo",
      description: "Step into wonder and find your inner explorer.",
    }, "ig-real");
  });
  await t.step("website apify.com real (só linkedin veio)", () => {
    const real = {
      domain: "apify.com",
      emails: [],
      phones: [],
      phonesUncertain: [],
      instagrams: [],
      linkedIns: ["https://www.linkedin.com/company/apify", "http://linkedin.com/company/apify"],
      twitters: ["https://x.com/apify"],
    };
    assertEq(mapWebsite(real), { linkedin: "https://www.linkedin.com/company/apify" }, "web-real");
  });
});

Deno.test("mergeEmptyOnly — nunca sobrescreve dado do usuário", async (t) => {
  await t.step("só preenche coluna vazia", () => {
    const contact = { name: "Já Existe", email: null, website: "", phone: "+5511" };
    const patch: ContactPatch = {
      name: "Do Enrich",
      email: "novo@x.com",
      website: "https://x.com",
      phone: "+5599",
    };
    assertEq(mergeEmptyOnly(contact, patch), {
      email: "novo@x.com",
      website: "https://x.com",
    }, "empty-fill");
  });
  await t.step(
    "patch vazio => nada",
    () => assertEq(mergeEmptyOnly({ name: "A" }, {}), {}, "vazio"),
  );
});

// Regressões dos bugs achados no review (shape real: chave primária PRESENTE mas
// vazia `[]`/`""` deve recuar para a alternativa — `firstOf(a ?? b)` não fazia).
Deno.test("regressão: firstOf recua sobre vazio (não só null)", async (t) => {
  await t.step("phones:[] => usa phonesUncertain", () => {
    assertEq(
      mapWebsite({ phones: [], phonesUncertain: ["+551130000000"] }).phone,
      "+551130000000",
      "phones",
    );
  });
  await t.step("linkedIns:[] => usa linkedins", () => {
    assertEq(
      mapWebsite({ linkedIns: [], linkedins: ["https://linkedin.com/company/x"] }).linkedin,
      "https://linkedin.com/company/x",
      "linkedins",
    );
  });
  await t.step("externalUrl:'' => usa externalUrls", () => {
    assertEq(
      mapInstagram({ fullName: "X", externalUrl: "", externalUrls: [{ url: "https://x.com" }] })
        .website,
      "https://x.com",
      "externalUrl-vazio",
    );
  });
  await t.step("business.websites:[] => usa business.website", () => {
    assertEq(
      mapWhatsapp({ hasWhatsApp: true, business: { websites: [], website: "https://loja.com" } })
        .patch.website,
      "https://loja.com",
      "biz-websites-vazio",
    );
  });
});

Deno.test("regressão: instagramHandle descarta URL/lixo", async (t) => {
  await t.step("URL sem handle (barra final) => undefined", () => {
    assertEq(instagramHandle("https://instagram.com/"), undefined, "url-sem-handle");
  });
  await t.step("URL crua não-IG => undefined", () => {
    assertEq(instagramHandle("https://site.com/pagina"), undefined, "url-crua");
  });
  await t.step("username com ponto é válido", () => {
    assertEq(instagramHandle("https://instagram.com/nat.geo"), "nat.geo", "ponto-ok");
  });
});
