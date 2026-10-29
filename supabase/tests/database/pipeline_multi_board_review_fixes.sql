-- Epico A: Pipeline profundo (multi-board) -- fixes de review adversarial
-- (20260713110000_pipeline_multi_board_review_fixes.sql). Roda contra o
-- shadow DB local (supabase test db --local; pnpm test:db), que reaplica
-- todas as migrations do zero -- não toca a DB real do Lovable. NÃO rodar
-- aqui agora (decisão explícita: agente de fix não deve resetar o shadow DB
-- compartilhado com outros agentes/worktrees em paralelo; execução fica pro
-- agente de verificação final sozinho).
begin;
create extension if not exists pgtap;

select plan(5);

-- =============================================================================
-- Fixture: 1 tenant, board default "Board A" com 1 stage e 1 deal aberto,
-- + 1 board extra "Board B" com 1 stage e 1 deal aberto.
-- =============================================================================
insert into auth.users (id, email) values
  ('30303030-3030-3030-3030-303030303030', 'admin-multiboard@test.local');

insert into public.boards (id, tenant_id, name, is_default)
select 'b0a00000-0000-0000-0000-000000000001', tenant_id, 'Board A', true
from public.profiles where id = '30303030-3030-3030-3030-303030303030';

insert into public.board_stages (id, board_id, name, position)
values ('50a00000-0000-0000-0000-000000000001', 'b0a00000-0000-0000-0000-000000000001', 'Novo', 0);

insert into public.boards (id, tenant_id, name, is_default)
select 'b0a00000-0000-0000-0000-000000000002', tenant_id, 'Board B', false
from public.profiles where id = '30303030-3030-3030-3030-303030303030';

insert into public.board_stages (id, board_id, name, position)
values ('50a00000-0000-0000-0000-000000000002', 'b0a00000-0000-0000-0000-000000000002', 'Novo', 0);

insert into public.deals (tenant_id, board_id, stage_id, title, value, status)
select tenant_id, 'b0a00000-0000-0000-0000-000000000001', '50a00000-0000-0000-0000-000000000001',
  'Negócio Board A', 100, 'open'
from public.profiles where id = '30303030-3030-3030-3030-303030303030';

insert into public.deals (tenant_id, board_id, stage_id, title, value, status)
select tenant_id, 'b0a00000-0000-0000-0000-000000000002', '50a00000-0000-0000-0000-000000000002',
  'Negócio Board B', 200, 'open'
from public.profiles where id = '30303030-3030-3030-3030-303030303030';

-- =============================================================================
-- 1. (HIGH #1) boards_protect_default_delete: excluir o board is_default
--    lança 42501, mesmo sem passar pela UI (BoardSwitcher só desabilita o
--    botão -- a guarda real tem que estar no banco).
-- =============================================================================
select throws_ok(
  $$delete from public.boards where id = 'b0a00000-0000-0000-0000-000000000001'$$,
  '42501',
  'O quadro padrão não pode ser removido',
  'trigger bloqueia delete do board is_default'
);

select ok(
  (select true from public.boards where id = 'b0a00000-0000-0000-0000-000000000001'),
  'board default sobrevive à tentativa de delete'
);

-- =============================================================================
-- 2. Sanity: um board NÃO-default continua podendo ser removido normalmente
--    (a guarda é específica de is_default, não um bloqueio geral de delete).
-- =============================================================================
delete from public.boards where id = 'b0a00000-0000-0000-0000-000000000002';

select is(
  (select count(*)::int from public.boards where id = 'b0a00000-0000-0000-0000-000000000002'),
  0,
  'board não-default pode ser removido normalmente'
);

-- board B (e seu deal, via cascade) já foi removido acima -- recria só o
-- deal de board B pra reproduzir o cenário multi-board completo no teste do
-- funil abaixo.
insert into public.boards (id, tenant_id, name, is_default)
select 'b0a00000-0000-0000-0000-000000000002', tenant_id, 'Board B', false
from public.profiles where id = '30303030-3030-3030-3030-303030303030';

insert into public.board_stages (id, board_id, name, position)
values ('50a00000-0000-0000-0000-000000000002', 'b0a00000-0000-0000-0000-000000000002', 'Novo', 0);

insert into public.deals (tenant_id, board_id, stage_id, title, value, status)
select tenant_id, 'b0a00000-0000-0000-0000-000000000002', '50a00000-0000-0000-0000-000000000002',
  'Negócio Board B (recriado)', 200, 'open'
from public.profiles where id = '30303030-3030-3030-3030-303030303030';

-- =============================================================================
-- 3. (HIGH #2) Funil de dashboard_report_for_tenant agrega TODOS os boards do
--    tenant, não só o is_default -- prova que o negócio do Board B aparece.
-- =============================================================================
set local role service_role;

select is(
  (select jsonb_array_length(public.dashboard_report_for_tenant(
      (select tenant_id from public.profiles where id = '30303030-3030-3030-3030-303030303030'),
      now() - interval '1 day',
      now() + interval '1 day'
    ) -> 'funil')),
  2,
  'funil inclui as stages de ambos os boards (default + extra)'
);

select is(
  (select (
     select sum((stage ->> 'negocios')::int)::int
     from jsonb_array_elements(public.dashboard_report_for_tenant(
       (select tenant_id from public.profiles where id = '30303030-3030-3030-3030-303030303030'),
       now() - interval '1 day',
       now() + interval '1 day'
     ) -> 'funil') as stage
   )),
  2,
  'funil soma 2 negócios abertos (1 em cada board), não só o do board default'
);

reset role;

select * from finish();
rollback;
