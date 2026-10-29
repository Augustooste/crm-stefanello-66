// Exemplo para "sistema próprio" assinar o POST para a regra de entrada (modo aceleraflow_hmac).
// Mesmo esquema da v1 (supabase/functions/_shared/webhooks/sign.ts): HMAC-SHA256 em hex de
// `${t}.${corpo}`, t em segundos. inbound-presets.test.ts confere com o vetor dourado da v1.
export const NODE_SIGN_SNIPPET = String.raw`const crypto = require("node:crypto");

// secret: segredo whin_ mostrado ao criar a regra; body: string EXATA que vai no POST.
function signAceleraflowRequest(secret, body, nowSeconds = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac("sha256", secret).update(nowSeconds + "." + body).digest("hex");
  return "t=" + nowSeconds + ",v1=" + v1;
}

// Uso (Node 18 ou mais novo):
// const body = JSON.stringify({ id: "pedido-123", email: "cliente@exemplo.com" });
// await fetch(URL_DA_REGRA, {
//   method: "POST",
//   headers: {
//     "Content-Type": "application/json",
//     "X-Aceleraflow-Signature": signAceleraflowRequest(process.env.ACELERAFLOW_SECRET, body),
//   },
//   body,
// });

module.exports = { signAceleraflowRequest };
`;
