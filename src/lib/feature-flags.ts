// Flags de build para área que existe no repo mas não está no ar.
//
// Não confundir com as flags por tenant do banco (`feature_flags`/`knowledge_rag`):
// aquelas ligam algo por cliente, estas escondem algo de TODO mundo. Uma área
// aqui é decisão de produto, não de plano.

/**
 * Área de Agentes de IA (`/agentes` + integração `agent-platform`).
 *
 * Desligada em 2026-08-03 de manhã e **reativada no mesmo dia**, por decisão do
 * Felipe.
 *
 * O que está no repo é um painel de controle REMOTO de um provedor externo: cada
 * ação da tela vira chamada à API dele, com o token do tenant. Isso não some por
 * estar ligado — quem conectar a integração passa a mandar credencial e dados
 * para fora, e o motor próprio do Stefanello (`ai-respond` + RAG em
 * `kb_documents`) continua sendo o caminho do MVP. As duas coisas convivem: esta
 * área é opcional e só age se o tenant conectar.
 *
 * As duas pontas andam juntas — flag aqui e `integrations.available` no banco
 * (migration `20260803160000`). Só uma delas e o menu volta com a conexão
 * recusada com 400 pelo `integration-connect`, ou o contrário.
 *
 * **Desligada de novo em 2026-08-04**, e o motivo é diferente das vezes
 * anteriores: não é decisão sobre mandar dado para fora, é que a área está
 * INCOMPLETA e aparece como fantasma. O card "Agentes de IA" em Configurações
 * → Integrações oferece "Conectar" para uma configuração de agentes que não
 * existe, e o item "Agentes IA" fica no menu levando a uma área sem uso.
 * Botão que não leva a lugar nenhum é pior que ausência do botão.
 *
 * OCULTA, não removida: o código segue no repo e volta com uma linha, no dia
 * em que a área estiver pronta. Virar as DUAS pontas junto — esta constante e
 * `integrations.available` (migration `20260804220000`).
 */
export const AGENTES_IA_HABILITADO = false;
