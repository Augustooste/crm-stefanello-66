-- MVP ElevenLabs: lifecycle persistido e bucket privado por tenant.
begin;
create extension if not exists pgtap;

select plan(9);

insert into auth.users (id, email)
values
  ('e1000000-0000-0000-0000-000000000001', 'audio-a@test.local'),
  ('e1000000-0000-0000-0000-000000000002', 'audio-b@test.local');

insert into public.contacts (id, tenant_id, name)
select 'e2000000-0000-0000-0000-000000000001', tenant_id, 'Lead áudio'
from public.profiles
where id = 'e1000000-0000-0000-0000-000000000001';

insert into public.channels (id, tenant_id, type, provider_slug, status)
select
  'e3000000-0000-0000-0000-000000000001',
  tenant_id,
  'whatsapp',
  'zapi',
  'connected'
from public.profiles
where id = 'e1000000-0000-0000-0000-000000000001';

insert into public.conversations (id, tenant_id, contact_id, channel_id)
select
  'e4000000-0000-0000-0000-000000000001',
  tenant_id,
  'e2000000-0000-0000-0000-000000000001',
  'e3000000-0000-0000-0000-000000000001'
from public.profiles
where id = 'e1000000-0000-0000-0000-000000000001';

insert into public.messages (
  id, tenant_id, conversation_id, direction, sender, content
)
select
  'e5000000-0000-0000-0000-000000000001',
  tenant_id,
  'e4000000-0000-0000-0000-000000000001',
  'out',
  'ai',
  'Resposta falada'
from public.profiles
where id = 'e1000000-0000-0000-0000-000000000001';

select is(
  (select audio_status from public.messages where id = 'e5000000-0000-0000-0000-000000000001'),
  'not_requested',
  'mensagem sem voz começa com status not_requested'
);

select is(
  (select public from storage.buckets where id = 'ai-audio'),
  false,
  'bucket de áudio da IA é privado'
);

select is(
  (select file_size_limit from storage.buckets where id = 'ai-audio'),
  16777216::bigint,
  'bucket limita cada MP3 a 16 MB'
);

-- O bucket guarda dois tipos de áudio: a resposta da IA (MP3, TTS) e a nota de
-- voz recebida do lead, decifrada do WhatsApp (OGG/Opus). Reverter esta lista
-- para só `audio/mpeg` derruba o áudio de entrada em silêncio: o Storage recusa
-- o upload, o re-hospedamento desiste e a IA volta a responder "não consigo
-- ouvir áudios" — foi o incidente de 2026-08-05.
select is(
  (select allowed_mime_types from storage.buckets where id = 'ai-audio'),
  array['audio/mpeg', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/amr'],
  'bucket aceita o MP3 do TTS e o OGG recebido do WhatsApp'
);

select throws_ok(
  $$
    update public.messages
    set audio_status = 'unknown'
    where id = 'e5000000-0000-0000-0000-000000000001'
  $$,
  '23514',
  null,
  'lifecycle rejeita status desconhecido'
);

select throws_ok(
  $$
    update public.messages
    set audio_bytes = 16777217
    where id = 'e5000000-0000-0000-0000-000000000001'
  $$,
  '23514',
  null,
  'lifecycle rejeita áudio acima de 16 MB'
);

select throws_ok(
  $$
    update public.messages
    set audio_storage_path = '00000000-0000-0000-0000-000000000000/conv/audio.mp3'
    where id = 'e5000000-0000-0000-0000-000000000001'
  $$,
  '23514',
  null,
  'mensagem rejeita objeto de áudio com prefixo de outro tenant'
);

insert into storage.objects (bucket_id, name)
select 'ai-audio', tenant_id::text || '/conv-a/msg-a.mp3'
from public.profiles
where id = 'e1000000-0000-0000-0000-000000000001';

insert into storage.objects (bucket_id, name)
select 'ai-audio', tenant_id::text || '/conv-b/msg-b.mp3'
from public.profiles
where id = 'e1000000-0000-0000-0000-000000000002';

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"e1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select is(
  (select count(*)::int from storage.objects where bucket_id = 'ai-audio'),
  1,
  'tenant A lê somente o próprio áudio'
);
reset role;

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"e1000000-0000-0000-0000-000000000002","role":"authenticated"}';
select is(
  (select count(*)::int from storage.objects where bucket_id = 'ai-audio'),
  1,
  'tenant B lê somente o próprio áudio'
);
reset role;

select * from finish();
rollback;
