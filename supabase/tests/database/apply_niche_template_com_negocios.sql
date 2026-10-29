-- apply_niche_template (wizard de onboarding / "Refazer configuração inicial")
-- precisa reaplicar um modelo de nicho num funil que JÁ tem negócios, sem
-- burlar o guard aa_deals_require_transition_command: a remapeação deixa
-- trilha em deal_stage_history, o guard continua bloqueando UPDATE direto
-- fora da função e o isolamento por tenant segue valendo.
-- Tudo genérico: tenants/usuários criados pelo fluxo de cadastro
-- (handle_new_user) e o modelo 'generico' de niche_templates.
begin;
select plan(11);

-- Dois cadastros independentes: cada um vira admin do próprio tenant.
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at) values
 ('e1000000-0000-4000-8000-000000000011', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  'nicho-admin-a@test.invalid', '{"name":"Admin A"}', '{"provider":"email"}', now(), now()),
 ('e1000000-0000-4000-8000-000000000012', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  'nicho-admin-b@test.invalid', '{"name":"Admin B"}', '{"provider":"email"}', now(), now());

-- Funil A com estágios antigos (posições 1, 2 e 9) e três negócios abertos.
insert into public.boards (id, tenant_id, name)
select 'e1000000-0000-4000-8000-000000000101', tenant_id, 'Funil com negócios'
  from public.profiles where id = 'e1000000-0000-4000-8000-000000000011';
insert into public.board_stages (id, board_id, name, position) values
 ('e1000000-0000-4000-8000-000000000201', 'e1000000-0000-4000-8000-000000000101', 'Antigo 1', 1),
 ('e1000000-0000-4000-8000-000000000202', 'e1000000-0000-4000-8000-000000000101', 'Antigo 2', 2),
 ('e1000000-0000-4000-8000-000000000209', 'e1000000-0000-4000-8000-000000000101', 'Antigo 9', 9);
insert into public.deals (id, tenant_id, board_id, stage_id, title)
select v.id::uuid, p.tenant_id, 'e1000000-0000-4000-8000-000000000101', v.stage::uuid, v.title
  from public.profiles p,
       (values
         ('e1000000-0000-4000-8000-000000000301', 'e1000000-0000-4000-8000-000000000201', 'Negócio no estágio 1'),
         ('e1000000-0000-4000-8000-000000000302', 'e1000000-0000-4000-8000-000000000202', 'Negócio no estágio 2'),
         ('e1000000-0000-4000-8000-000000000309', 'e1000000-0000-4000-8000-000000000209', 'Negócio sem par de posição')
       ) as v(id, stage, title)
 where p.id = 'e1000000-0000-4000-8000-000000000011';

-- Funil A2 sem negócios (fluxo original do onboarding).
insert into public.boards (id, tenant_id, name)
select 'e1000000-0000-4000-8000-000000000102', tenant_id, 'Funil vazio'
  from public.profiles where id = 'e1000000-0000-4000-8000-000000000011';
insert into public.board_stages (id, board_id, name, position) values
 ('e1000000-0000-4000-8000-000000000221', 'e1000000-0000-4000-8000-000000000102', 'Antigo vazio', 1);

-- Reproduz a ACL de produção (authenticated sem USAGE em private).
revoke usage on schema private from authenticated;

-- (a) Admin A reaplica o modelo no funil com negócios.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000011","role":"authenticated"}', true);

select lives_ok(
  $$select public.apply_niche_template(
      'e1000000-0000-4000-8000-000000000101', t.slug, t.base_prompt, t.stages, t.stage_prompts)
      from public.niche_templates t where t.slug = 'generico'$$,
  'Admin aplica o modelo em funil com negócios abertos');

reset role;

-- (b) Todos os negócios terminam em estágio do novo funil.
select is(
  (select count(*)::int from public.deals d
     join public.board_stages s on s.id = d.stage_id and s.board_id = d.board_id
    where d.board_id = 'e1000000-0000-4000-8000-000000000101'),
  3, 'Os 3 negócios estão em estágios válidos do funil');

