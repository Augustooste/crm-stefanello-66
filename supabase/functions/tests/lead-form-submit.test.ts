import {
  BASE_ENV,
  captureHandler,
  emptyResponse,
  type FetchMatcher,
  installFetchMock,
  jsonResponse,
  setEnv,
} from "./_helpers.ts";

setEnv(BASE_ENV);

const handler = await captureHandler("../lead-form-submit/index.ts");

interface LeadForm {
  id: string;
  tenant_id: string;
  name: string;
  is_active: boolean;
  success_message: string | null;
  fields: Array<{ key: string; maps_to_custom_field_id?: string | null }>;
}

interface Contact {
  id: string;
  custom_fields: Record<string, unknown>;
}

interface CustomFieldDef {
  id: string;
  key: string;
}

interface Calls {
  rateLimitHead: number;
  contactsGet: number;
  contactsPost: number;
  contactsPatch: number;
  customFieldDefsGet: number;
  submissionsPost: number;
}

interface State {
  form: LeadForm | null;
  recentSubmissionsCount: number;
  existingContact: Contact | null;
  customFieldDefs: CustomFieldDef[];
  newContactId: string;
  submissionInsertStatus: number;
  submissionInsertBody: unknown;
  calls: Calls;
}

function defaultState(): State {
  return {
    form: {
      id: "form-1",
      tenant_id: "tenant-1",
      name: "Contato do site",
      is_active: true,
      success_message: null,
      fields: [],
    },
    recentSubmissionsCount: 0,
    existingContact: null,
    customFieldDefs: [],
    newContactId: "contact-new-1",
    submissionInsertStatus: 201,
    submissionInsertBody: { id: "sub-1" },
    calls: {
      rateLimitHead: 0,
      contactsGet: 0,
      contactsPost: 0,
      contactsPatch: 0,
      customFieldDefsGet: 0,
      submissionsPost: 0,
    },
  };
}

function router(state: State): FetchMatcher {
  return (req) => {
    if (req.pathname === "/rest/v1/lead_forms" && req.method === "GET") {
      return jsonResponse(200, state.form ? [state.form] : []);
    }
    if (req.pathname === "/rest/v1/lead_form_submissions") {
      if (req.method === "HEAD") {
        state.calls.rateLimitHead++;
        return new Response(null, {
          status: 200,
          headers: { "content-range": `*/${state.recentSubmissionsCount}` },
        });
      }
      if (req.method === "POST") {
        state.calls.submissionsPost++;
        return jsonResponse(state.submissionInsertStatus, state.submissionInsertBody);
      }
    }
    if (req.pathname === "/rest/v1/contacts") {
      if (req.method === "GET") {
        state.calls.contactsGet++;
        return jsonResponse(200, state.existingContact ? [state.existingContact] : []);
      }
      if (req.method === "POST") {
        state.calls.contactsPost++;
        return jsonResponse(201, { id: state.newContactId, custom_fields: {} });
      }
      if (req.method === "PATCH") {
        state.calls.contactsPatch++;
        return emptyResponse(200);
      }
    }
    if (req.pathname === "/rest/v1/custom_field_definitions" && req.method === "GET") {
      state.calls.customFieldDefsGet++;
      return jsonResponse(200, state.customFieldDefs);
    }
    return undefined;
  };
}

