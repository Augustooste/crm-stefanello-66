import {
  activeMembershipResponse,
  BASE_ENV,
  captureHandler,
  type FetchMatcher,
  installFetchMock,
  jsonResponse,
  setEnv,
} from "./_helpers.ts";

setEnv(BASE_ENV);
setEnv({ LOVABLE_API_KEY: "lovable-key" });

const capturedHandler = await captureHandler("../brand-extract/index.ts");

async function handler(req: Request): Promise<Response> {
  return await capturedHandler(req);
}


// ─── Fixtures de HTML ──────────────────────────────────────────────────────

function defaultHtml(): string {
  return `<!doctype html><html><head>
<meta name="theme-color" content="#3366ff">
<meta property="og:site_name" content="Empresa Teste">
<meta name="description" content="Descricao padrao da empresa teste para checagem de extracao.">
<title>Titulo Fallback</title>
<style>.a{color:#3366ff}.b{background:#ff9900}</style>
</head><body><div style="color:#3366ff">Ola</div></body></html>`;
}

function htmlSemCorNoTema(): string {
  // Sem theme-color: só cinzas/preto/quase-branco (filtrados) + uma cor válida.
  return `<!doctype html><html><head><title>Sem Tema</title></head>
<body><style>.g{color:#888888}.b{color:#010101}.w{color:#fefefe}.ok{color:#22aa44}</style></body></html>`;
}

function htmlSemCorNenhuma(): string {
  // Nenhuma cor aproveitável: só cinzas/preto/quase-branco.
  return `<!doctype html><html><head></head>
<body><style>.g{color:#888888}.b{color:#010101}.w{color:#fefefe}</style></body></html>`;
}

function htmlAtributosInvertidos(): string {
  // content antes de name/property — testa a segunda alternativa do `??`.
  return `<!doctype html><html><head>
<meta content="#112233" name="theme-color">
<meta content="Empresa Invertida" property="og:site_name">
<meta content="Descricao invertida." name="description">
</head><body></body></html>`;
}

function htmlSemMetaNenhuma(): string {
  return `<!doctype html><html><head></head><body>sem metadados</body></html>`;
}

function htmlHexInvalido(): string {
  return `<!doctype html><html><head>
<meta name="theme-color" content="notahexcolor">
</head><body></body></html>`;
}

function htmlHex3Digitos(): string {
  return `<!doctype html><html><head>
<meta name="theme-color" content="#0f0">
</head><body></body></html>`;
}

function htmlDescricaoLonga(): string {
  const longa = "d".repeat(250);
  return `<!doctype html><html><head>
<meta name="theme-color" content="#3366ff">
<meta name="description" content="${longa}">
</head><body></body></html>`;
}

function htmlOgDescription(): string {
  return `<!doctype html><html><head>
<meta name="theme-color" content="#3366ff">
<meta property="og:description" content="Descricao via og:description.">
</head><body></body></html>`;
}

function htmlCorEscura(hex: string): string {
  return `<!doctype html><html><head>
<meta name="theme-color" content="${hex}">
</head><body></body></html>`;
}

function htmlComAsset(markup: string, base = ""): string {
  return `<!doctype html><html><head>${base}${markup}
<meta name="theme-color" content="#3366ff"></head><body></body></html>`;
}

/** HTML grande (> MAX_BYTES) com metadados válidos no início. */
function htmlGrande(): string {
  const head = `<!doctype html><html><head>
<meta name="theme-color" content="#3366ff">
<meta property="og:site_name" content="Empresa Grande">
</head><body>`;
  const filler = "a".repeat(650_000);
  return `${head}${filler}</body></html>`;
}

// ─── Helpers de resposta HTTP mockada ──────────────────────────────────────

function htmlResponse(
  html: string,
  opts: { status?: number; contentType?: string } = {},
): Response {
  return new Response(html, {
    status: opts.status ?? 200,
    headers: { "content-type": opts.contentType ?? "text/html; charset=utf-8" },
  });
}

function redirectResponse(location: string | null, status = 302): Response {
  const headers = new Headers();
  if (location) headers.set("location", location);
  return new Response(null, { status, headers });
}

