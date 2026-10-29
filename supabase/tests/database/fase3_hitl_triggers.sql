-- Fase 3 HITL — comportamento dos triggers de handoff durável
-- (trg_conversations_open_handoff / trg_messages_close_handoff).
-- Cobre o desvio #4 documentado na migration: sender='agent' AND
-- direction='out' fecha o handoff -- NÃO 'sender != ai' (schema real não
-- tem valor 'human'; usar isso fecharia o handoff quando o CONTATO manda
-- outra mensagem, o que é errado). Rodar: pnpm test:db.
begin;
create extension if not exists pgtap;

select plan(9);

-- Fixture: tenant + contato + canal + activity de handoff + conversa
-- (awaiting_human começa false).
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'admin-a@test.local');

insert into public.contacts (id, tenant_id, name)
select '66666666-6666-6666-6666-666666666666', tenant_id, 'Contato teste'
from public.profiles where id = '11111111-1111-1111-1111-111111111111';

insert into public.channels (id, tenant_id, type, provider_slug)
select 'cccccccc-1111-1111-1111-111111111111', tenant_id, 'whatsapp', 'test-channel'
from public.profiles where id = '11111111-1111-1111-1111-111111111111';

insert into public.activities (id, tenant_id, contact_id, type, title)
select 'dddddddd-1111-1111-1111-111111111111', tenant_id, '66666666-6666-6666-6666-666666666666',
  'task', 'Lead aguardando atendimento humano'
from public.profiles where id = '11111111-1111-1111-1111-111111111111';

insert into public.conversations (
  id, tenant_id, contact_id, channel_id, ai_active, awaiting_human, handoff_activity_id
)
select 'eeeeeeee-1111-1111-1111-111111111111', tenant_id, '66666666-6666-6666-6666-666666666666',
  'cccccccc-1111-1111-1111-111111111111', true, false, 'dddddddd-1111-1111-1111-111111111111'
from public.profiles where id = '11111111-1111-1111-1111-111111111111';

-- 1. Nenhum evento SLA aberto antes do handoff.
select is(
  (select count(*)::int from public.hitl_handoff_sla_events where conversation_id = 'eeeeeeee-1111-1111-1111-111111111111'),
  0,
  'nenhum evento SLA antes do handoff'
);

-- 2-3. Abrir handoff (awaiting_human false->true): seta awaiting_human_since
--      + abre 1 linha em hitl_handoff_sla_events (trg_conversations_open_handoff).
update public.conversations
  set ai_active = false, awaiting_human = true
  where id = 'eeeeeeee-1111-1111-1111-111111111111';

select ok(
  (select awaiting_human_since from public.conversations where id = 'eeeeeeee-1111-1111-1111-111111111111') is not null,
  'trg_conversations_open_handoff: seta awaiting_human_since'
);
select is(
  (select count(*)::int from public.hitl_handoff_sla_events
    where conversation_id = 'eeeeeeee-1111-1111-1111-111111111111' and resolved_at is null),
  1,
  'trg_conversations_open_handoff: abre exatamente 1 evento SLA'
);

-- 4. Mensagem do CONTATO (sender='contact') NÃO fecha o handoff -- valida o
--    desvio #4 (contato mandando outra mensagem não significa que um humano
--    respondeu).
insert into public.messages (tenant_id, conversation_id, direction, sender, content)
select tenant_id, 'eeeeeeee-1111-1111-1111-111111111111', 'in', 'contact', 'mais uma mensagem do lead'
from public.profiles where id = '11111111-1111-1111-1111-111111111111';

select is(
  (select awaiting_human from public.conversations where id = 'eeeeeeee-1111-1111-1111-111111111111'),
  true,
  'trg_messages_close_handoff: mensagem do contato NÃO fecha o handoff'
);

-- 5. Mensagem da IA (sender='ai', direction='out') também NÃO fecha --
--    handoff só fecha com um AGENTE humano respondendo.
insert into public.messages (tenant_id, conversation_id, direction, sender, content)
select tenant_id, 'eeeeeeee-1111-1111-1111-111111111111', 'out', 'ai', 'resposta indevida da IA'
from public.profiles where id = '11111111-1111-1111-1111-111111111111';

select is(
  (select awaiting_human from public.conversations where id = 'eeeeeeee-1111-1111-1111-111111111111'),
  true,
  'trg_messages_close_handoff: mensagem sender=ai/out NÃO fecha o handoff'
);

-- 6-9. Mensagem do AGENTE humano (sender='agent', direction='out') fecha:
--      conversation.awaiting_human=false, activity.completed_at preenchido,
--      evento SLA resolvido.
insert into public.messages (tenant_id, conversation_id, direction, sender, content)
select tenant_id, 'eeeeeeee-1111-1111-1111-111111111111', 'out', 'agent', 'atendente respondeu'
from public.profiles where id = '11111111-1111-1111-1111-111111111111';

select is(
  (select awaiting_human from public.conversations where id = 'eeeeeeee-1111-1111-1111-111111111111'),
  false,
  'trg_messages_close_handoff: mensagem sender=agent/out fecha awaiting_human'
);
select ok(
  (select awaiting_human_since from public.conversations where id = 'eeeeeeee-1111-1111-1111-111111111111') is null,
  'trg_messages_close_handoff: limpa awaiting_human_since'
);
select ok(
  (select completed_at from public.activities where id = 'dddddddd-1111-1111-1111-111111111111') is not null,
  'trg_messages_close_handoff: completa a activity do handoff'
);
select is(
  (select count(*)::int from public.hitl_handoff_sla_events
    where conversation_id = 'eeeeeeee-1111-1111-1111-111111111111' and resolved_at is not null),
  1,
  'trg_messages_close_handoff: resolve o evento SLA'
);

select * from finish();
rollback;
