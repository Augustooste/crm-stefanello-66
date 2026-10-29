# Relatório completo da falha de remix

Objetivo: produzir um documento único, em PT-BR, que sirva de evidência para o chamado de suporte da Lovable e de registro interno do que já foi verificado.

## Entrega

Um arquivo `relatorio-falha-remix.md` em `/mnt/documents`, anexado no chat para download.

## Estrutura do relatório

1. **Resumo executivo** — uma frase de veredito: o remix falha na etapa de cópia de metadados de integrações da plataforma, antes de qualquer código ou banco do projeto rodar; nada no repositório destrava isso.
2. **Sintoma e reprodução** — mensagem exata do modal ("Remix failed while copying the project's integrations"), URL do projeto, horários das tentativas, e as três formas já testadas: remix interno, remix pela URL pública em outro navegador e em outra conta/workspace.
3. **Onde exatamente falha** — descrição das etapas do remix (cópia de arquivos, criação do backend novo, cópia de metadados/vínculos de integrações, aplicação de migrations, primeiro build) e por que a evidência aponta a etapa 3: o erro é imediato, não há projeto de destino criado, não há log de build nem de banco.
4. **O que foi eliminado como causa** — lista com a evidência de cada item:
   - GitHub desconectado; nenhuma conexão de workspace vinculada ao projeto (`Felipe Truman Github API` existe mas não está vinculada).
   - Servidor MCP externo totalmente removido (dependência, plugin Vite, rotas `/mcp` e `/conectar`, tab de conexão); `/mcp` responde 404.
   - Segredos gerenciados: só `LOVABLE_API_KEY`.
   - `.env` com apenas as três variáveis públicas `VITE_SUPABASE_*`; fallback de URL/chave condicionado ao id deste projeto.
   - `.lovable/project.json` contém apenas template e revisão.
   - Metadados removíveis do repositório já limpos (planos arquivados, artefatos de auditoria, pins órfãos de lockfile).
5. **Estado de prontidão do projeto** — tabela do checkup nos sete blocos, com veredito e evidência curta: build OK, typecheck 0, `check-config-toml` 0, `check-lockfile-pins` 0, 186 migrations sem dados de demo, RLS em todas as tabelas públicas, nenhum UPDATE sem `WITH CHECK`, nenhuma escrita concedida a `anon`, nenhuma `SECURITY DEFINER` sem `search_path`, catálogos semeados por migration, jobs de cron nascendo pausados, trigger `on_auth_user_created` presente, suíte completa verde (2.374 testes de app + 268 de Edge Functions).
6. **Limitações da verificação** — o que não pôde ser executado e por quê: replay das migrations num Postgres vazio dentro do sandbox (extensões `pgvector`, schema `storage`, `pg_cron` indisponíveis; `initdb` não roda como root), e o fato de que nenhuma ferramenta disponível lê ou apaga os metadados de integração da plataforma.
7. **Por que zerar o banco não resolve** — o remix cria backend novo e aplica migrations do zero; dados não são copiados. A falha é anterior ao banco.
8. **Pedido ao suporte** — texto pronto para colar no chamado: URL do projeto, horários, print do modal, tentativas já feitas, hipótese (registro de integração órfão nos metadados internos) e o pedido explícito de inspeção e recriação desse registro.
9. **Anexos sugeridos** — captura do modal e, se houver, o horário exato de cada tentativa.

## Notas técnicas

- O relatório apenas consolida evidências já coletadas; antes de escrever, reexecuto as checagens baratas e não destrutivas (log de build, typecheck, os dois scripts de gate, consultas de RLS/grants/`SECURITY DEFINER`, contagem de migrations e catálogos) para que cada número citado seja de hoje, não de memória.
- Nenhuma alteração de código, migration, RLS, segredo ou dado. Nenhuma tentativa de "consertar" o remix mexendo no projeto.
- Ao final, marco o item aberto do `roadmap.md` ("Preparar evidências finais para suporte da plataforma") como concluído.
