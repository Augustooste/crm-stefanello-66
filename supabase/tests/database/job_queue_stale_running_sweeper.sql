-- Recuperação de job travado em 'running' (migration
-- 20260730220000_claim_jobs_recupera_running_travado.sql).
--
-- O que estas asserções protegem: sem o ramo novo do claim_jobs, um job que
-- ficou 'running' porque o isolate morreu no meio do dispatch nunca mais é
-- reivindicado por ninguém — a mensagem inbound do lead some sem rastro. Os
-- testes 1/2 falham contra a versão antiga da função (ela só enxerga
-- status='pending'); os testes 3 a 6 são as guardas que impedem o fix de virar
-- um sweeper agressivo demais.
begin;
create extension if not exists pgtap;

select plan(8);

-- tenant_id fica nulo de propósito (a coluna é nullable, para jobs de
-- plataforma): evita depender de fixture de tenant e de RLS.
insert into public.job_queue (id, tenant_id, job_type, status, payload, scheduled_for, attempts, max_attempts, started_at)
values
  -- 1. Travado: morto há muito mais que o teto de 150s do isolate.
  ('11111111-1111-4111-8111-111111111111', null, 'ai_respond', 'running',
   '{"message_id": "msg-travado"}'::jsonb, now() - interval '20 minutes', 1, 3, now() - interval '15 minutes'),
  -- 2. Travado com started_at nulo (o coalesce tem que enxergar via created_at).
  ('22222222-2222-4222-8222-222222222222', null, 'ai_respond', 'running',
   '{"message_id": "msg-sem-started-at"}'::jsonb, now() - interval '20 minutes', 1, 3, null),
  -- 3. Vivo: começou agora, um worker real pode estar rodando.
  ('33333333-3333-4333-8333-333333333333', null, 'ai_respond', 'running',
   '{"message_id": "msg-vivo"}'::jsonb, now() - interval '1 minute', 1, 3, now() - interval '30 seconds'),
  -- 4. Travado mas com tentativas esgotadas: não pode reivindicar para sempre.
  ('44444444-4444-4444-8444-444444444444', null, 'ai_respond', 'running',
   '{"message_id": "msg-esgotado"}'::jsonb, now() - interval '20 minutes', 3, 3, now() - interval '15 minutes'),
  -- 5. Pendente agendado para o futuro: comportamento antigo, não pode mudar.
  ('55555555-5555-4555-8555-555555555555', null, 'ai_respond', 'pending',
   '{"message_id": "msg-futuro"}'::jsonb, now() + interval '10 minutes', 0, 3, null),
  -- 6. Travado de OUTRO job_type: o filtro por tipo continua valendo.
  ('66666666-6666-4666-8666-666666666666', null, 'nurture_step', 'running',
   '{"step": 1}'::jsonb, now() - interval '20 minutes', 1, 3, now() - interval '15 minutes');

-- created_at tem default now(); o job 2 precisa de created_at antigo para o
-- coalesce cair fora da janela de 5 minutos.
update public.job_queue
set created_at = now() - interval '20 minutes'
where id = '22222222-2222-4222-8222-222222222222';

create temp table claimed_ids as
select id from public.claim_jobs(50, array['ai_respond']);

select ok(
  exists (select 1 from claimed_ids where id = '11111111-1111-4111-8111-111111111111'),
  'job running travado ha 15 min e reivindicado'
);

select ok(
  exists (select 1 from claimed_ids where id = '22222222-2222-4222-8222-222222222222'),
  'job running com started_at nulo e reivindicado pelo created_at'
);

select ok(
  not exists (select 1 from claimed_ids where id = '33333333-3333-4333-8333-333333333333'),
  'job running recente NAO e roubado de um worker vivo'
);

select ok(
  not exists (select 1 from claimed_ids where id = '44444444-4444-4444-8444-444444444444'),
  'job running travado com attempts = max_attempts NAO e reivindicado de novo'
);

select ok(
  not exists (select 1 from claimed_ids where id = '55555555-5555-4555-8555-555555555555'),
  'job pending agendado para o futuro continua fora do claim'
);

select ok(
  not exists (select 1 from claimed_ids where id = '66666666-6666-4666-8666-666666666666'),
  'filtro por job_type continua valendo para o ramo running'
);

-- A reivindicação tem que reescrever started_at e somar tentativa, senão o
-- mesmo job seria varrido em looping a cada minuto.
select ok(
  (
    select started_at > now() - interval '1 minute' and attempts = 2
    from public.job_queue
    where id = '11111111-1111-4111-8111-111111111111'
  ),
  'reivindicacao reinicia started_at e incrementa attempts'
);

select ok(
  exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'job_queue_stale_running_idx'
  ),
  'existe indice parcial para a varredura de running'
);

select * from finish();
rollback;