function req(body?: unknown, opts: { method?: string; xff?: string } = {}): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.xff !== undefined) headers.set("x-forwarded-for", opts.xff);
  return new Request("http://fn.local", {
    method: opts.method ?? "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function run(state: State, body: unknown, opts: { method?: string; xff?: string } = {}) {
  const uninstall = installFetchMock(router(state));
  try {
    const res = await handler(req(body, opts));
    const status = res.status;
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : null;
    return { status, body: parsed };
  } finally {
    uninstall();
  }
}

const validBody = { form_id: "form-1", data: { name: "Maria", phone: "+55 11 91234-5678" } };

// Mesmo valor de RATE_LIMIT_MAX_SUBMISSIONS em ../lead-form-submit/index.ts —
// se aquela constante mudar, este teste precisa ser atualizado.
const RATE_LIMIT_MAX_SUBMISSIONS_FOR_TEST = 3;

Deno.test("lead-form-submit", async (t) => {
  await t.step("OPTIONS responde CORS sem corpo", async () => {
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(req(undefined, { method: "OPTIONS" }));
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
      if (await res.text()) throw new Error("esperado corpo vazio");
      if (res.headers.get("Access-Control-Allow-Origin") !== "*") {
        throw new Error("esperado CORS Allow-Origin: *");
      }
    } finally {
      uninstall();
    }
  });

  await t.step("método não-POST retorna 405", async () => {
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(req(undefined, { method: "GET" }));
      if (res.status !== 405) throw new Error(`esperado 405, veio ${res.status}`);
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
          headers: { "content-type": "application/json" },
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

  await t.step("form_id ausente retorna 400 sem tocar nenhuma tabela", async () => {
    const state = defaultState();
    const { status, body } = await run(state, { data: { name: "Maria" } });
    if (status !== 400 || body.error !== "Formulário é obrigatório.") {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
    if (Object.values(state.calls).some((n) => n > 0)) {
      throw new Error(`esperava nenhuma chamada de tabela, veio ${JSON.stringify(state.calls)}`);
    }
  });

  await t.step("formulário inexistente retorna 404 sem tocar em nenhuma tabela", async () => {
    const state = defaultState();
    state.form = null;
    const { status, body } = await run(state, validBody);
    if (status !== 404 || body.error !== "Formulário não encontrado.") {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
    if (Object.values(state.calls).some((n) => n > 0)) {
      throw new Error(`esperava nenhuma chamada de tabela, veio ${JSON.stringify(state.calls)}`);
    }
  });

  await t.step("formulário inativo retorna 400 com mensagem clara", async () => {
    const state = defaultState();
    state.form = { ...state.form!, is_active: false };
    const { status, body } = await run(state, validBody);
    if (status !== 400 || body.error !== "Este formulário não está mais recebendo submissões.") {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
    if (
      state.calls.rateLimitHead > 0 ||
      state.calls.contactsGet > 0 ||
      state.calls.contactsPost > 0
    ) {
      throw new Error(
        `esperava nenhuma chamada além de lead_forms, veio ${JSON.stringify(state.calls)}`,
      );
    }
  });

  await t.step("rate-limit excedido retorna 429 sem insert em contacts/submissions", async () => {
    const state = defaultState();
    state.recentSubmissionsCount = RATE_LIMIT_MAX_SUBMISSIONS_FOR_TEST;
    const { status, body } = await run(state, validBody, { xff: "203.0.113.5" });
    if (
      status !== 429 ||
      body.error !== "Muitas submissões recebidas. Tente novamente em alguns minutos."
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
    if (
      state.calls.contactsGet > 0 ||
      state.calls.contactsPost > 0 ||
      state.calls.submissionsPost > 0
    ) {
      throw new Error(`esperava nenhum insert, veio ${JSON.stringify(state.calls)}`);
    }
  });

  await t.step("rate-limit abaixo do limite segue o fluxo normalmente", async () => {
    const state = defaultState();
    state.recentSubmissionsCount = RATE_LIMIT_MAX_SUBMISSIONS_FOR_TEST - 1;
    const { status, body } = await run(state, validBody, { xff: "203.0.113.5" });
    if (status !== 200 || body.ok !== true) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step(
    "sem header x-forwarded-for usa source_ip null e ainda assim processa a submissão",
    async () => {
      const state = defaultState();
      const { status, body } = await run(state, validBody);
      if (status !== 200 || body.ok !== true) {
        throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
      }
    },
  );

  await t.step(
    "x-forwarded-for com múltiplos IPs usa apenas o primeiro (IP original do cliente)",
    async () => {
      const state = defaultState();
      const uninstall = installFetchMock((r) => {
        if (r.pathname === "/rest/v1/lead_forms") return jsonResponse(200, [state.form]);
        if (r.pathname === "/rest/v1/lead_form_submissions" && r.method === "HEAD") {
          return new Response(null, { status: 200, headers: { "content-range": "*/0" } });
        }
        if (r.pathname === "/rest/v1/contacts" && r.method === "GET") return jsonResponse(200, []);
        if (r.pathname === "/rest/v1/contacts" && r.method === "POST") {
          return jsonResponse(201, { id: "contact-x", custom_fields: {} });
        }
        if (r.pathname === "/rest/v1/lead_form_submissions" && r.method === "POST") {
          return jsonResponse(201, { id: "sub-x" });
        }
        return undefined;
      });
      try {
        const res = await handler(req(validBody, { xff: "198.51.100.9, 10.0.0.1, 10.0.0.2" }));
        const body = await res.json();
        if (res.status !== 200 || body.ok !== true) {
          throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "contato novo é criado com status='lead' (default da coluna, não setado explicitamente)",
    async () => {
      const state = defaultState();
      let posted: unknown;
      const uninstall = installFetchMock((r) => {
        if (r.pathname === "/rest/v1/lead_forms") return jsonResponse(200, [state.form]);
        if (r.pathname === "/rest/v1/lead_form_submissions" && r.method === "HEAD") {
          return new Response(null, { status: 200, headers: { "content-range": "*/0" } });
        }
        if (r.pathname === "/rest/v1/contacts" && r.method === "GET") return jsonResponse(200, []);
        if (r.pathname === "/rest/v1/contacts" && r.method === "POST") {
          posted = r.bodyJson;
          // Simula o retorno real: mesmo sem o client setar status, a linha
          // volta com o default da coluna ('lead').
          return jsonResponse(201, { id: "contact-novo-1", custom_fields: {}, status: "lead" });
        }
        if (r.pathname === "/rest/v1/lead_form_submissions" && r.method === "POST") {
          return jsonResponse(201, { id: "sub-novo-1" });
        }
        return undefined;
      });
      try {
        const res = await handler(req(validBody));
        const body = await res.json();
        if (res.status !== 200 || body.ok !== true) {
          throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
        }
        const postedBody = posted as { status?: unknown } | undefined;
        if (postedBody && "status" in postedBody) {
          throw new Error(
            `esperava insert sem campo "status" (confia no default da coluna), veio ${
              JSON.stringify(posted)
            }`,
          );
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step("contato existente com mesmo telefone é reaproveitado sem duplicar", async () => {
    const state = defaultState();
    state.existingContact = { id: "contact-existente-1", custom_fields: {} };
    const { status, body } = await run(state, validBody);
    if (status !== 200 || body.ok !== true) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
    if (state.calls.contactsPost !== 0) {
      throw new Error(`esperava 0 inserts de contato (reuso), veio ${state.calls.contactsPost}`);
    }
  });

  await t.step(
    "mapeamento de custom field mescla sem sobrescrever chaves já existentes",
    async () => {
      const state = defaultState();
      state.form = {
        ...state.form!,
        fields: [{ key: "empresa", maps_to_custom_field_id: "def-empresa" }],
      };
      state.customFieldDefs = [{ id: "def-empresa", key: "nome_empresa" }];
      state.existingContact = {
        id: "contact-existente-2",
        custom_fields: {
          outro_campo: "valor previo",
          nome_empresa: "Empresa confirmada pelo atendente",
        },
      };
      let patchedBody: unknown;
      const uninstall = installFetchMock((r) => {
        if (r.pathname === "/rest/v1/lead_forms") return jsonResponse(200, [state.form]);
        if (r.pathname === "/rest/v1/lead_form_submissions" && r.method === "HEAD") {
          return new Response(null, { status: 200, headers: { "content-range": "*/0" } });
        }
        if (r.pathname === "/rest/v1/contacts" && r.method === "GET") {
          return jsonResponse(200, [state.existingContact]);
        }
        if (r.pathname === "/rest/v1/custom_field_definitions") {
          return jsonResponse(200, state.customFieldDefs);
        }
        if (r.pathname === "/rest/v1/contacts" && r.method === "PATCH") {
          patchedBody = r.bodyJson;
          return emptyResponse(200);
        }
        if (r.pathname === "/rest/v1/lead_form_submissions" && r.method === "POST") {
          return jsonResponse(201, { id: "sub-cf" });
        }
        return undefined;
      });
      try {
        const res = await handler(
          req({ form_id: "form-1", data: { phone: "+55 11 91234-5678", empresa: "Acme Ltda" } }),
        );
        const body = await res.json();
        if (res.status !== 200 || body.ok !== true) {
          throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
        }
        const patched = patchedBody as { custom_fields?: Record<string, unknown> } | undefined;
        if (!patched?.custom_fields) throw new Error("esperava PATCH com custom_fields");
        if (patched.custom_fields.outro_campo !== "valor previo") {
          throw new Error(
            `esperava preservar outro_campo, veio ${JSON.stringify(patched.custom_fields)}`,
          );
        }
        if (patched.custom_fields.nome_empresa !== "Empresa confirmada pelo atendente") {
          throw new Error(
            `submissão anônima sobrescreveu nome_empresa existente: ${
              JSON.stringify(
                patched.custom_fields,
              )
            }`,
          );
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "campo do form sem maps_to_custom_field_id não gera PATCH de custom_fields",
    async () => {
      const state = defaultState();
      state.form = { ...state.form!, fields: [{ key: "mensagem" }] };
      const { status, body } = await run(state, {
        form_id: "form-1",
        data: { phone: "+55 11 90000-0000", mensagem: "Olá" },
      });
      if (status !== 200 || body.ok !== true) {
        throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
      }
      if (state.calls.contactsPatch !== 0) {
        throw new Error(`esperava 0 PATCH, veio ${state.calls.contactsPatch}`);
      }
    },
  );

  await t.step(
    "erro do trigger de validação (RAISE EXCEPTION) retorna 400 com mensagem limpa, sem vazar erro cru",
    async () => {
      const state = defaultState();
      state.submissionInsertStatus = 400;
      state.submissionInsertBody = {
        code: "P0001",
        message: "Formulário indisponível.",
        details: null,
        hint: null,
      };
      const { status, body } = await run(state, validBody);
      if (
        status !== 400 ||
        body.error !== "Não foi possível registrar sua submissão. Tente novamente em instantes."
      ) {
        throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
      }
      // Garante que o corpo cru do Postgres (code/details/hint) não vaza.
      if ("code" in body || "details" in body || "hint" in body) {
        throw new Error(`vazou corpo cru do Postgres: ${JSON.stringify(body)}`);
      }
    },
  );

  await t.step(
    "tenant_id forjado no corpo é ignorado — nunca chega no insert de contacts/submissions",
    async () => {
      const state = defaultState();
      let contactPosted: unknown;
      let submissionPosted: unknown;
      const uninstall = installFetchMock((r) => {
        if (r.pathname === "/rest/v1/lead_forms") return jsonResponse(200, [state.form]);
        if (r.pathname === "/rest/v1/lead_form_submissions" && r.method === "HEAD") {
          return new Response(null, { status: 200, headers: { "content-range": "*/0" } });
        }
        if (r.pathname === "/rest/v1/contacts" && r.method === "GET") return jsonResponse(200, []);
        if (r.pathname === "/rest/v1/contacts" && r.method === "POST") {
          contactPosted = r.bodyJson;
          return jsonResponse(201, { id: "contact-tenant-forge", custom_fields: {} });
        }
        if (r.pathname === "/rest/v1/lead_form_submissions" && r.method === "POST") {
          submissionPosted = r.bodyJson;
          return jsonResponse(201, { id: "sub-tenant-forge" });
        }
        return undefined;
      });
      try {
        const res = await handler(
          req({
            form_id: "form-1",
            tenant_id: "evil-tenant",
            data: { name: "Atacante", phone: "+55 11 90000-1111" },
          }),
        );
        const body = await res.json();
        if (res.status !== 200 || body.ok !== true) {
          throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
        }
        const contactBody = contactPosted as { tenant_id?: unknown } | undefined;
        if (contactBody?.tenant_id !== state.form!.tenant_id) {
          throw new Error(
            `esperava tenant_id do form (${state.form!.tenant_id}), veio ${
              JSON.stringify(contactPosted)
            }`,
          );
        }
        const submissionBody = submissionPosted as Record<string, unknown> | undefined;
        if (submissionBody && "tenant_id" in submissionBody) {
          throw new Error(
            `esperava insert de submissão SEM campo tenant_id (deixado para o trigger), veio ${
              JSON.stringify(submissionPosted)
            }`,
          );
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step("falha ao criar contato retorna 500 com mensagem clara", async () => {
    const state = defaultState();
    const uninstall = installFetchMock((r) => {
      if (r.pathname === "/rest/v1/lead_forms") return jsonResponse(200, [state.form]);
      if (r.pathname === "/rest/v1/lead_form_submissions" && r.method === "HEAD") {
        return new Response(null, { status: 200, headers: { "content-range": "*/0" } });
      }
      if (r.pathname === "/rest/v1/contacts" && r.method === "GET") return jsonResponse(200, []);
      if (r.pathname === "/rest/v1/contacts" && r.method === "POST") {
        return jsonResponse(500, { message: "insert failed" });
      }
      return undefined;
    });
    try {
      const res = await handler(req(validBody));
      const body = await res.json();
      if (
        res.status !== 500 ||
        body.error !== "Não foi possível registrar seu contato. Tente novamente."
      ) {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("usa success_message do formulário quando configurado", async () => {
    const state = defaultState();
    state.form = { ...state.form!, success_message: "Valeu! Já recebemos seu contato." };
    const { status, body } = await run(state, validBody);
    if (status !== 200 || body.message !== "Valeu! Já recebemos seu contato.") {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("sem success_message configurado usa mensagem padrão", async () => {
    const state = defaultState();
    const { status, body } = await run(state, validBody);
    if (
      status !== 200 ||
      body.message !== "Recebemos sua mensagem! Em breve entraremos em contato."
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("dados sem phone/email ainda cria contato (sem dedup possível)", async () => {
    const state = defaultState();
    const { status, body } = await run(state, { form_id: "form-1", data: { name: "Só nome" } });
    if (status !== 200 || body.ok !== true) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
    if (state.calls.contactsGet !== 0) {
      throw new Error(
        `esperava 0 busca de dedup (sem phone/email), veio ${state.calls.contactsGet}`,
      );
    }
    if (state.calls.contactsPost !== 1) {
      throw new Error(`esperava 1 insert de contato, veio ${state.calls.contactsPost}`);
    }
  });

  await t.step(
    "erro de infra ao buscar lead_form retorna 500 genérico sem tocar outras tabelas",
    async () => {
      const uninstall = installFetchMock((r) => {
        if (r.pathname === "/rest/v1/lead_forms") {
          return jsonResponse(500, { message: "connection reset", code: "XX000" });
        }
        return undefined;
      });
      try {
        const res = await handler(req(validBody));
        const body = await res.json();
        if (
          res.status !== 500 ||
          body.error !== "Não foi possível registrar sua submissão. Tente novamente em instantes."
        ) {
          throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "erro de infra no rate-limit falha fechado (503) sem seguir para contacts/submissões",
    async () => {
      const state = defaultState();
      const telemetria: Record<string, unknown>[] = [];
      const uninstall = installFetchMock((r) => {
        if (r.pathname === "/rest/v1/lead_forms") return jsonResponse(200, [state.form]);
        if (r.pathname === "/rest/v1/lead_form_submissions" && r.method === "HEAD") {
          state.calls.rateLimitHead++;
          return jsonResponse(500, { message: "statement timeout", code: "57014" });
        }
        // system_events precisa ser tratado ANTES do catch-all: o catch-all
        // abaixo incrementa contactsGet para QUALQUER rota não casada, então
        // o INSERT de telemetria seria contado como "consulta a contacts" e
        // reprovaria a asserção por um motivo que não é o testado.
        if (r.pathname === "/rest/v1/system_events" && r.method === "POST") {
          telemetria.push((r.bodyJson ?? {}) as Record<string, unknown>);
          return jsonResponse(201, {});
        }
        state.calls.contactsGet++;
        return undefined;
      });
      try {
        const res = await handler(req(validBody));
        const body = await res.json();
        if (
          res.status !== 503 ||
          body.error !== "Não foi possível registrar sua submissão. Tente novamente em instantes."
        ) {
          throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
        }
        if (state.calls.contactsGet > 0) {
          throw new Error("esperava nenhuma consulta a contacts após falha do rate-limit");
        }
        // Fail-closed silencioso é o pior dos dois mundos: o lead é recusado
        // E ninguém descobre que o rate-limit está quebrado. O 503 só é
        // defensável porque deixa rastro.
        if (telemetria.length !== 1) {
          throw new Error(
            `esperado exatamente 1 evento em system_events, veio ${telemetria.length}`,
          );
        }
        if (telemetria[0].operation !== "lead.form_submit.rate_limit_check") {
          throw new Error(`operation inesperada: ${JSON.stringify(telemetria[0])}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step("rate-limit inclui telefone e e-mail no filtro OR (não é só por IP)", async () => {
    const state = defaultState();
    let rateLimitUrl: string | undefined;
    const uninstall = installFetchMock((r) => {
      if (r.pathname === "/rest/v1/lead_forms") return jsonResponse(200, [state.form]);
      if (r.pathname === "/rest/v1/lead_form_submissions" && r.method === "HEAD") {
        // Duas chamadas HEAD acontecem: rate-limit com .or() (primeira) e
        // backstop global sem .or() (segunda). Capturamos SÓ a primeira.
        if (!rateLimitUrl) rateLimitUrl = r.url;
        return new Response(null, { status: 200, headers: { "content-range": "*/0" } });
      }
      if (r.pathname === "/rest/v1/contacts" && r.method === "GET") return jsonResponse(200, []);
      if (r.pathname === "/rest/v1/contacts" && r.method === "POST") {
        return jsonResponse(201, { id: "contact-ratelimit-or", custom_fields: {} });
      }
      if (r.pathname === "/rest/v1/lead_form_submissions" && r.method === "POST") {
        return jsonResponse(201, { id: "sub-ratelimit-or" });
      }
      return undefined;
    });
    try {
      const res = await handler(
        req({
          form_id: "form-1",
          data: { name: "Teste", phone: "+55 11 91234-5678", email: "lead@x.com" },
        }),
      );
      const body = await res.json();
      if (res.status !== 200 || body.ok !== true) {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
      if (!rateLimitUrl) throw new Error("esperava chamada de rate-limit");
      const orParam = new URL(rateLimitUrl).searchParams.get("or");
      if (!orParam?.includes('data->>phone.eq."+5511912345678"')) {
        throw new Error(`esperava filtro por telefone no OR, veio: ${orParam}`);
      }
      if (!orParam?.includes('data->>email.ilike."lead@x.com"')) {
        throw new Error(`esperava filtro por e-mail no OR, veio: ${orParam}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step(
    "erro de infra ao buscar contato por telefone aborta com 500 (não segue pra criação)",
    async () => {
      const state = defaultState();
      const uninstall = installFetchMock((r) => {
        if (r.pathname === "/rest/v1/lead_forms") return jsonResponse(200, [state.form]);
        if (r.pathname === "/rest/v1/lead_form_submissions" && r.method === "HEAD") {
          return new Response(null, { status: 200, headers: { "content-range": "*/0" } });
        }
        if (r.pathname === "/rest/v1/contacts" && r.method === "GET") {
          state.calls.contactsGet++;
          return jsonResponse(500, { message: "connection reset", code: "XX000" });
        }
        if (r.pathname === "/rest/v1/contacts" && r.method === "POST") {
          state.calls.contactsPost++;
          return jsonResponse(201, { id: "contact-x", custom_fields: {} });
        }
        return undefined;
      });
      try {
        const res = await handler(req(validBody));
        const body = await res.json();
        if (
          res.status !== 500 ||
          body.error !== "Não foi possível registrar sua submissão. Tente novamente em instantes."
        ) {
          throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
        }
        if (state.calls.contactsPost > 0) {
          throw new Error("esperava nenhuma criação de contato após falha no dedup por telefone");
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "erro de infra ao buscar contato por e-mail aborta com 500 quando telefone não bate",
    async () => {
      const state = defaultState();
      const uninstall = installFetchMock((r) => {
        if (r.pathname === "/rest/v1/lead_forms") return jsonResponse(200, [state.form]);
        if (r.pathname === "/rest/v1/lead_form_submissions" && r.method === "HEAD") {
          return new Response(null, { status: 200, headers: { "content-range": "*/0" } });
        }
        if (r.pathname === "/rest/v1/contacts" && r.method === "GET") {
          state.calls.contactsGet++;
          // 1ª chamada = busca por telefone (sem match); 2ª = busca por e-mail (falha).
          if (state.calls.contactsGet === 1) return jsonResponse(200, []);
          return jsonResponse(500, { message: "connection reset", code: "XX000" });
        }
        if (r.pathname === "/rest/v1/contacts" && r.method === "POST") {
          state.calls.contactsPost++;
          return jsonResponse(201, { id: "contact-x", custom_fields: {} });
        }
        return undefined;
      });
      try {
        const res = await handler(
          req({
            form_id: "form-1",
            data: { name: "Maria", phone: "+55 11 90000-0000", email: "maria@x.com" },
          }),
        );
        const body = await res.json();
        if (
          res.status !== 500 ||
          body.error !== "Não foi possível registrar sua submissão. Tente novamente em instantes."
        ) {
          throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
        }
        if (state.calls.contactsPost > 0) {
          throw new Error("esperava nenhuma criação de contato após falha no dedup por e-mail");
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "dedup por e-mail escapa curingas ILIKE (%) — não gruda em contato aleatório do tenant",
    async () => {
      const state = defaultState();
      let contactsGetUrl: string | undefined;
      const uninstall = installFetchMock((r) => {
        if (r.pathname === "/rest/v1/lead_forms") return jsonResponse(200, [state.form]);
        if (r.pathname === "/rest/v1/lead_form_submissions" && r.method === "HEAD") {
          return new Response(null, { status: 200, headers: { "content-range": "*/0" } });
        }
        if (r.pathname === "/rest/v1/contacts" && r.method === "GET") {
          contactsGetUrl = r.url;
          // Nenhum contato bate — é o comportamento esperado, já que "%" cru
          // (sem escape) casaria com qualquer e-mail do tenant.
          return jsonResponse(200, []);
        }
        if (r.pathname === "/rest/v1/contacts" && r.method === "POST") {
          return jsonResponse(201, { id: "contact-wildcard", custom_fields: {} });
        }
        if (r.pathname === "/rest/v1/lead_form_submissions" && r.method === "POST") {
          return jsonResponse(201, { id: "sub-wildcard" });
        }
        return undefined;
      });
      try {
        // E-mail em formato válido, mas com curinga no meio: passa pela
        // validação de formato e ainda assim precisa chegar escapado no ILIKE.
        const res = await handler(
          req({ form_id: "form-1", data: { name: "Teste", email: "a%b@example.com" } }),
        );
        const body = await res.json();
        if (res.status !== 200 || body.ok !== true) {
          throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
        }
        if (!contactsGetUrl) throw new Error("esperava busca de dedup por e-mail");
        const filterValue = new URL(contactsGetUrl).searchParams.get("email");
        if (filterValue !== "ilike.a\\%b@example.com") {
          throw new Error(
            `esperava filtro ilike com % escapado ("ilike.a\\\\%b@example.com"), veio: ${filterValue}`,
          );
        }

      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "erro ao mesclar custom_fields não falha a resposta — lead já capturado, só loga",
    async () => {
      const state = defaultState();
      state.form = {
        ...state.form!,
        fields: [{ key: "empresa", maps_to_custom_field_id: "def-empresa" }],
      };
      state.customFieldDefs = [{ id: "def-empresa", key: "nome_empresa" }];
      state.existingContact = { id: "contact-patch-fail", custom_fields: {} };
      const uninstall = installFetchMock((r) => {
        if (r.pathname === "/rest/v1/lead_forms") return jsonResponse(200, [state.form]);
        if (r.pathname === "/rest/v1/lead_form_submissions" && r.method === "HEAD") {
          return new Response(null, { status: 200, headers: { "content-range": "*/0" } });
        }
        if (r.pathname === "/rest/v1/contacts" && r.method === "GET") {
          return jsonResponse(200, [state.existingContact]);
        }
        if (r.pathname === "/rest/v1/custom_field_definitions") {
          return jsonResponse(200, state.customFieldDefs);
        }
        if (r.pathname === "/rest/v1/contacts" && r.method === "PATCH") {
          state.calls.contactsPatch++;
          return jsonResponse(500, { message: "connection reset", code: "XX000" });
        }
        if (r.pathname === "/rest/v1/lead_form_submissions" && r.method === "POST") {
          return jsonResponse(201, { id: "sub-patch-fail" });
        }
        return undefined;
      });
      try {
        const res = await handler(
          req({ form_id: "form-1", data: { phone: "+55 11 91234-5678", empresa: "Acme Ltda" } }),
        );
        const body = await res.json();
        if (res.status !== 200 || body.ok !== true) {
          throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
        }
        if (state.calls.contactsPatch !== 1) {
          throw new Error(`esperava 1 tentativa de PATCH, veio ${state.calls.contactsPatch}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "erro ao buscar custom_field_definitions é logado mas não falha a submissão",
    async () => {
      const state = defaultState();
      state.form = {
        ...state.form!,
        fields: [{ key: "empresa", maps_to_custom_field_id: "def-empresa" }],
      };
      const uninstall = installFetchMock((r) => {
        if (r.pathname === "/rest/v1/lead_forms") return jsonResponse(200, [state.form]);
        if (r.pathname === "/rest/v1/lead_form_submissions" && r.method === "HEAD") {
          return new Response(null, { status: 200, headers: { "content-range": "*/0" } });
        }
        if (r.pathname === "/rest/v1/contacts" && r.method === "GET") return jsonResponse(200, []);
        if (r.pathname === "/rest/v1/custom_field_definitions") {
          return jsonResponse(500, { message: "connection reset", code: "XX000" });
        }
        if (r.pathname === "/rest/v1/contacts" && r.method === "POST") {
          return jsonResponse(201, { id: "contact-defs-fail", custom_fields: {} });
        }
        if (r.pathname === "/rest/v1/contacts" && r.method === "PATCH") {
          state.calls.contactsPatch++;
          return emptyResponse(200);
        }
        if (r.pathname === "/rest/v1/lead_form_submissions" && r.method === "POST") {
          return jsonResponse(201, { id: "sub-defs-fail" });
        }
        return undefined;
      });
      try {
        const res = await handler(
          req({ form_id: "form-1", data: { phone: "+55 11 90000-2222", empresa: "Acme Ltda" } }),
        );
        const resBody = await res.json();
        if (res.status !== 200 || resBody.ok !== true) {
          throw new Error(`inesperado: ${res.status} ${JSON.stringify(resBody)}`);
        }
        if (state.calls.contactsPatch !== 0) {
          throw new Error(
            `esperava 0 PATCH (sem defs, nenhum campo mapeado), veio ${state.calls.contactsPatch}`,
          );
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step("nome ausente usa fallback e não quebra (contacts.name é not null)", async () => {
    const state = defaultState();
    let posted: unknown;
    const uninstall = installFetchMock((r) => {
      if (r.pathname === "/rest/v1/lead_forms") return jsonResponse(200, [state.form]);
      if (r.pathname === "/rest/v1/lead_form_submissions" && r.method === "HEAD") {
        return new Response(null, { status: 200, headers: { "content-range": "*/0" } });
      }
      if (r.pathname === "/rest/v1/contacts" && r.method === "GET") return jsonResponse(200, []);
      if (r.pathname === "/rest/v1/contacts" && r.method === "POST") {
        posted = r.bodyJson;
        return jsonResponse(201, { id: "contact-sem-nome", custom_fields: {} });
      }
      if (r.pathname === "/rest/v1/lead_form_submissions" && r.method === "POST") {
        return jsonResponse(201, { id: "sub-sem-nome" });
      }
      return undefined;
    });
    try {
      const res = await handler(req({ form_id: "form-1", data: { email: "lead@x.com" } }));
      const body = await res.json();
      if (res.status !== 200 || body.ok !== true) {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
      const postedBody = posted as { name?: unknown } | undefined;
      if (!postedBody?.name || typeof postedBody.name !== "string" || !postedBody.name.trim()) {
        throw new Error(`esperava name não-vazio no insert, veio ${JSON.stringify(posted)}`);
      }
    } finally {
      uninstall();
    }
  });
});
