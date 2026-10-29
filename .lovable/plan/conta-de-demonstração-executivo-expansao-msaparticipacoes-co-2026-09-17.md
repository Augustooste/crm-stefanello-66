# Conta de demonstração — executivo.expansao@msaparticipacoes.com.br

## Situação atual (verificada)

- A conta existe e é administradora, com espaço de trabalho próprio chamado "Executivo Expansão".
- Esse espaço está completamente vazio: 0 contatos, 0 empresas, 0 negócios, 0 conversas, 0 atividades.
- A configuração inicial nunca foi concluída, então ao entrar o assistente de configuração abre por cima da tela.
- Já existe um conjunto de dados de demonstração pronto em outro espaço ("Acelera Consultoria": 28 contatos, 20 empresas, 26 negócios, 14 conversas, 26 decisões pendentes). Ele serve de modelo.

## O que será feito

1. **Finalizar a configuração do espaço** para o assistente não aparecer na demonstração: nome do espaço "MSA Participações", nicho genérico (consultoria/B2B) e configuração marcada como concluída.
2. **Criar o funil de vendas** com as etapas do modelo genérico e as instruções de IA por etapa.
3. **Popular com dados fictícios realistas**, no mesmo volume do conjunto atual de demonstração:
   - ~20 empresas clientes com segmento, porte e site
   - ~28 contatos com nome, telefone, e-mail e empresa vinculada
   - ~26 negócios distribuídos por todas as etapas do funil, com valores em reais, alguns ganhos e alguns perdidos
   - ~14 conversas de WhatsApp com histórico de mensagens (cliente e assistente), algumas aguardando resposta
   - ~20 atividades (ligações, reuniões, follow-ups), umas concluídas e outras em aberto
   - decisões pendentes da IA, para a tela de aprovações não ficar vazia
4. **Criar um canal de WhatsApp fictício** apenas para exibição, sem conexão real — nada é enviado para fora.
5. **Datas relativas ao momento atual** (últimos 60 dias e próximos 15), para os gráficos e listas parecerem vivos em qualquer dia da apresentação.

## Garantias

- Nada dispara mensagem, webhook ou chamada externa: o canal é fictício e as rotinas automáticas não tocam esse espaço.
- Os dados ficam isolados no espaço dessa conta; nenhum outro cliente enxerga.
- Nenhuma conta existente é alterada ou removida.

## Detalhes técnicos

- Inserções via ferramenta de dados (não migration), com UUIDs determinísticos derivados do tenant `8f6056d4-beb7-4d60-b773-3730ae8d3f43` e `ON CONFLICT DO NOTHING`, para o script poder ser reexecutado sem duplicar.
- Timestamps calculados como `now() - interval`, nunca datas fixas.
- Ordem de inserção: `tenants` (nome/niche/onboarded_at) → `boards`/`board_stages` → `stage_ai_config`/`ai_settings` → `crm_companies` → `contacts` → `deals` → `channels` (mock, `status` desconectado) → `conversations`/`messages` → `activities` → `hitl_decisions`.
- Sem alteração de RLS, policies ou grants; nenhuma migration nova.

## Fora do escopo

- Conectar WhatsApp real ou qualquer integração externa.
- Alterar a senha da conta (se necessário, o acesso é redefinido pelo fluxo de recuperação).
