-- Fase 4 PR-B (user story F) -- dashboard_report_for_tenant(): review encontrou
-- que a migration 20260711100400 não tinha NENHUM teste pgTAP (nem rejeição
-- nem comportamento). Roda contra o shadow DB local (supabase test db --local;
-- pnpm test:db), que reaplica todas as migrations do zero -- não toca a DB
-- real do Lovable. NÃO rodar aqui agora (decisão explícita: agentes de fix em
-- paralelo nesta PR; execução fica pro agente de verificação final sozinho).
begin;
create extension if not exists pgtap;

select plan(9);

-- =============================================================================
-- 1. Rejeição: authenticated e anon são bloqueados via revoke (SQLSTATE 42501
--    "permission denied for function") -- a função não checa auth.uid()/
--    is_admin em runtime, a segurança é 100% via grant/revoke (comentário da
--    própria migration). throws_ok de 4 args (mesmo padrão de
--    fase4_prb_weekly_digest_schema.sql): errmsg=NULL checa só o SQLSTATE.
-- =============================================================================
set local role authenticated;
select throws_ok(
  $$select public.dashboard_report_for_tenant(
      '00000000-0000-0000-0000-000000000000'::uuid,
      '2026-07-01T00:00:00Z'::timestamptz,
      '2026-07-08T00:00:00Z'::timestamptz
    )$$,
  '42501',
  NULL,
  'authenticated é bloqueado de executar dashboard_report_for_tenant (revoke from authenticated)'
);
reset role;

set local role anon;
select throws_ok(
  $$select public.dashboard_report_for_tenant(
      '00000000-0000-0000-0000-000000000000'::uuid,
      '2026-07-01T00:00:00Z'::timestamptz,
      '2026-07-08T00:00:00Z'::timestamptz
    )$$,
  '42501',
  NULL,
  'anon é bloqueado de executar dashboard_report_for_tenant (revoke from anon)'
);
reset role;

-- =============================================================================
-- 2. Fixtures: 2 tenants via handle_new_user (trigger em auth.users), 1 board
--    default + 1 stage por tenant (deals.board_id/stage_id são NOT NULL).
-- =============================================================================
insert into auth.users (id, email) values
  ('10101010-1010-1010-1010-101010101010', 'admin-a-dashreport@test.local'),
  ('20202020-2020-2020-2020-202020202020', 'admin-b-dashreport@test.local');

insert into public.boards (tenant_id, name, is_default)
select tenant_id, 'Board A', true
from public.profiles where id = '10101010-1010-1010-1010-101010101010';

insert into public.board_stages (board_id, name, position)
select b.id, 'Fechado', 0
from public.boards b
join public.profiles p on p.tenant_id = b.tenant_id
where p.id = '10101010-1010-1010-1010-101010101010';

insert into public.boards (tenant_id, name, is_default)
select tenant_id, 'Board B', true
from public.profiles where id = '20202020-2020-2020-2020-202020202020';

insert into public.board_stages (board_id, name, position)
select b.id, 'Fechado', 0
from public.boards b
join public.profiles p on p.tenant_id = b.tenant_id
where p.id = '20202020-2020-2020-2020-202020202020';

-- Tenant A: 1 deal 'won' dentro da janela testada (2026-07-01 .. 2026-07-08),
-- ciclo de 2 dias exatos (created_at -> stage_entered_at) para checar
-- ciclo_medio_dias de forma determinística.
insert into public.deals (tenant_id, board_id, stage_id, title, value, status, stage_entered_at, created_at)
select p.tenant_id, b.id, s.id, 'Negócio ganho A', 1000, 'won', '2026-07-03T00:00:00Z', '2026-07-01T00:00:00Z'
from public.profiles p
join public.boards b on b.tenant_id = p.tenant_id
join public.board_stages s on s.board_id = b.id
where p.id = '10101010-1010-1010-1010-101010101010';

-- Tenant A: 1 deal 'lost' dentro da janela, com lost_reason (agregado em
-- motivos_perda).
insert into public.deals (tenant_id, board_id, stage_id, title, value, status, lost_reason, stage_entered_at, created_at)
select p.tenant_id, b.id, s.id, 'Negócio perdido A', 500, 'lost', 'Preço', '2026-07-04T00:00:00Z', '2026-07-02T00:00:00Z'
from public.profiles p
join public.boards b on b.tenant_id = p.tenant_id
join public.board_stages s on s.board_id = b.id
where p.id = '10101010-1010-1010-1010-101010101010';

