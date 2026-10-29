begin;
create extension if not exists pgtap;
select plan(13);

-- O guard exige contexto de transição para mudar stage_id (ver transition_deal_stage()).
select set_config('app.deal_stage_transition_context', '{"source":"pgtap"}', true);

-- Fixture: tenant via profile (trigger de auth.users), board com etapas aberta/ganha/perdida.
insert into auth.users (id, email) values ('a2000000-0000-0000-0000-000000000001', 'deal-events@test.local');

insert into public.boards (id, tenant_id, name, is_default)
select 'b2000000-0000-0000-0000-000000000001', tenant_id, 'Funil Eventos', true
from public.profiles where id = 'a2000000-0000-0000-0000-000000000001';

insert into public.board_stages (id, board_id, name, position, is_won, is_lost) values
  ('c2000000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000001', 'Novo', 0, false, false),
  ('c2000000-0000-0000-0000-000000000002', 'b2000000-0000-0000-0000-000000000001', 'Ganho', 1, true, false),
  ('c2000000-0000-0000-0000-000000000003', 'b2000000-0000-0000-0000-000000000001', 'Perdido', 2, false, true);

-- Contato sem e-mail.
insert into public.contacts (id, tenant_id, name, phone)
select 'd2000000-0000-0000-0000-000000000001', tenant_id, 'Sem Email', '+5511999990000'
from public.profiles where id = 'a2000000-0000-0000-0000-000000000001';

insert into public.deals (id, tenant_id, board_id, stage_id, contact_id, title, value, status)
select 'e2000000-0000-0000-0000-000000000001', tenant_id,
  'b2000000-0000-0000-0000-000000000001', 'c2000000-0000-0000-0000-000000000001',
  'd2000000-0000-0000-0000-000000000001', 'Negócio A', 1500.50, 'open'
from public.profiles where id = 'a2000000-0000-0000-0000-000000000001';

select is((select count(*)::int from public.domain_events where event_type in ('deal.won','deal.lost')
  and aggregate_id = 'e2000000-0000-0000-0000-000000000001'), 0, 'negócio aberto não gera evento');

-- 1) mover para etapa ganha
update public.deals set stage_id = 'c2000000-0000-0000-0000-000000000002'
where id = 'e2000000-0000-0000-0000-000000000001';
select is((select count(*)::int from public.domain_events where event_type = 'deal.won'
  and aggregate_id = 'e2000000-0000-0000-0000-000000000001'), 1, 'etapa is_won gera 1 deal.won');

-- 2) payload com snapshot
select is((select payload #>> '{deal,title}' from public.domain_events where event_type = 'deal.won'
  and aggregate_id = 'e2000000-0000-0000-0000-000000000001'), 'Negócio A', 'payload.deal.title');
select is((select payload #>> '{deal,stage_name}' from public.domain_events where event_type = 'deal.won'
  and aggregate_id = 'e2000000-0000-0000-0000-000000000001'), 'Ganho', 'payload.deal.stage_name');
select is((select payload #>> '{contact,id}' from public.domain_events where event_type = 'deal.won'
  and aggregate_id = 'e2000000-0000-0000-0000-000000000001'), 'd2000000-0000-0000-0000-000000000001',
  'payload.contact.id presente mesmo sem e-mail');
select ok((select payload -> 'contact' -> 'email' from public.domain_events where event_type = 'deal.won'
  and aggregate_id = 'e2000000-0000-0000-0000-000000000001') = 'null'::jsonb, 'payload.contact.email é null explícito');

-- 3) mesma transição repetida (status já won) continua 1
update public.deals set title = 'Negócio A', value = 1500.50 where id = 'e2000000-0000-0000-0000-000000000001';
update public.deals set status = 'won' where id = 'e2000000-0000-0000-0000-000000000001';
select is((select count(*)::int from public.domain_events where event_type = 'deal.won'
  and aggregate_id = 'e2000000-0000-0000-0000-000000000001'), 1, 'repetir won não duplica');