// ─── Mock de Deno.resolveDns (isolado neste arquivo, restaurado após cada uso) ──

type DnsResult = string[] | "reject" | "throw-sync";


function installDnsMock(a: DnsResult, aaaa: DnsResult): () => void {
  const original = Deno.resolveDns;
  // deno-lint-ignore no-explicit-any
  (Deno as any).resolveDns = (_host: string, type: "A" | "AAAA") => {
    const result = type === "A" ? a : aaaa;
    if (result === "throw-sync") throw new Error("falha síncrona de DNS");
    if (result === "reject") return Promise.reject(new Error("falha de DNS"));
    return Promise.resolve(result);
  };
  return () => {
    // deno-lint-ignore no-explicit-any
    (Deno as any).resolveDns = original;
  };
}




// ─── Estado / router do mock de fetch ──────────────────────────────────────

interface State {
  authOk: boolean;
  profile: { tenant_id: string; role: string } | null;
  /** Fila de respostas do "site do cliente" — repete a última se a fila acabar. */
  siteResponses: Array<() => Response>;
  aiStatus: number;
  aiBody: unknown;
  aiThrows: boolean;
  aiThrowsNonError: boolean;
  aiCalled: boolean;
  siteUrls: string[];
}

function defaultState(): State {
  return {
    authOk: true,
    profile: { tenant_id: "tenant-1", role: "admin" },
    siteResponses: [() => htmlResponse(defaultHtml())],
    aiStatus: 200,
    aiBody: { choices: [{ message: { content: JSON.stringify({ hex: null, segment: null }) } }] },
    aiThrows: false,
    aiThrowsNonError: false,
    aiCalled: false,
    siteUrls: [],
  };
}

function router(state: State): FetchMatcher {
  let siteCallIndex = 0;
  return (req) => {
    if (req.pathname === "/auth/v1/user") {
      if (!state.authOk) return jsonResponse(401, { msg: "invalid token" });
      return jsonResponse(200, { id: "user-1", email: "u@x.com", aud: "authenticated" });
    }
    if (req.pathname === "/rest/v1/profiles" && req.method === "GET") {
      return jsonResponse(200, state.profile ? [state.profile] : []);
    }
    const membership = activeMembershipResponse(req, state.profile);
    if (membership) return membership;
    if (req.url === "https://ai.gateway.lovable.dev/v1/chat/completions") {
      state.aiCalled = true;
      if (state.aiThrowsNonError) throw "falha não-Error na IA";
      if (state.aiThrows) throw new Error("falha de rede na IA");
      return jsonResponse(state.aiStatus, state.aiBody);
    }
    // Fetch do site do cliente.
    if (state.siteResponses.length === 0) return undefined;
    state.siteUrls.push(req.url);
    const idx = Math.min(siteCallIndex, state.siteResponses.length - 1);
    siteCallIndex++;
    return state.siteResponses[idx]();
  };
}

