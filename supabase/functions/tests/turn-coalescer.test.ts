// Testa supabase/functions/_shared/ai/turn-coalescer.ts: claim/release
// atômico do lock de IA em "conversations" e coalescing de burst via
// "messages". Mock stateful de /rest/v1/conversations simula a semântica
// condicional real do UPDATE (test-and-set em ai_lock_until / ai_lock_token)
// pra validar de fato "ganha quando livre" / "perde quando ocupado" / "só
// libera com token correto" — não apenas que a request foi feita.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import {
  BASE_ENV,
  emptyResponse,
  type FetchMatcher,
  installFetchMock,
  jsonResponse,
  setEnv,
} from "./_helpers.ts";
import {
  claimAITurn,
  coalesceTurn,
  releaseAITurn,
  wasAlreadyAnswered,
} from "../_shared/ai/turn-coalescer.ts";

setEnv(BASE_ENV);

const CONV_ID = "conv-1";

function newAdminClient() {
  return createClient(BASE_ENV.SUPABASE_URL, BASE_ENV.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Extrai o threshold ISO de `ai_lock_until.lt.<iso>` dentro do param `or`. */
function extractLockThreshold(orParam: string): string | null {
  const match = orParam.match(/ai_lock_until\.lt\.([^,)]+)/);
  return match ? match[1] : null;
}

interface ConversationLockState {
  lockToken: string | null;
  lockUntil: string | null;
}

/** Mock stateful de /rest/v1/conversations — só essa rota; demais caem undefined. */
function conversationsLockRouter(state: ConversationLockState): FetchMatcher {
  return (req) => {
    const u = new URL(req.url);
    if (u.pathname !== "/rest/v1/conversations" || req.method !== "PATCH") return undefined;
    const sp = u.searchParams;
    const body = req.bodyJson as { ai_lock_token: string | null; ai_lock_until: string | null };

    const orParam = sp.get("or");
    if (orParam) {
      // Caminho de claim: UPDATE ... WHERE ai_lock_until IS NULL OR ai_lock_until < now.
      const threshold = extractLockThreshold(orParam);
      const matches = state.lockUntil === null ||
        (threshold !== null && new Date(state.lockUntil).getTime() < new Date(threshold).getTime());
      if (!matches) {
        // .single() sem linha afetada => PGRST116 (comportamento real do PostgREST).
        return jsonResponse(406, { code: "PGRST116", message: "0 rows" });
      }
      state.lockToken = body.ai_lock_token;
      state.lockUntil = body.ai_lock_until;
      return jsonResponse(200, { ai_lock_token: state.lockToken });
    }

    const tokenFilter = sp.get("ai_lock_token"); // "eq.<token>" quando release passa token
    if (tokenFilter) {
      const expected = tokenFilter.replace(/^eq\./, "");
      if (state.lockToken !== expected) {
        // Postgres real: 0 linhas afetadas, mas sem .select() a resposta é
        // 200 vazia mesmo assim (return=minimal) — não lança erro.
        return emptyResponse(200);
      }
    }
    state.lockToken = null;
    state.lockUntil = null;
    return emptyResponse(200);
  };
}

Deno.test("claimAITurn", async (t) => {
  await t.step("ganha o lock quando está livre (ai_lock_until null)", async () => {
    const state: ConversationLockState = { lockToken: null, lockUntil: null };
    const uninstall = installFetchMock(conversationsLockRouter(state));
    try {
      const result = await claimAITurn(newAdminClient(), {
        conversationId: CONV_ID,
        now: () => new Date("2026-01-01T00:00:00.000Z"),
        generateToken: () => "token-abc",
      });
      // Nota: checagem combinada (não em dois `if` narrowing separados) —
      // dois ifs sucessivos que narrowam `result.claimed` em t.steps
      // irmãos do mesmo Deno.test colidem no checker do TS/Deno aqui
      // (verificado empiricamente: "Property 'token' does not exist on
      // type 'never'" no segundo step). Sem narrowing intermediário evita o bug.
      if (!result.claimed || result.token !== "token-abc") {
        throw new Error(`esperava claimed=true token=token-abc, veio ${JSON.stringify(result)}`);
      }
      if (state.lockToken !== "token-abc") throw new Error("mock não gravou o novo token");
    } finally {
      uninstall();
    }
  });

  await t.step("perde o lock quando ocupado e ainda não expirado", async () => {
    const state: ConversationLockState = {
      lockToken: "existing-token",
      lockUntil: "2026-01-01T00:10:00.000Z", // expira depois do "now" abaixo
    };
    const uninstall = installFetchMock(conversationsLockRouter(state));
    try {
      const result = await claimAITurn(newAdminClient(), {
        conversationId: CONV_ID,
        now: () => new Date("2026-01-01T00:00:00.000Z"),
        generateToken: () => "token-new",
      });
      if (result.claimed || result.token !== null) {
        throw new Error(`esperava claimed=false token=null, veio ${JSON.stringify(result)}`);
      }
      // Lock de outro processo não pode ter sido sobrescrito.
      if (state.lockToken !== "existing-token") {
        throw new Error("claim perdido não deveria alterar o lock");
      }
    } finally {
      uninstall();
    }
  });

  await t.step(
    "fail-closed: erro de infra (não PGRST116) não é tratado como claim perdido",
    async () => {
      // Simula erro genérico de conexão/DB, distinto do 406 PGRST116 de "0 rows"
      // — claimAITurn deve devolver claimed=false sem lançar, mas sem tratar
      // como se fosse disputa de lock normal.
      const router: FetchMatcher = (req) => {
        const u = new URL(req.url);
        if (u.pathname !== "/rest/v1/conversations" || req.method !== "PATCH") return undefined;
        return jsonResponse(500, { code: "57014", message: "connection reset by peer" });
      };
      const uninstall = installFetchMock(router);
      try {
        const result = await claimAITurn(newAdminClient(), {
          conversationId: CONV_ID,
          now: () => new Date("2026-01-01T00:00:00.000Z"),
          generateToken: () => "token-x",
        });
        if (result.claimed || result.token !== null) {
          throw new Error(`esperava claimed=false token=null, veio ${JSON.stringify(result)}`);
        }
      } finally {
        uninstall();
      }
    },
  );
});

Deno.test("releaseAITurn", async (t) => {
  await t.step("libera quando o token bate", async () => {
    const state: ConversationLockState = {
      lockToken: "abc",
      lockUntil: "2026-01-01T00:10:00.000Z",
    };
    const uninstall = installFetchMock(conversationsLockRouter(state));
    try {
      await releaseAITurn(newAdminClient(), { conversationId: CONV_ID, token: "abc" });
      if (state.lockToken !== null) throw new Error(`lockToken=${state.lockToken}, esperava null`);
      if (state.lockUntil !== null) throw new Error(`lockUntil=${state.lockUntil}, esperava null`);
    } finally {
      uninstall();
    }
  });

  await t.step("NÃO libera quando o token não bate", async () => {
    const state: ConversationLockState = {
      lockToken: "abc",
      lockUntil: "2026-01-01T00:10:00.000Z",
    };
    const uninstall = installFetchMock(conversationsLockRouter(state));
    try {
      await releaseAITurn(newAdminClient(), { conversationId: CONV_ID, token: "wrong-token" });
      if (state.lockToken !== "abc") {
        throw new Error(`lockToken=${state.lockToken}, esperava permanecer "abc"`);
      }
      if (state.lockUntil === null) throw new Error("lockUntil não deveria ter sido limpo");
    } finally {
      uninstall();
    }
  });
});

/** Mock de /rest/v1/messages só pra guarda de dedupe (sender=eq.ai&direction=eq.out). */
function dedupeRouter(rows: Array<{ id: string; created_at: string }>): FetchMatcher {
  return (req) => {
    const u = new URL(req.url);
    if (u.pathname !== "/rest/v1/messages" || req.method !== "GET") return undefined;
    if (u.searchParams.get("sender") !== "eq.ai") return undefined;
    return jsonResponse(200, rows);
  };
}

Deno.test("wasAlreadyAnswered", async (t) => {
  await t.step("sem resposta prévia da IA -> false", async () => {
    const uninstall = installFetchMock(dedupeRouter([]));
    try {
      const result = await wasAlreadyAnswered(newAdminClient(), { conversationId: CONV_ID });
      if (result !== false) throw new Error(`esperava false, veio ${result}`);
    } finally {
      uninstall();
    }
  });

  await t.step(
    "com resposta prévia e sem messageCreatedAt -> true (compat sem guard)",
    async () => {
      const uninstall = installFetchMock(
        dedupeRouter([{ id: "ai-1", created_at: "2026-01-01T00:00:05.000Z" }]),
      );
      try {
        const result = await wasAlreadyAnswered(newAdminClient(), { conversationId: CONV_ID });
        if (result !== true) throw new Error(`esperava true, veio ${result}`);
      } finally {
        uninstall();
      }
    },
  );

  await t.step("resposta POSTERIOR à mensagem atual -> true (bloqueia)", async () => {
    const uninstall = installFetchMock(
      dedupeRouter([{ id: "ai-1", created_at: "2026-01-01T00:00:09.000Z" }]),
    );
    try {
      const result = await wasAlreadyAnswered(newAdminClient(), {
        conversationId: CONV_ID,
        messageCreatedAt: "2026-01-01T00:00:06.000Z",
      });
      if (result !== true) throw new Error(`esperava true (bloqueia), veio ${result}`);
    } finally {
      uninstall();
    }
  });

  await t.step("resposta ANTERIOR à mensagem atual -> false (turno órfão legítimo)", async () => {
    const uninstall = installFetchMock(
      dedupeRouter([{ id: "ai-1", created_at: "2026-01-01T00:00:06.000Z" }]),
    );
    try {
      const result = await wasAlreadyAnswered(newAdminClient(), {
        conversationId: CONV_ID,
        messageCreatedAt: "2026-01-01T00:00:09.000Z",
      });
      if (result !== false) throw new Error(`esperava false (não bloqueia), veio ${result}`);
    } finally {
      uninstall();
    }
  });
});

Deno.test("coalesceTurn", async (t) => {
  await t.step("burst de 2 mensagens em <1s: só a mais recente prossegue (coalesce)", async () => {
    const LATEST_ID = "msg-2";
    const OLDER_ID = "msg-1";
    const now = new Date("2026-01-01T00:00:00.000Z");
    let inboundCallCount = 0;
    const sleepCalls: number[] = [];

    const router: FetchMatcher = (req) => {
      const u = new URL(req.url);
      if (u.pathname !== "/rest/v1/messages" || req.method !== "GET") return undefined;
      const sp = u.searchParams;

      // Guarda de dedupe (wasAlreadyAnswered): sender=eq.ai&direction=eq.out.
      if (sp.get("sender") === "eq.ai") {
        return jsonResponse(200, []); // nenhuma resposta prévia da IA
      }

      // fetchRecentInbound: direction=eq.in.
      if (sp.get("direction") === "eq.in") {
        inboundCallCount++;
        if (inboundCallCount === 1) {
          // Fetch inicial: burst — 2 mensagens em rajada, chegaram em <1s.
          return jsonResponse(200, [
            { id: LATEST_ID, created_at: "2026-01-01T00:00:00.800Z" },
            { id: OLDER_ID, created_at: "2026-01-01T00:00:00.100Z" },
          ]);
        }
        // Re-fetch pós-sleep: mesma rajada, mais recente ainda é LATEST_ID.
        return jsonResponse(200, [
          { id: LATEST_ID, created_at: "2026-01-01T00:00:00.800Z" },
          { id: OLDER_ID, created_at: "2026-01-01T00:00:00.100Z" },
        ]);
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const decision = await coalesceTurn(newAdminClient(), {
        conversationId: CONV_ID,
        messageId: LATEST_ID,
        messageCreatedAt: "2026-01-01T00:00:00.800Z",
        now: () => now,
        sleep: (ms) => {
          sleepCalls.push(ms);
          return Promise.resolve(); // sem espera real no teste
        },
      });
      if (!decision.proceed) {
        throw new Error(`esperava proceed=true, veio ${JSON.stringify(decision)}`);
      }
      if (inboundCallCount !== 2) {
        throw new Error(`esperava 2 fetches (burst), veio ${inboundCallCount}`);
      }
      if (sleepCalls.length !== 1) {
        throw new Error(`esperava 1 sleep (janela de coalescing), veio ${sleepCalls.length}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("mensagem mais antiga da rajada não prossegue (not_latest)", async () => {
    const LATEST_ID = "msg-2";
    const OLDER_ID = "msg-1";
    const now = new Date("2026-01-01T00:00:00.000Z");

    const router: FetchMatcher = (req) => {
      const u = new URL(req.url);
      if (u.pathname !== "/rest/v1/messages" || req.method !== "GET") return undefined;
      const sp = u.searchParams;
      if (sp.get("sender") === "eq.ai") return jsonResponse(200, []);
      if (sp.get("direction") === "eq.in") {
        return jsonResponse(200, [
          { id: LATEST_ID, created_at: "2026-01-01T00:00:00.800Z" },
          { id: OLDER_ID, created_at: "2026-01-01T00:00:00.100Z" },
        ]);
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const decision = await coalesceTurn(newAdminClient(), {
        conversationId: CONV_ID,
        messageId: OLDER_ID, // esta invocação é da mensagem mais antiga da rajada
        now: () => now,
        sleep: () => Promise.resolve(),
      });
      if (decision.proceed) {
        throw new Error(`esperava proceed=false, veio ${JSON.stringify(decision)}`);
      }
      if (decision.reason !== "not_latest") throw new Error(`reason=${decision.reason}`);
      if (decision.reason === "not_latest" && decision.latestMessageId !== LATEST_ID) {
        throw new Error(`latestMessageId=${decision.latestMessageId}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("solo (sem burst): segue sem sleep, reason=no_burst", async () => {
    const MSG_ID = "msg-solo";
    const now = new Date("2026-01-01T00:00:00.000Z");
    let inboundCallCount = 0;
    const sleepCalls: number[] = [];

    const router: FetchMatcher = (req) => {
      const u = new URL(req.url);
      if (u.pathname !== "/rest/v1/messages" || req.method !== "GET") return undefined;
      const sp = u.searchParams;
      if (sp.get("sender") === "eq.ai") return jsonResponse(200, []);
      if (sp.get("direction") === "eq.in") {
        inboundCallCount++;
        return jsonResponse(200, [{ id: MSG_ID, created_at: "2026-01-01T00:00:00.500Z" }]);
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const decision = await coalesceTurn(newAdminClient(), {
        conversationId: CONV_ID,
        messageId: MSG_ID,
        now: () => now,
        sleep: (ms) => {
          sleepCalls.push(ms);
          return Promise.resolve();
        },
      });
      if (!decision.proceed) {
        throw new Error(`esperava proceed=true, veio ${JSON.stringify(decision)}`);
      }
      if (decision.reason !== "no_burst") throw new Error(`reason=${decision.reason}`);
      if (inboundCallCount !== 1) {
        throw new Error(`esperava 1 fetch (sem re-fetch), veio ${inboundCallCount}`);
      }
      if (sleepCalls.length !== 0) {
        throw new Error(`esperava 0 sleeps (solo não coalesce), veio ${sleepCalls.length}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step(
    "messageId ausente + sem resposta prévia: fail-closed libera (no_message_id)",
    async () => {
      const router: FetchMatcher = (req) => {
        const u = new URL(req.url);
        if (u.pathname !== "/rest/v1/messages" || req.method !== "GET") return undefined;
        if (u.searchParams.get("sender") === "eq.ai") return jsonResponse(200, []);
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const decision = await coalesceTurn(newAdminClient(), {
          conversationId: CONV_ID,
          messageId: null,
          now: () => new Date("2026-01-01T00:00:00.000Z"),
          sleep: () => Promise.resolve(),
        });
        if (!decision.proceed) {
          throw new Error(`esperava proceed=true, veio ${JSON.stringify(decision)}`);
        }
        if (decision.reason !== "no_message_id") throw new Error(`reason=${decision.reason}`);
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "messageId ausente + resposta prévia: fail-closed bloqueia (duplicate_answer)",
    async () => {
      const router: FetchMatcher = (req) => {
        const u = new URL(req.url);
        if (u.pathname !== "/rest/v1/messages" || req.method !== "GET") return undefined;
        if (u.searchParams.get("sender") === "eq.ai") {
          return jsonResponse(200, [{ id: "ai-1", created_at: "2026-01-01T00:00:00.000Z" }]);
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const decision = await coalesceTurn(newAdminClient(), {
          conversationId: CONV_ID,
          messageId: undefined,
          now: () => new Date("2026-01-01T00:00:05.000Z"),
          sleep: () => Promise.resolve(),
        });
        if (decision.proceed) {
          throw new Error(`esperava proceed=false, veio ${JSON.stringify(decision)}`);
        }
        if (decision.reason !== "duplicate_answer") throw new Error(`reason=${decision.reason}`);
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "resposta prévia POSTERIOR à mensagem atual: bloqueia (duplicate_answer)",
    async () => {
      const MSG_ID = "msg-dup-1";
      const router: FetchMatcher = (req) => {
        const u = new URL(req.url);
        if (u.pathname !== "/rest/v1/messages" || req.method !== "GET") return undefined;
        const sp = u.searchParams;
        if (sp.get("sender") === "eq.ai") {
          // Resposta da IA registrada DEPOIS desta mensagem -> era pra este turno.
          return jsonResponse(200, [{ id: "ai-1", created_at: "2026-01-01T00:00:09.000Z" }]);
        }
        if (sp.get("direction") === "eq.in") {
          return jsonResponse(200, [{ id: MSG_ID, created_at: "2026-01-01T00:00:06.000Z" }]);
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const decision = await coalesceTurn(newAdminClient(), {
          conversationId: CONV_ID,
          messageId: MSG_ID,
          now: () => new Date("2026-01-01T00:00:10.000Z"),
          sleep: () => Promise.resolve(),
        });
        if (decision.proceed) {
          throw new Error(`esperava proceed=false, veio ${JSON.stringify(decision)}`);
        }
        if (decision.reason !== "duplicate_answer") throw new Error(`reason=${decision.reason}`);
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "resposta prévia ANTERIOR à mensagem atual: não bloqueia, turno órfão legítimo",
    async () => {
      const MSG_ID = "msg-dup-2";
      const router: FetchMatcher = (req) => {
        const u = new URL(req.url);
        if (u.pathname !== "/rest/v1/messages" || req.method !== "GET") return undefined;
        const sp = u.searchParams;
        if (sp.get("sender") === "eq.ai") {
          // Resposta da IA registrada ANTES desta mensagem -> turno prévio, não bloqueia a nova.
          return jsonResponse(200, [{ id: "ai-1", created_at: "2026-01-01T00:00:03.000Z" }]);
        }
        if (sp.get("direction") === "eq.in") {
          return jsonResponse(200, [{ id: MSG_ID, created_at: "2026-01-01T00:00:06.000Z" }]);
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const decision = await coalesceTurn(newAdminClient(), {
          conversationId: CONV_ID,
          messageId: MSG_ID,
          now: () => new Date("2026-01-01T00:00:10.000Z"),
          sleep: () => Promise.resolve(),
        });
        if (!decision.proceed) {
          throw new Error(`esperava proceed=true, veio ${JSON.stringify(decision)}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step("AbortSignal cancela a janela de coalescing: bloqueia sem re-fetch", async () => {
    const LATEST_ID = "msg-abort-2";
    const OLDER_ID = "msg-abort-1";
    const now = new Date("2026-01-01T00:00:00.000Z");
    let inboundCallCount = 0;
    const controller = new AbortController();

    const router: FetchMatcher = (req) => {
      const u = new URL(req.url);
      if (u.pathname !== "/rest/v1/messages" || req.method !== "GET") return undefined;
      const sp = u.searchParams;
      if (sp.get("sender") === "eq.ai") return jsonResponse(200, []);
      if (sp.get("direction") === "eq.in") {
        inboundCallCount++;
        return jsonResponse(200, [
          { id: LATEST_ID, created_at: "2026-01-01T00:00:00.800Z" },
          { id: OLDER_ID, created_at: "2026-01-01T00:00:00.100Z" },
        ]);
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const decision = await coalesceTurn(newAdminClient(), {
        conversationId: CONV_ID,
        messageId: LATEST_ID,
        now: () => now,
        signal: controller.signal,
        sleep: () => {
          // Simula a espera real sendo cancelada no meio do caminho: o abort
          // dispara antes de o sleep resolver, e o sleep nunca resolve.
          queueMicrotask(() => controller.abort());
          return new Promise<void>(() => {});
        },
      });
      if (decision.proceed) {
        throw new Error(`esperava proceed=false, veio ${JSON.stringify(decision)}`);
      }
      if (decision.reason !== "duplicate_answer") throw new Error(`reason=${decision.reason}`);
      if (inboundCallCount !== 1) {
        throw new Error(`esperava 1 fetch (sem re-fetch pós-abort), veio ${inboundCallCount}`);
      }
    } finally {
      uninstall();
    }
  });
});
