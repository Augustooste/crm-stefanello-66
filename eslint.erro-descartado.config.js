// Config mínima, usada SÓ contra os arquivos alterados numa PR (`pnpm lint:erro-descartado`).
//
// Por que separada do eslint.config.js: o codebase tem 50 ocorrências deste
// padrão hoje. Ligar a regra no config principal deixaria o CI vermelho na hora
// e a regra seria desligada na semana seguinte. Aqui ela vale só para código
// novo — o passivo continua rastreado como finding no docs/code-review, e o
// sangramento para.
//
// Por que não estende recommended nem prettier: precisa alcançar
// `supabase/functions/**`, que é Deno e não é formatado pelo prettier do app.
// Ligar o resto ali produziria 32 erros de formatação em 2 arquivos, ruído que
// enterraria o achado real.
import tseslint from "typescript-eslint";

export default [
  {
    files: ["src/**/*.{ts,tsx}", "supabase/functions/**/*.ts"],
    // Só o parser, sem as regras do recommended: precisamos entender TS/JSX para
    // percorrer a AST, não opinar sobre o resto.
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          // Pega `await supabase.from(...).update(...)...;` como statement solto,
          // isto é, com o retorno jogado fora.
          selector:
            "ExpressionStatement > AwaitExpression:has(MemberExpression[property.name=/^(insert|update|upsert|delete)$/])",
          message:
            "Escrita do Supabase com o retorno descartado. supabase-js NÃO lança: ele devolve { data, error }, então isto reporta sucesso mesmo quando a gravação falha. Destruture `const { error } = await ...` e trate. Se o fire-and-forget for deliberado, um eslint-disable-next-line com o motivo resolve.",
        },
      ],
    },
  },
];