function req(body?: unknown, opts: { method?: string; auth?: string | null } = {}): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.auth !== null) headers.set("Authorization", opts.auth ?? "Bearer token-123");
  return new Request("http://fn.local", {
    method: opts.method ?? "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

Deno.test("brand-extract", async (t) => {
  await t.step("OPTIONS responde CORS sem corpo", async () => {
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(req(undefined, { method: "OPTIONS" }));
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
      if (await res.text()) throw new Error("esperado corpo vazio");
    } finally {
      uninstall();
    }
  });

  await t.step("método não-POST retorna 405", async () => {
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(req(undefined, { method: "GET" }));
      const body = await res.json();
      if (res.status !== 405 || body.error !== "Method not allowed") {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("sem usuário autenticado retorna 401", async () => {
    const state = defaultState();
    state.authOk = false;
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ url: "93.184.216.34" }));
      const body = await res.json();
      if (res.status !== 401 || body.error !== "Não autenticado.") {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("sem perfil retorna 403 'Perfil não encontrado'", async () => {
    const state = defaultState();
    state.profile = null;
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ url: "93.184.216.34" }));
      const body = await res.json();
      if (res.status !== 403 || body.error !== "Perfil não encontrado.") {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("perfil não-admin retorna 403 'Apenas administradores'", async () => {
    const state = defaultState();
    state.profile = { tenant_id: "tenant-1", role: "vendedor" };
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ url: "93.184.216.34" }));
      const body = await res.json();
      if (res.status !== 403 || body.error !== "Apenas administradores.") {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("corpo inválido (JSON quebrado) retorna 400", async () => {
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(
        new Request("http://fn.local", {
          method: "POST",
          headers: { Authorization: "Bearer x", "content-type": "application/json" },
          body: "{not-json",
        }),
      );
      const body = await res.json();
      if (res.status !== 400 || body.error !== "Corpo inválido.") {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("URL malformada (bracket IPv6 não fechado) retorna 400 'URL inválida'", async () => {
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(req({ url: "http://[not-valid" }));
      const body = await res.json();
      if (res.status !== 400 || body.error !== "URL inválida.") {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("body sem url vira string vazia e falha como URL inválida", async () => {
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(req({}));
      if (res.status !== 400) throw new Error(`esperado 400, veio ${res.status}`);
    } finally {
      uninstall();
    }
  });

  await t.step("URL sem esquema recebe prefixo https:// automaticamente", async () => {
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(req({ url: "93.184.216.34" }));
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
    } finally {
      uninstall();
    }
  });

  await t.step("host localhost é bloqueado (anti-SSRF)", async () => {
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(req({ url: "http://localhost/" }));
      const body = await res.json();
      if (res.status !== 422 || !String(body.error).includes("Endereço não permitido.")) {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("host *.internal é bloqueado (anti-SSRF)", async () => {
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(req({ url: "http://svc.internal/" }));
      const body = await res.json();
      if (res.status !== 422 || !String(body.error).includes("Endereço não permitido.")) {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("IPv4 privado literal (127.0.0.1) é bloqueado", async () => {
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(req({ url: "http://127.0.0.1/" }));
      const body = await res.json();
      if (res.status !== 422 || !String(body.error).includes("Endereço não permitido.")) {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("IPv4 privado literal (192.168.x.x) é bloqueado", async () => {
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(req({ url: "http://192.168.1.5/" }));
      if (res.status !== 422) throw new Error(`esperado 422, veio ${res.status}`);
    } finally {
      uninstall();
    }
  });

  await t.step("IPv4 multicast/reservado (>=224) é bloqueado", async () => {
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(req({ url: "http://224.0.0.1/" }));
      if (res.status !== 422) throw new Error(`esperado 422, veio ${res.status}`);
    } finally {
      uninstall();
    }
  });

  await t.step("IPv6 literal privado (::1) é bloqueado", async () => {
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(req({ url: "http://[::1]/" }));
      const body = await res.json();
      if (res.status !== 422 || !String(body.error).includes("Endereço não permitido.")) {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("IPv6 literal público segue o fluxo normal", async () => {
    const state = defaultState();
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ url: "http://[2001:db8::1]/" }));
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
    } finally {
      uninstall();
    }
  });

  await t.step("domínio sem permissão de rede real falha com erro amigável", async () => {
    // Sem mock de Deno.resolveDns e sem --allow-net: a resolução real falha
    // (permissão negada), caindo no catch/"resolved vazio" de assertPublicHost.
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(req({ url: "http://exemplo-real.test/" }));
      const body = await res.json();
      if (
        res.status !== 422 ||
        !String(body.error).includes("Não foi possível resolver o domínio.")
      ) {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("domínio: Deno.resolveDns lança erro síncrono cai no catch externo", async () => {
    const uninstallDns = installDnsMock("throw-sync", "throw-sync");
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(req({ url: "http://cliente.example/" }));
      const body = await res.json();
      if (
        res.status !== 422 ||
        !String(body.error).includes("Não foi possível resolver o domínio.")
      ) {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
      uninstallDns();
    }
  });

  await t.step(
    "domínio: A e AAAA resolvem vazio (sem lançar) retorna erro de resolução",
    async () => {
      const uninstallDns = installDnsMock([], []);
      const uninstall = installFetchMock(router(defaultState()));
      try {
        const res = await handler(req({ url: "http://cliente.example/" }));
        const body = await res.json();
        if (
          res.status !== 422 ||
          !String(body.error).includes("Não foi possível resolver o domínio.")
        ) {
          throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
        }
      } finally {
        uninstall();
        uninstallDns();
      }
    },
  );

  await t.step("domínio: A rejeitada + AAAA resolve IP privado é bloqueado", async () => {
    const uninstallDns = installDnsMock("reject", ["10.0.0.5"]);
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(req({ url: "http://cliente.example/" }));
      const body = await res.json();
      if (res.status !== 422 || !String(body.error).includes("Endereço não permitido.")) {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
      uninstallDns();
    }
  });

  await t.step("domínio: AAAA resolve IPv6 privado é bloqueado", async () => {
    const uninstallDns = installDnsMock("reject", ["fd00::1"]);
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(req({ url: "http://cliente.example/" }));
      const body = await res.json();
      if (res.status !== 422 || !String(body.error).includes("Endereço não permitido.")) {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
      uninstallDns();
    }
  });

  await t.step("domínio: A resolve IP público segue o fluxo normal", async () => {
    const state = defaultState();
    const uninstallDns = installDnsMock(["93.184.216.34"], "reject");
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ url: "http://cliente.example/" }));
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);

    } finally {
      uninstall();
      uninstallDns();
    }
  });

  await t.step("domínio: A resolve endereço malformado é tratado como não permitido", async () => {
    // isPrivateIpv4 tem uma checagem defensiva pra IP com formato inesperado
    // (não 4 partes numéricas) — só alcançável via um resultado malformado de
    // Deno.resolveDns, já que a regex de IP literal na URL nunca deixa passar
    // algo assim.
    const uninstallDns = installDnsMock(["not.an.ip"], "reject");
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(req({ url: "http://cliente.example/" }));
      const body = await res.json();
      if (res.status !== 422 || !String(body.error).includes("Endereço não permitido.")) {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
      uninstallDns();
    }
  });

  await t.step("redirect (3xx) sem header location falha com 'Redirect sem destino'", async () => {
    const state = defaultState();
    state.siteResponses = [() => redirectResponse(null)];
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ url: "93.184.216.34" }));
      const body = await res.json();
      if (res.status !== 422 || !String(body.error).includes("Redirect sem destino.")) {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("redirect segue location e chega no HTML final", async () => {
    const state = defaultState();
    state.siteResponses = [
      () => redirectResponse("http://93.184.216.35/final"),
      () => htmlResponse(defaultHtml()),
    ];
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ url: "http://93.184.216.34/" }));
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
    } finally {
      uninstall();
    }
  });

  await t.step("redirect relativo é resolvido contra a URL absoluta atual", async () => {
    const state = defaultState();
    state.siteResponses = [
      () => redirectResponse("/destino"),
      () => htmlResponse(defaultHtml()),
    ];
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ url: "http://93.184.216.34/origem" }));
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
      if (state.siteUrls[1] !== "http://93.184.216.34/destino") {
        throw new Error(`redirect relativo incorreto: ${JSON.stringify(state.siteUrls)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("redirect relativo sem barra preserva o diretório atual", async () => {
    const state = defaultState();
    state.siteResponses = [
      () => redirectResponse("destino"),
      () => htmlResponse(defaultHtml()),
    ];
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ url: "http://93.184.216.34/pasta/origem" }));
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
      if (state.siteUrls[1] !== "http://93.184.216.34/pasta/destino") {
        throw new Error(`redirect relativo incorreto: ${JSON.stringify(state.siteUrls)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("redirect do domínio raiz para www mantém URL absoluta", async () => {
    const state = defaultState();
    state.siteResponses = [
      () => redirectResponse("https://www.freedomdigitalhub.com.br/"),
      () => htmlResponse(defaultHtml()),
    ];
    const uninstallDns = installDnsMock(["76.76.21.21"], "reject");
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ url: "https://freedomdigitalhub.com.br" }));
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
      if (state.siteUrls[1] !== "https://www.freedomdigitalhub.com.br/") {
        throw new Error(`redirect www incorreto: ${JSON.stringify(state.siteUrls)}`);
      }
    } finally {
      uninstall();
      uninstallDns();
    }
  });

  for (const [nome, pagina, markup, esperado] of [
    ["favicon raiz", "http://93.184.216.34/pasta/pagina", '<link rel="icon" href="/favicon.ico">', "http://93.184.216.34/favicon.ico"],
    ["logo raiz", "http://93.184.216.34/pasta/pagina", '<img class="logo" src="/assets/logo.svg">', "http://93.184.216.34/assets/logo.svg"],
    ["imagem pai", "http://93.184.216.34/pasta/pagina", '<meta property="og:image" content="../images/logo.png">', "http://93.184.216.34/images/logo.png"],
    ["imagem atual", "http://93.184.216.34/pasta/pagina", '<meta name="twitter:image" content="./assets/brand.svg">', "http://93.184.216.34/pasta/assets/brand.svg"],
    ["imagem absoluta", "http://93.184.216.34/pasta/pagina", '<meta property="og:image" content="http://93.184.216.35/logo.png">', "http://93.184.216.35/logo.png"],
    ["imagem protocolo relativo", "http://93.184.216.34/pasta/pagina", '<meta property="og:image" content="//93.184.216.35/logo.png">', "http://93.184.216.35/logo.png"],
  ] as const) {
    await t.step(`asset relativo: ${nome}`, async () => {
      const state = defaultState();
      state.siteResponses = [
        () => htmlResponse(htmlComAsset(markup)),
        () => new Response(null, { status: 200, headers: { "content-type": "image/png" } }),
      ];
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(req({ url: pagina }));
        if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
        if (state.siteUrls[1] !== esperado) {
          throw new Error(`asset incorreto: ${JSON.stringify(state.siteUrls)}`);
        }
      } finally {
        uninstall();
      }
    });
  }

  await t.step("base href redefine a base dos assets relativos", async () => {
    const state = defaultState();
    state.siteResponses = [
      () => htmlResponse(htmlComAsset('<link rel="icon" href="./favicon.ico">', '<base href="/marca/">')),
      () => new Response(null, { status: 200, headers: { "content-type": "image/png" } }),
    ];
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ url: "http://93.184.216.34/pasta/pagina" }));
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
      if (state.siteUrls[1] !== "http://93.184.216.34/marca/favicon.ico") {
        throw new Error(`base href incorreta: ${JSON.stringify(state.siteUrls)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("asset inválido é ignorado e preserva o fallback do HTML", async () => {
    const state = defaultState();
    state.siteResponses = [
      () => htmlResponse(htmlComAsset('<meta property="og:image" content="data:image/png;base64,abc">')),
    ];
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ url: "http://93.184.216.34/" }));
      const body = await res.json();
      if (res.status !== 200 || body.source_hex !== "#3366ff" || state.siteUrls.length !== 1) {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)} ${JSON.stringify(state.siteUrls)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("excesso de redirects falha com 'Redirects demais'", async () => {
    const state = defaultState();
    state.siteResponses = [() => redirectResponse("http://93.184.216.34/loop")];
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ url: "93.184.216.34" }));
      const body = await res.json();
      if (res.status !== 422 || !String(body.error).includes("Redirects demais.")) {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("redirect para esquema não-http(s) é bloqueado no próximo hop", async () => {
    const state = defaultState();
    state.siteResponses = [() => redirectResponse("ftp://evil.example/")];
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ url: "93.184.216.34" }));
      const body = await res.json();
      if (res.status !== 422 || !String(body.error).includes("protocolo não permitido")) {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("site responde status não-ok (404) falha com 'Site respondeu 404'", async () => {
    const state = defaultState();
    state.siteResponses = [() => htmlResponse("not found", { status: 404 })];
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ url: "93.184.216.34" }));
      const body = await res.json();
      if (res.status !== 422 || !String(body.error).includes("Site respondeu 404.")) {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("content-type não-HTML falha com 'A URL não é uma página HTML'", async () => {
    const state = defaultState();
    state.siteResponses = [() => htmlResponse('{"ok":true}', { contentType: "application/json" })];
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ url: "93.184.216.34" }));
      const body = await res.json();
      if (res.status !== 422 || !String(body.error).includes("A URL não é uma página HTML.")) {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("resposta sem corpo falha com 'Resposta vazia'", async () => {
    const state = defaultState();
    state.siteResponses = [
      () => new Response(null, { status: 200, headers: { "content-type": "text/html" } }),
    ];
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ url: "93.184.216.34" }));
      const body = await res.json();
      if (res.status !== 422 || !String(body.error).includes("Resposta vazia.")) {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step(
    "erro não-Error no fetch cai no fallback 'Não foi possível acessar o site'",
    async () => {
      const state = defaultState();
      state.siteResponses = [
        () => {
          throw "falha string, não Error";
        },
      ];
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(req({ url: "93.184.216.34" }));
        const body = await res.json();
        if (
          res.status !== 422 ||
          !String(body.error).includes("Não foi possível acessar o site.")
        ) {
          throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step("HTML grande (> MAX_BYTES) ainda extrai metadados do início", async () => {
    const state = defaultState();
    state.siteResponses = [() => htmlResponse(htmlGrande())];
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ url: "93.184.216.34" }));
      const body = await res.json();
      if (res.status !== 200 || body.site_title !== "Empresa Grande") {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("nenhuma cor de marca encontrada retorna 422 dedicado", async () => {
    const state = defaultState();
    state.siteResponses = [() => htmlResponse(htmlSemCorNenhuma())];
    Deno.env.delete("LOVABLE_API_KEY");
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ url: "93.184.216.34" }));
      const body = await res.json();
      if (
        res.status !== 422 ||
        body.error !==
          "Não encontramos uma cor de marca no site. Você pode definir manualmente depois."
      ) {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
      setEnv({ LOVABLE_API_KEY: "lovable-key" });
    }
  });

  await t.step("fallback usa cor mais frequente quando não há theme-color", async () => {
    const state = defaultState();
    state.siteResponses = [() => htmlResponse(htmlSemCorNoTema())];
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ url: "93.184.216.34" }));
      const body = await res.json();
      if (res.status !== 200 || body.source_hex !== "#22aa44") {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step(
    "theme-color com atributos invertidos (content antes de name) também é lido",
    async () => {
      // Só o theme-color suporta as duas ordens de atributo (`??` com dois regex);
      // title/description só casam na ordem name/property-antes-de-content, então
      // com os atributos invertidos eles ficam null — comportamento real da fonte.
      const state = defaultState();
      state.siteResponses = [() => htmlResponse(htmlAtributosInvertidos())];
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(req({ url: "93.184.216.34" }));
        const body = await res.json();
        if (
          res.status !== 200 ||
          body.source_hex !== "#112233" ||
          body.site_title !== null ||
          body.site_description !== null
        ) {
          throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step("sem nenhuma meta tag, título e descrição saem null", async () => {
    const state = defaultState();
    state.siteResponses = [() => htmlResponse(htmlSemMetaNenhuma())];
    Deno.env.delete("LOVABLE_API_KEY");
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ url: "93.184.216.34" }));
      const body = await res.json();
      if (res.status !== 422) {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
      setEnv({ LOVABLE_API_KEY: "lovable-key" });
    }
  });

  await t.step("theme-color com hex inválido é descartado (normalizeHex)", async () => {
    const state = defaultState();
    state.siteResponses = [() => htmlResponse(htmlHexInvalido())];
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ url: "93.184.216.34" }));
      const body = await res.json();
      // Sem cor no top (não há hex no HTML) e sem IA -> 422.
      if (res.status !== 422) throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
    } finally {
      uninstall();
    }
  });

  await t.step("theme-color com hex de 3 dígitos é normalizado para 6", async () => {
    const state = defaultState();
    state.siteResponses = [() => htmlResponse(htmlHex3Digitos())];
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ url: "93.184.216.34" }));
      const body = await res.json();
      if (res.status !== 200 || body.source_hex !== "#00ff00") {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("descrição maior que 200 chars é truncada", async () => {
    const state = defaultState();
    state.siteResponses = [() => htmlResponse(htmlDescricaoLonga())];
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ url: "93.184.216.34" }));
      const body = await res.json();
      if (res.status !== 200 || body.site_description.length !== 200) {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("descrição via og:description quando não há name=description", async () => {
    const state = defaultState();
    state.siteResponses = [() => htmlResponse(htmlOgDescription())];
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ url: "93.184.216.34" }));
      const body = await res.json();
      if (res.status !== 200 || body.site_description !== "Descricao via og:description.") {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("cor muito escura: várias iterações de clareamento, foreground branco", async () => {
    const state = defaultState();
    state.siteResponses = [() => htmlResponse(htmlCorEscura("#010101"))];
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ url: "93.184.216.34" }));
      const body = await res.json();
      if (res.status !== 200 || body.primary_foreground !== "#ffffff") {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("cor saturada sem necessidade de clareamento, foreground escuro", async () => {
    const state = defaultState();
    state.siteResponses = [() => htmlResponse(htmlCorEscura("#ff0000"))];
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ url: "93.184.216.34" }));
      const body = await res.json();
      if (
        res.status !== 200 ||
        body.primary !== "#ff0000" ||
        body.primary_foreground !== "#05152b"
      ) {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("sem LOVABLE_API_KEY não chama a IA e usa fallback determinístico", async () => {
    const state = defaultState();
    Deno.env.delete("LOVABLE_API_KEY");
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ url: "93.184.216.34" }));
      const body = await res.json();
      if (res.status !== 200 || state.aiCalled) {
        throw new Error(
          `inesperado: ${res.status} aiCalled=${state.aiCalled} ${JSON.stringify(body)}`,
        );
      }
      if (body.source_hex !== "#3366ff") throw new Error(`hex inesperado: ${body.source_hex}`);
    } finally {
      uninstall();
      setEnv({ LOVABLE_API_KEY: "lovable-key" });
    }
  });

  await t.step("IA responde não-ok: usa fallback e ignora corpo", async () => {
    const state = defaultState();
    state.aiStatus = 500;
    state.aiBody = { message: "erro interno" };
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ url: "93.184.216.34" }));
      const body = await res.json();
      if (res.status !== 200 || body.source_hex !== "#3366ff") {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("IA lança exceção de rede: capturada, segue com fallback", async () => {
    const state = defaultState();
    state.aiThrows = true;
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ url: "93.184.216.34" }));
      const body = await res.json();
      if (res.status !== 200 || body.source_hex !== "#3366ff") {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("IA lança valor não-Error: também capturada, segue com fallback", async () => {
    const state = defaultState();
    state.aiThrowsNonError = true;
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ url: "93.184.216.34" }));
      const body = await res.json();
      if (res.status !== 200 || body.source_hex !== "#3366ff") {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("IA retorna conteúdo não-JSON: parse falha, segue com fallback", async () => {
    const state = defaultState();
    state.aiBody = { choices: [{ message: { content: "isso não é json" } }] };
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ url: "93.184.216.34" }));
      const body = await res.json();
      if (res.status !== 200 || body.source_hex !== "#3366ff") {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("IA retorna hex inválido: normalizeHex descarta, segue com fallback", async () => {
    const state = defaultState();
    state.aiBody = {
      choices: [{ message: { content: JSON.stringify({ hex: "não-é-hex", segment: null }) } }],
    };
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ url: "93.184.216.34" }));
      const body = await res.json();
      if (res.status !== 200 || body.source_hex !== "#3366ff") {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("IA escolhe hex explícito: sobrepõe o fallback do tema", async () => {
    const state = defaultState();
    state.aiBody = {
      choices: [
        { message: { content: JSON.stringify({ hex: "#112233", segment: "loja de roupas" }) } },
      ],
    };
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ url: "93.184.216.34" }));
      const body = await res.json();
      if (
        res.status !== 200 ||
        body.source_hex !== "#112233" ||
        body.suggested_segment !== "loja de roupas"
      ) {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("IA em bloco de código markdown (```json) é lida corretamente", async () => {
    const state = defaultState();
    state.aiBody = {
      choices: [
        {
          message: {
            content: '```json\n{"hex":"#556677","segment":"clínica odontológica"}\n```',
          },
        },
      ],
    };
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ url: "93.184.216.34" }));
      const body = await res.json();
      if (
        res.status !== 200 ||
        body.source_hex !== "#556677" ||
        body.suggested_segment !== "clínica odontológica"
      ) {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("segmento vazio/whitespace vira null", async () => {
    const state = defaultState();
    state.aiBody = {
      choices: [{ message: { content: JSON.stringify({ hex: null, segment: "   " }) } }],
    };
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ url: "93.184.216.34" }));
      const body = await res.json();
      if (res.status !== 200 || body.suggested_segment !== null) {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("segmento maior que 80 chars é truncado", async () => {
    const state = defaultState();
    const segmentoLongo = "s".repeat(120);
    state.aiBody = {
      choices: [{ message: { content: JSON.stringify({ hex: null, segment: segmentoLongo }) } }],
    };
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ url: "93.184.216.34" }));
      const body = await res.json();
      if (res.status !== 200 || body.suggested_segment.length !== 80) {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("segmento e hex com tipos inesperados (não-string) viram null", async () => {
    const state = defaultState();
    state.aiBody = {
      choices: [{ message: { content: JSON.stringify({ hex: 123, segment: 456 }) } }],
    };
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ url: "93.184.216.34" }));
      const body = await res.json();
      // hex numérico é descartado -> cai no fallback do tema (#3366ff).
      if (res.status !== 200 || body.source_hex !== "#3366ff" || body.suggested_segment !== null) {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("fallback ANON usa SUPABASE_PUBLISHABLE_KEY quando ANON_KEY ausente", async () => {
    Deno.env.delete("SUPABASE_ANON_KEY");
    setEnv({ SUPABASE_PUBLISHABLE_KEY: "pub-key" });
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(req({ url: "93.184.216.34" }));
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
    } finally {
      uninstall();
      Deno.env.delete("SUPABASE_PUBLISHABLE_KEY");
      setEnv({ SUPABASE_ANON_KEY: BASE_ENV.SUPABASE_ANON_KEY });
    }
  });

  await t.step("caminho feliz: retorna paleta completa e todos os campos esperados", async () => {
    const state = defaultState();
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ url: "http://93.184.216.34/" }));
      const body = await res.json();
      if (
        res.status !== 200 ||
        body.contract_version !== 1 ||
        typeof body.revision !== "string" ||
        typeof body.primary !== "string" ||
        typeof body.primary_foreground !== "string" ||
        typeof body.accent_foreground !== "string" ||
        typeof body.source_hex !== "string" ||
        body.site_title !== "Empresa Teste" ||
        body.site_description !== "Descricao padrao da empresa teste para checagem de extracao."
      ) {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("sucesso inclui diagnóstico com etapas e assets", async () => {
    const state = defaultState();
    state.siteResponses = [
      () => htmlResponse(htmlComAsset('<link rel="icon" href="/favicon.ico">')),
      () => new Response(null, { status: 200, headers: { "content-type": "image/png" } }),
    ];
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ url: "http://93.184.216.34/" }));
      const body = await res.json();
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
      if (!body.diagnostics || !Array.isArray(body.diagnostics.steps)) {
        throw new Error(`sem diagnóstico: ${JSON.stringify(body)}`);
      }
      if (body.diagnostics.steps.length === 0) throw new Error("etapas vazias");
      if (!Array.isArray(body.diagnostics.assets)) throw new Error("assets ausentes");
      const favicon = body.diagnostics.assets.find((a: { role: string }) => a.role === "favicon");
      if (!favicon) throw new Error(`favicon não reportado: ${JSON.stringify(body.diagnostics)}`);
    } finally {
      uninstall();
    }
  });

  await t.step("falha de acesso ao site devolve diagnóstico com etapa falhada", async () => {
    const state = defaultState();
    state.siteResponses = [() => {
      throw new Error("conexão recusada");
    }];
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ url: "http://93.184.216.34/" }));
      const body = await res.json();
      if (res.status !== 422) throw new Error(`esperado 422, veio ${res.status}`);
      if (!body.diagnostics || !Array.isArray(body.diagnostics.steps)) {
        throw new Error(`sem diagnóstico no erro: ${JSON.stringify(body)}`);
      }
      const falhou = body.diagnostics.steps.some(
        (s: { status: string }) => s.status === "falhou",
      );
      if (!falhou) throw new Error(`nenhuma etapa marcada como falhou: ${JSON.stringify(body.diagnostics)}`);
    } finally {
      uninstall();
    }
  });
});

