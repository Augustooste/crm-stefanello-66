# Evolution Go em Configurações → Canais e Integrações

Hoje o WhatsApp via Evolution Go já existe por baixo (envio, status, QR, reconexão e watchdog),
mas o card está **escondido** do catálogo e o texto do assistente aponta para a documentação
antiga (`doc.evolution-api.com`). Além disso, o endereço de webhook precisa ser colado à mão no
painel do Evolution — a documentação oficial mostra que ele pode ser instalado automaticamente
no momento da conexão.

## O que muda para quem usa

1. Aparece um card **"WhatsApp (Evolution Go)"** em Configurações → Canais e Integrações, ao
   lado de Z-API, Zappaz e Meta.
2. Assistente de conexão em 3 passos, escrito a partir da documentação oficial:
   - **Passo 1 — Servidor:** endereço do Evolution Go (ex.: `https://seu-dominio.com`), com aviso
     de que precisa estar publicado na internet (não `localhost`).
   - **Passo 2 — Chave e instância:** `GLOBAL_API_KEY` (a chave do `.env` do servidor) e o nome da
     instância. Campo opcional para o token da instância, quando o usuário definiu um próprio.
   - **Passo 3 — Pareamento:** explica que, ao salvar, a conexão é aberta e o QR Code aparece na
     própria tela para escanear em WhatsApp → Dispositivos conectados.
3. Ao salvar, o app registra sozinho o endereço de recebimento de mensagens na instância — sem
   copiar e colar no painel do Evolution.
4. Lista de verificação do card (instância pareada, recebimento de eventos, chave correta) com
   links para a documentação nova em `docs.evolutionfoundation.com.br`.

## Detalhes técnicos

- `src/components/integrations/IntegrationCard.tsx`: remover `evolution` de `HIDDEN_CATALOG_SLUGS`.
- Migration idempotente atualizando a linha `public.integrations` de slug `evolution`:
  nome "WhatsApp (Evolution Go)", descrição e `required_secrets` alinhados aos nomes oficiais
  (`api_url`, `api_key` = GLOBAL_API_KEY, `instance_name`, `instance_token` opcional),
  `setup_steps` refletindo os três passos. Sem mexer em policies/grants.
- `src/lib/integrations/wizards/registry.ts`: reescrever o wizard `evolution` com os passos acima
  e `docsUrl` para `https://docs.evolutionfoundation.com.br/evolution-go/getting-started`.
- `src/components/integrations/checklists.ts`: trocar os três links do `evolutionChecklist` pelas
  páginas novas (`/evolution-go/getting-started`, `/evolution-go/webhooks`) e ajustar as dicas
  para o vocabulário oficial (GLOBAL_API_KEY, instância, pareamento).
- `supabase/functions/_shared/messaging/evolution-client.ts`: nova função
  `connectEvolutionInstance(cred, webhookUrl)` que faz
  `POST /instance/connect` com headers `apikey` + `instanceId` e corpo
  `{ webhookUrl, subscribe: ["MESSAGE","SEND_MESSAGE","CONNECTION","QRCODE","READ_RECEIPT"], immediate: true }`,
  mantendo o padrão já existente: `validatePublicHttpsUrl` antes do fetch, `AbortSignal.timeout`,
  nunca lançar (retorna `{ok,error,qrCode?}`), erro real logado no servidor.
- `supabase/functions/integration-connect/index.ts`: no ramo `slug === "evolution"`, chamar
  `connectEvolutionInstance` com a URL de webhook do canal antes do fluxo atual de
  status/reconnect, preservando o resultado (`waiting_qr` + QR) quando o pareamento ainda falta.
- Testes: casos novos em `supabase/functions/tests/evolution-client.test.ts` (corpo/headers da
  conexão, falha de rede sem lançar, URL privada recusada) e ajuste do teste de catálogo/visibilidade
  onde `evolution` era esperado como oculto.
