# Funil comercial Laticínios Stefanello — plano

## Ponto importante antes de tudo
O CRM **já tem banco de dados conectado** (Lovable Cloud). Ele só está vazio: 0 empresas, 0 contatos, 0 negócios, 0 funis. Ou seja, quase tudo da especificação pode funcionar de verdade, não só com dados fictícios. O que depende de algo externo está listado no fim.

## O que existe hoje
- **Pipeline (Kanban):** quadros e etapas configuráveis, cards com valor, responsável, data de entrada na etapa, "motivo de perda" em texto livre e campos personalizados. Já existem automações de IA, nutrição (sequências) e follow-ups.
- **Modelo de funil "Laticínios Stefanello"** (criado antes): Lead digital (tele vendas) → Contato do tele vendas → Cadastro → Primeiro pedido → Cliente recorrente → Perdido. Será substituído.
- **Contatos:** nome, telefone, e-mail, origem (texto livre), cidade/UF, responsável, status, tags, campos personalizados, detecção de duplicados.
- **Dashboard/Relatórios:** indicadores gerais de funil, mensagens, IA.
- **Configurações:** equipe e papéis, campos personalizados, status de contato, integrações.

## O que muda em cada tela

### Pipeline
1. Funil principal com 6 etapas e prazos: Lead novo (mesmo dia) · Em contato (5 dias / 3 tentativas) · Qualificado (3 dias) · Proposta/negociação (7 dias) · Cadastro e crédito (2 dias úteis, Keiti) · Ganho (1º pedido faturado).
2. Badge vermelho "Fora do prazo" no card quando passar do prazo da etapa; contador de tentativas na etapa 2.
3. Etapa 4: campo "Amostra solicitada" (sim/não) → cria tarefa de aprovação para o Jaime; se aprovada e entrega registrada, cria follow-up em 3 dias.
4. Etapa 5 atribui automaticamente a Keiti como responsável pela tarefa de crédito.
5. Marcar perdido abre janela com os 8 motivos fixos (obrigatório). "Sem contato" agenda volta para nutrição em 60–90 dias.
6. Nova aba/coluna **Fora da área** (separada do funil ativo, fora da taxa de conversão): entrada automática se UF ≠ RS/SC, botão "Mover para fora da área" em qualquer card, relatório por UF/cidade/região e ação em lote **Reativar região** (filtra cidade/região, escolhe responsável, move para Lead novo).
7. Segundo quadro **Pós-venda (ativação)**: 1ª entrega confirmada (contato D+2) → Aguardando 2º pedido (até 15 dias) → Cliente ativado (2º pedido em até 30 dias); etapa paralela "Pediu visita presencial". Ganho no funil principal cria o card aqui automaticamente.

### Contatos (cadastro do lead)
- Campos obrigatórios com listas fixas: Origem (4 opções), Segmento (7 opções), Cidade, UF, Volume estimado/mês (kg), Fornecedor atual, Produtos de interesse, Responsável.
- Seção **Comissão**: Origem do cliente (Lead da empresa × Prospecção própria), Quem abriu, Dono da carteira, Acompanhamento, Data da transferência.
- Roteamento ao criar: RS → Viviane, SC → Representante SC, outra UF → Fora da área.
- Regra de carteira: após 1º pedido do RS, Viviane vira dona da carteira; "Pediu visita presencial" transfere para o Vendedor Externo RS, Viviane fica como acompanhamento e a data da transferência é gravada.
- Cadastro de cidades atendidas por rota (para marcar "cidade na rota" e alimentar o "Fora da área").

### Dashboard
Novos cartões, todos em número inteiro com ponto de milhar (ex.: 12.480):
leads por origem e por responsável · conversão por etapa e lead→cliente · tempo médio por etapa e leads fora do prazo · custo por cliente aberto (tráfego pago) · ticket e mix do 1º pedido · taxa de ativação (2º pedido em 30 dias) · clientes abertos lead da empresa × prospecção própria · demanda fora de área por UF/cidade/região.

### Configurações
- Prazos por etapa editáveis.
- Lista de cidades/regiões com rota (RS e SC).
- Regras de roteamento por UF (quem recebe).
- Valor investido em tráfego pago por mês (para o custo por cliente).
- Equipe fictícia: Viviane (Televendas RS), Representante SC, Jaime (Gerente Comercial), Keiti (Financeiro), Vendedor Externo RS.

## Ordem de execução
1. Banco: novas colunas/listas (segmento, volume, fornecedor, comissão, fora da área, amostra, tentativas, prazos por etapa, cidades na rota, investimento em tráfego) e motivos de perda fixos.
2. Substituir o modelo de funil pelos 2 quadros (principal + pós-venda) e remover as etapas antigas.
3. Formulário de contato/lead com campos obrigatórios e roteamento por UF.
4. Pipeline: prazos e badge, amostra/aprovação, janela de perda, Fora da área com Reativar região.
5. Regras de carteira e passagem para o pós-venda.
6. Dashboard com os novos indicadores e formato numérico.
7. Configurações.
8. Dados fictícios: 5 usuários de exemplo e ~40 leads espalhados pelas etapas, alguns atrasados e alguns fora da área.
9. Testes das regras (roteamento por UF, prazos, motivo obrigatório, fora da área fora da conversão, taxa de ativação, formato de número).

## O que funciona de verdade agora vs. só com dados fictícios
**Funciona de verdade (banco já conectado):** roteamento automático por UF, alertas de prazo, tarefas do Jaime e da Keiti, volta para nutrição de "sem contato", lista Fora da área e Reativar região, relatórios e filtros salvos.

**Depende de algo externo:**
- Usuários Viviane, Keiti etc. serão de exemplo; para eles entrarem no sistema é preciso convidar os e-mails reais.
- "1º pedido faturado" e "1ª entrega confirmada" serão marcados à mão até conectarmos seu sistema de faturamento/ERP.
- Custo por cliente usa o valor de tráfego digitado em Configurações até conectarmos Meta/Google Ads.
- Avisos por WhatsApp/e-mail de atraso precisam do canal conectado em Integrações; dentro do CRM o alerta aparece sem isso.

## Suposições (corrija se errado)
- "Dias úteis" só na etapa Cadastro e crédito; demais prazos em dias corridos.
- Região = agrupamento de cidades que você define em Configurações.
- Nutrição de "sem contato" em 75 dias (meio de 60–90).

## Detalhes técnicos
- Campos novos em `contacts`/`deals` como colunas próprias (não JSON) para filtros e relatórios; enums para origem, segmento e motivo de perda.
- Tabelas novas: `service_route_cities`, `stage_sla` (ou colunas em `board_stages`), `marketing_spend`.
- Roteamento e transferência de carteira via triggers no banco; dados fictícios inseridos na migração.
- Formatação via `Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 })`.
