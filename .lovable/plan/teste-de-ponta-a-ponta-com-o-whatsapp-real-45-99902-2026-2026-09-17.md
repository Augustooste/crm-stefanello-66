# Teste de ponta a ponta com o WhatsApp real (45 99902-2026)

Rodar uma simulação completa de operação na conta **MSA Participações**, que já é a conta com o WhatsApp (Evolution Go) e a voz (ElevenLabs) ligados. Três leads fictícios "chegam" pelo WhatsApp, a assistente de IA atende sozinha, e as respostas saem de verdade para o número 45 99902-2026 em texto, áudio e imagem. Depois conferimos, tela por tela, se tudo apareceu no lugar certo.

## O que vai acontecer no aparelho

O número vai receber, em sequência e com intervalo curto:

1. Resposta de texto da assistente a um lead novo ("quero saber sobre a consultoria").
2. Resposta em áudio (voz do ElevenLabs) a um lead que pede detalhe de proposta.
3. Uma imagem (catálogo/apresentação fictícia) enviada pelo atendimento.
4. Uma mensagem de transferência para humano, quando o lead pedir falar com pessoa.

Nada é enviado para nenhum outro número. Total estimado: 6 a 10 mensagens.

## Roteiro dos três leads

| Lead | História | O que deve acontecer sozinho |
| --- | --- | --- |
| Ricardo Alves | Pede informação inicial | Contato e negócio criados, entra na 1ª etapa do funil, IA responde em texto |
| Juliana Prado | Pede proposta e valores | IA qualifica, negócio avança de etapa, resposta em áudio |
| Marcos Lemos | Pede falar com uma pessoa | IA pausa naquela conversa e cria aprovação pendente para o atendente |

## Como o teste é conduzido

1. **Preparação** — conferir que o WhatsApp está conectado, a voz escolhida e a IA ativa na conta MSA; ligar o modo de resposta em voz só durante o teste e devolver ao estado anterior no fim.
2. **Entrada dos leads** — as mensagens dos leads entram pelo mesmo caminho que uma mensagem real do WhatsApp usa, com a credencial da instância, para que nada seja "empurrado" direto no banco.
3. **Atendimento automático** — a assistente responde e as respostas saem de verdade para o aparelho.
4. **Atendimento manual** — assumo uma conversa como atendente e envio a imagem e um texto, para testar a troca humano/IA.
5. **Agenda** — marcar um compromisso a partir de um dos negócios e confirmar que aparece na agenda.
6. **Conferência nas telas** — percorrer Conversas, Contatos, Negócios (kanban, arrastar de etapa), Agenda, Aprovações pendentes e Painel, com prints de cada uma.
7. **Relatório** — lista do que passou, do que falhou e o que precisa de ajuste, com as mensagens que chegaram no aparelho.

## Limpeza

Os três leads do teste ficam marcados e podem ser apagados ao final com um comando só — me diga se prefere manter para demonstração ou remover.

## Detalhes técnicos

- Tenant `8f6056d4-beb7-4d60-b773-3730ae8d3f43` (MSA Participações); canal `9c253717…` provider `evolution`, instância `ali-simuladorlead03`, `status: connected`, `webhook_health: ok`.
- Entrada simulada: `POST` na função `messaging-webhook` com payload no formato Evolution (`data.Info` + `data.Message`) e o `instanceToken` lido de `integration_secrets` — passa pela validação real de credencial, dedupe por `external_id` e pelo normalizador novo.
- Saída real: `ai-respond` → `sendEvolutionText` / `sendEvolutionAudio` (link assinado do bucket `ai-audio`, fallback base64 puro) e `/send/media` para a imagem.
- Voz: `ai_settings.voice_id = ORgG8rwdAiMYRug8RJwR`; `voice_reply_mode` hoje é `off` — mudo para o modo com voz durante o teste e restauro depois.
- Contatos/negócios de teste recebem UUID determinístico com prefixo próprio e `ON CONFLICT DO NOTHING`, para poder repetir o roteiro sem duplicar.
- Conferência de UI via Playwright em `localhost:8080` com sessão do usuário da conta MSA; prints por tela.
- Nenhuma policy de RLS é afrouxada; nada é gravado com id vindo de corpo de requisição.