select is(
  (select count(*)::int from public.board_stages
    where id in ('e1000000-0000-4000-8000-000000000201',
                 'e1000000-0000-4000-8000-000000000202',
                 'e1000000-0000-4000-8000-000000000209')),
  0, 'Estágios antigos foram removidos');

select is(
  (select jsonb_object_agg(d.title, s.name) from public.deals d
     join public.board_stages s on s.id = d.stage_id
    where d.board_id = 'e1000000-0000-4000-8000-000000000101'),
  jsonb_build_object(
    'Negócio no estágio 1', 'Novo lead',
    'Negócio no estágio 2', 'Qualificação',
    'Negócio sem par de posição', 'Novo lead'),
  'Remapeamento por posição, com fallback no primeiro estágio aberto');

-- (c) Trilha de auditoria para cada negócio remapeado.
select is(
  (select count(distinct h.deal_id)::int from public.deal_stage_history h
    where h.deal_id in ('e1000000-0000-4000-8000-000000000301',
                        'e1000000-0000-4000-8000-000000000302',
                        'e1000000-0000-4000-8000-000000000309')
      and h.from_stage_id in ('e1000000-0000-4000-8000-000000000201',
                              'e1000000-0000-4000-8000-000000000202',
                              'e1000000-0000-4000-8000-000000000209')
      and h.to_stage_id = (select stage_id from public.deals where id = h.deal_id)),
  3, 'deal_stage_history registra a troca de cada negócio');

select ok(
  (select bool_and(
            h.actor_type = 'human'
        and h.actor_id = 'e1000000-0000-4000-8000-000000000011'
        and h.changed_by_user_id = 'e1000000-0000-4000-8000-000000000011'
        and h.trigger_event = 'apply_niche_template'
        and h.reason is not null)
     from public.deal_stage_history h
    where h.deal_id in ('e1000000-0000-4000-8000-000000000301',
                        'e1000000-0000-4000-8000-000000000302',
                        'e1000000-0000-4000-8000-000000000309')),
  'Histórico identifica o admin, o motivo e a origem (apply_niche_template)');

-- (d) Guard intacto: UPDATE direto segue bloqueado na mesma transação.
select throws_ok(
  $$update public.deals
       set stage_id = (select id from public.board_stages
                        where board_id = 'e1000000-0000-4000-8000-000000000101'
                          and name = 'Proposta')
     where id = 'e1000000-0000-4000-8000-000000000301'$$,
  '42501', 'Deal stage changes must use transition_deal_stage()',
  'UPDATE direto em deals.stage_id continua bloqueado pelo guard');

select is(
  nullif(current_setting('app.deal_stage_transition_context', true), ''),
  null, 'Contexto de transição não vaza para fora da função');

-- (e) Admin de outro tenant não aplica no funil alheio.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000012","role":"authenticated"}', true);

select throws_ok(
  $$select public.apply_niche_template(
      'e1000000-0000-4000-8000-000000000101', t.slug, t.base_prompt, t.stages, t.stage_prompts)
      from public.niche_templates t where t.slug = 'clinica-odontologica'$$,
  'P0001', 'invalid_board', 'Admin de outro tenant é barrado');

reset role;
select is(
  (select count(*)::int from public.board_stages
    where board_id = 'e1000000-0000-4000-8000-000000000101'),
  6, 'Funil alheio segue com os estágios do modelo aplicado pelo dono');

-- (f) Funil sem negócios continua funcionando. Cada RPC do app é uma
-- transação própria (ON COMMIT DROP); aqui as chamadas dividem a transação.
drop table if exists pg_temp._new_stages;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000011","role":"authenticated"}', true);

select lives_ok(
  $$select public.apply_niche_template(
      'e1000000-0000-4000-8000-000000000102', t.slug, t.base_prompt, t.stages, t.stage_prompts)
      from public.niche_templates t where t.slug = 'generico'$$,
  'Admin aplica o modelo em funil sem negócios');

reset role;

select * from finish();
rollback;