-- Tenant A: 1 deal 'won' FORA da janela (stage_entered_at antes de p_from) --
-- não deve contar, prova o filtro de data.
insert into public.deals (tenant_id, board_id, stage_id, title, value, status, stage_entered_at, created_at)
select p.tenant_id, b.id, s.id, 'Negócio ganho A (fora da janela)', 9999, 'won', '2026-06-15T00:00:00Z', '2026-06-10T00:00:00Z'
from public.profiles p
join public.boards b on b.tenant_id = p.tenant_id
join public.board_stages s on s.board_id = b.id
where p.id = '10101010-1010-1010-1010-101010101010';

-- Tenant B: 1 deal 'won' dentro da mesma janela -- não deve vazar pro
-- relatório de A, prova o isolamento por tenant_id.
insert into public.deals (tenant_id, board_id, stage_id, title, value, status, stage_entered_at, created_at)
select p.tenant_id, b.id, s.id, 'Negócio ganho B', 7777, 'won', '2026-07-05T00:00:00Z', '2026-07-01T00:00:00Z'
from public.profiles p
join public.boards b on b.tenant_id = p.tenant_id
join public.board_stages s on s.board_id = b.id
where p.id = '20202020-2020-2020-2020-202020202020';

-- =============================================================================
-- 3. Comportamento: chamando como service_role (o único role com EXECUTE),
--    seção "resultados" bate com os dados esperados -- prova que a função
--    roda e agrega corretamente, não só que o revoke bloqueia.
-- =============================================================================
set local role service_role;

select is(
  (select (public.dashboard_report_for_tenant(
      (select tenant_id from public.profiles where id = '10101010-1010-1010-1010-101010101010'),
      '2026-07-01T00:00:00Z'::timestamptz,
      '2026-07-08T00:00:00Z'::timestamptz
    ) -> 'resultados' ->> 'ganhos')::int),
  1,
  'resultados.ganhos = 1 (só o won de tenant A dentro da janela; exclui fora-da-janela e tenant B)'
);

select is(
  (select (public.dashboard_report_for_tenant(
      (select tenant_id from public.profiles where id = '10101010-1010-1010-1010-101010101010'),
      '2026-07-01T00:00:00Z'::timestamptz,
      '2026-07-08T00:00:00Z'::timestamptz
    ) -> 'resultados' ->> 'ganhos_valor')::numeric),
  1000::numeric,
  'resultados.ganhos_valor = 1000 (valor do deal won dentro da janela)'
);

select is(
  (select (public.dashboard_report_for_tenant(
      (select tenant_id from public.profiles where id = '10101010-1010-1010-1010-101010101010'),
      '2026-07-01T00:00:00Z'::timestamptz,
      '2026-07-08T00:00:00Z'::timestamptz
    ) -> 'resultados' ->> 'perdidos')::int),
  1,
  'resultados.perdidos = 1 (o deal lost de tenant A dentro da janela)'
);

select is(
  (select (public.dashboard_report_for_tenant(
      (select tenant_id from public.profiles where id = '10101010-1010-1010-1010-101010101010'),
      '2026-07-01T00:00:00Z'::timestamptz,
      '2026-07-08T00:00:00Z'::timestamptz
    ) -> 'resultados' ->> 'ciclo_medio_dias')::numeric),
  2.0::numeric,
  'resultados.ciclo_medio_dias = 2.0 (created_at -> stage_entered_at do won, 2 dias exatos)'
);

select is(
  (select jsonb_array_length(public.dashboard_report_for_tenant(
      (select tenant_id from public.profiles where id = '10101010-1010-1010-1010-101010101010'),
      '2026-07-01T00:00:00Z'::timestamptz,
      '2026-07-08T00:00:00Z'::timestamptz
    ) -> 'resultados' -> 'motivos_perda')),
  1,
  'resultados.motivos_perda tem 1 motivo agregado'
);

select is(
  (select (public.dashboard_report_for_tenant(
      (select tenant_id from public.profiles where id = '10101010-1010-1010-1010-101010101010'),
      '2026-07-01T00:00:00Z'::timestamptz,
      '2026-07-08T00:00:00Z'::timestamptz
    ) -> 'resultados' -> 'motivos_perda' -> 0 ->> 'motivo')),
  'Preço',
  'resultados.motivos_perda[0].motivo = Preço (lost_reason do deal lost de tenant A)'
);

select is(
  (select (public.dashboard_report_for_tenant(
      (select tenant_id from public.profiles where id = '10101010-1010-1010-1010-101010101010'),
      '2026-07-01T00:00:00Z'::timestamptz,
      '2026-07-08T00:00:00Z'::timestamptz
    ) -> 'resultados' -> 'motivos_perda' -> 0 ->> 'n')::int),
  1,
  'resultados.motivos_perda[0].n = 1'
);

reset role;

select * from finish();
rollback;
