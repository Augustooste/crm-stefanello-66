// Vetor dourado da assinatura de webhook: reutilizado pelos testes do worker (Task 8).
// GOLDEN_SIGNATURE conferido de forma independente com:
//   printf '%s' '1700000000.{"event":"test","id":"evt_golden"}' | openssl dgst -sha256 -hmac 'whsec_golden_secret' -hex
export const GOLDEN_SECRET = "whsec_golden_secret";
export const GOLDEN_TIMESTAMP = 1700000000;
export const GOLDEN_BODY = '{"event":"test","id":"evt_golden"}';
export const GOLDEN_SIGNATURE =
  "v1=f2a31b415d67f9eda55008f587b9d4d0d72173e549198687e04fef8371f2758d";
