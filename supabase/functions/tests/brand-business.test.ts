import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  consolidateBusiness,
  countFilledFields,
  discoverInternalLinks,
  extractJsonLdNodes,
  extractVisibleText,
  factsFromJsonLd,
  MAX_INTERNAL_PAGES,
  parseAiBusiness,
} from "../brand-extract/business.ts";

function resolve(raw: string, base: string): string {
  return new URL(raw, base).toString();
}

Deno.test("brand-extract/business", async (t) => {
  await t.step("JSON-LD de LocalBusiness vira fatos com fonte estruturada", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "LocalBusiness",
      name: "Freedom Digital Hub",
      description: "Agência de marketing digital",
      address: { addressLocality: "São Paulo", addressRegion: "SP" },
      priceRange: "R$ 1.000 a R$ 5.000",
      url: "https://freedomdigitalhub.com.br",
      openingHoursSpecification: [
        { dayOfWeek: "Monday", opens: "09:00", closes: "18:00" },
      ],
    })}</script>`;
    const nodes = extractJsonLdNodes(html);
    assertEquals(nodes.length, 1);
    const facts = factsFromJsonLd(nodes);
    assertEquals(facts.company_name, "Freedom Digital Hub");
    assertEquals(facts.city, "São Paulo");
    assertEquals(facts.region, "SP");
    assertEquals(facts.price_range, "R$ 1.000 a R$ 5.000");
    assertEquals(facts.opening_hours[0], {
      dayOfWeek: "monday",
      opens: "09:00",
      closes: "18:00",
    });
  });

  await t.step("JSON-LD inválido não derruba a extração", () => {
    const nodes = extractJsonLdNodes(`<script type="application/ld+json">{ nope</script>`);
    assertEquals(nodes.length, 0);
  });

  await t.step("texto visível remove script/style e limita tamanho", () => {
    const html = `<html><head><style>.a{color:red}</style><script>var x=1</script></head>
      <body><h1>Serviços</h1><p>Tráfego pago e social media.</p></body></html>`;
    const text = extractVisibleText(html, 200);
    assertEquals(text.includes("var x"), false);
    assertEquals(text.includes("color:red"), false);
    assertEquals(text.includes("Tráfego pago"), true);
  });

  await t.step("descoberta de links internos respeita o mesmo host e o limite", () => {
    const html = `
      <a href="/sobre">Sobre</a>
      <a href="/servicos">Serviços</a>
      <a href="/contato">Contato</a>
      <a href="/blog/post-1">Blog</a>
      <a href="/precos">Preços</a>
      <a href="https://facebook.com/x">Facebook</a>
      <a href="/sobre">Sobre de novo</a>`;
    const links = discoverInternalLinks(
      html,
      "https://exemplo.com.br/",
      resolve,
      MAX_INTERNAL_PAGES,
    );
    assertEquals(links.length <= MAX_INTERNAL_PAGES, true);
    assertEquals(links.some((l) => l.includes("facebook.com")), false);
    assertEquals(new Set(links).size, links.length);
  });

  await t.step("resposta da IA fora do formato devolve campos vazios", () => {
    const parsed = parseAiBusiness("desculpe, não sei");
    assertEquals(parsed.company_name.value, null);
    assertEquals(parsed.services.value, null);
  });

  await t.step("resposta da IA em bloco markdown é aceita", () => {
    const parsed = parseAiBusiness(
      "```json\n" +
        JSON.stringify({
          company_name: { value: "Freedom", confidence: 0.9 },
          services: { value: ["SEO", "Ads"], confidence: 0.8 },
        }) +
        "\n```",
    );
    assertEquals(parsed.company_name.value, "Freedom");
    assertEquals(parsed.services.value, ["SEO", "Ads"]);
  });

  await t.step("JSON-LD tem prioridade sobre a IA e a IA tem teto de confiança", () => {
    const business = consolidateBusiness({
      jsonLd: factsFromJsonLd(
        extractJsonLdNodes(
          `<script type="application/ld+json">${JSON.stringify({
            "@type": "Organization",
            name: "Nome Estruturado",
          })}</script>`,
        ),
      ),
      meta: { title: "Título da página", description: "Descrição", canonical: null },
      ai: parseAiBusiness(
        JSON.stringify({
          company_name: { value: "Nome da IA", confidence: 1 },
          segment: { value: "marketing digital", confidence: 0.95 },
        }),
      ),
      finalUrl: "https://exemplo.com.br/",
    });
    assertEquals(business.company_name.value, "Nome Estruturado");
    assertEquals(business.company_name.source, "json-ld");
    assertEquals(business.segment.value, "marketing digital");
    assertEquals(business.segment.source, "ai");
    assertEquals(business.segment.confidence <= 0.9, true);
  });

  await t.step("sem evidência nenhuma o campo fica vazio, nunca inventado", () => {
    const business = consolidateBusiness({
      jsonLd: factsFromJsonLd([]),
      meta: { title: null, description: null, canonical: null },
      ai: null,
      finalUrl: "https://exemplo.com.br/",
    });
    assertEquals(business.company_name.value, null);
    assertEquals(business.company_name.source, "none");
    assertEquals(business.city.value, null);
    // website_url sempre existe: é a própria URL final acessada.
    assertEquals(business.website_url.value, "https://exemplo.com.br/");
    assertEquals(countFilledFields(business), 1);
  });
});