-- 4) reabrir e ganhar de novo com novo closed_at => 2º evento
update public.deals set status = 'open', closed_at = null where id = 'e2000000-0000-0000-0000-000000000001';
update public.deals set status = 'won', closed_at = now() + interval '1 minute'
where id = 'e2000000-0000-0000-0000-000000000001';
select is((select count(*)::int from public.domain_events where event_type = 'deal.won'
  and aggregate_id = 'e2000000-0000-0000-0000-000000000001'), 2, 'reabrir e ganhar de novo gera 2º evento');

-- 5) INSERT direto com status won
insert into public.deals (id, tenant_id, board_id, stage_id, contact_id, title, status)
select 'e2000000-0000-0000-0000-000000000002', tenant_id,
  'b2000000-0000-0000-0000-000000000001', 'c2000000-0000-0000-0000-000000000002',
  'd2000000-0000-0000-0000-000000000001', 'Negócio B', 'won'
from public.profiles where id = 'a2000000-0000-0000-0000-000000000001';
select is((select count(*)::int from public.domain_events where event_type = 'deal.won'
  and aggregate_id = 'e2000000-0000-0000-0000-000000000002'), 1, 'INSERT com status won gera 1 evento');

-- 6) etapa perdida
update public.deals set stage_id = 'c2000000-0000-0000-0000-000000000003'
where id = 'e2000000-0000-0000-0000-000000000002';
select is((select count(*)::int from public.domain_events where event_type = 'deal.lost'
  and aggregate_id = 'e2000000-0000-0000-0000-000000000002'), 1, 'etapa is_lost gera 1 deal.lost');

-- 7) chave de idempotência
select matches((select idempotency_key from public.domain_events where event_type = 'deal.lost'
  and aggregate_id = 'e2000000-0000-0000-0000-000000000002'),
  '^deal\.lost:v1:e2000000-0000-0000-0000-000000000002:\d+$', 'formato da idempotency_key');

-- 8) contato apagado (soft delete) ou mesclado não sai no payload: contact vira null.
insert into public.contacts (id, tenant_id, name, email, deleted_at)
select 'd2000000-0000-0000-0000-000000000002', tenant_id, 'Apagado', 'apagado@test.local', now()
from public.profiles where id = 'a2000000-0000-0000-0000-000000000001';
insert into public.contacts (id, tenant_id, name, email, merged_into_id)
select 'd2000000-0000-0000-0000-000000000003', tenant_id, 'Mesclado', 'mesclado@test.local',
  'd2000000-0000-0000-0000-000000000001'
from public.profiles where id = 'a2000000-0000-0000-0000-000000000001';
insert into public.deals (id, tenant_id, board_id, stage_id, contact_id, title, status)
select v.deal_id::uuid, p.tenant_id, 'b2000000-0000-0000-0000-000000000001',
  'c2000000-0000-0000-0000-000000000002', v.contact_id::uuid, v.title, 'won'
from public.profiles p
cross join (values
  ('e2000000-0000-0000-0000-000000000003', 'd2000000-0000-0000-0000-000000000002', 'Negócio C'),
  ('e2000000-0000-0000-0000-000000000004', 'd2000000-0000-0000-0000-000000000003', 'Negócio D')
) v(deal_id, contact_id, title)
where p.id = 'a2000000-0000-0000-0000-000000000001';
select ok((select payload -> 'contact' from public.domain_events where event_type = 'deal.won'
  and aggregate_id = 'e2000000-0000-0000-0000-000000000003') = 'null'::jsonb, 'contato apagado: payload.contact é null');
select ok((select payload -> 'contact' from public.domain_events where event_type = 'deal.won'
  and aggregate_id = 'e2000000-0000-0000-0000-000000000004') = 'null'::jsonb, 'contato mesclado: payload.contact é null');

select * from finish();
rollback;
