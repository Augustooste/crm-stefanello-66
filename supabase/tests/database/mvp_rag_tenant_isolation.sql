-- MVP RAG: isolamento estrutural e de execução entre tenants.
begin;
create extension if not exists pgtap;

select plan(8);

insert into auth.users (id, email) values
  ('c1000000-0000-0000-0000-000000000001', 'rag-a@test.local'),
  ('d1000000-0000-0000-0000-000000000001', 'rag-b@test.local');

insert into public.kb_documents (
  id, tenant_id, title, source_type, mime_type, bytes, content_hash,
  source_text, status, chunk_count
)
select
  'c2000000-0000-0000-0000-000000000001',
  tenant_id,
  'Documento tenant A',
  'text',
  'text/plain',
  20,
  repeat('a', 64),
  'Preço do plano A',
  'ready',
  1
from public.profiles
where id = 'c1000000-0000-0000-0000-000000000001';

insert into public.kb_documents (
  id, tenant_id, title, source_type, mime_type, bytes, content_hash,
  source_text, status, chunk_count
)
select
  'd2000000-0000-0000-0000-000000000001',
  tenant_id,
  'Documento tenant B',
  'text',
  'text/plain',
  20,
  repeat('a', 64),
  'Preço do plano B',
  'ready',
  1
from public.profiles
where id = 'd1000000-0000-0000-0000-000000000001';

insert into public.kb_chunks (
  tenant_id, document_id, chunk_index, content, token_count, embedding
)
select
  tenant_id,
  'c2000000-0000-0000-0000-000000000001',
  0,
  'O plano A custa R$ 99.',
  6,
  array_fill(1::real, array[768])::extensions.vector
from public.profiles
where id = 'c1000000-0000-0000-0000-000000000001';

insert into public.kb_chunks (
  tenant_id, document_id, chunk_index, content, token_count, embedding
)
select
  tenant_id,
  'd2000000-0000-0000-0000-000000000001',
  0,
  'O plano B custa R$ 199.',
  6,
  array_fill(1::real, array[768])::extensions.vector
from public.profiles
where id = 'd1000000-0000-0000-0000-000000000001';

select isnt(
  (select tenant_id from public.kb_documents where id = 'c2000000-0000-0000-0000-000000000001'),
  (select tenant_id from public.kb_documents where id = 'd2000000-0000-0000-0000-000000000001'),
  'fixtures pertencem a tenants distintos'
);

select is(
  (select count(*)::integer from public.kb_documents where content_hash = repeat('a', 64)),
  2,
  'o mesmo hash pode existir uma vez em cada tenant'
);

select throws_ok(
  $$
    insert into public.kb_documents (
      tenant_id, title, source_type, mime_type, bytes, content_hash, source_text
    )
    select tenant_id, 'Duplicado', 'text', 'text/plain', 5, repeat('a', 64), 'outro'
    from public.profiles
    where id = 'c1000000-0000-0000-0000-000000000001'
  $$,
  '23505',
  null,
  'dedupe rejeita o mesmo conteúdo dentro do tenant'
);

select throws_ok(
  $$
    insert into public.kb_chunks (
      tenant_id, document_id, chunk_index, content, token_count, embedding
    )
    select
      tenant_id,
      'c2000000-0000-0000-0000-000000000001',
      9,
      'tentativa cross-tenant',
      3,
      array_fill(1::real, array[768])::extensions.vector
    from public.profiles
    where id = 'd1000000-0000-0000-0000-000000000001'
  $$,
  '23503',
  null,
  'FK composta bloqueia chunk ligado a documento de outro tenant'
);

select is(
  (
    select count(*)::integer
    from public.kb_search_for_tenant(
      (select tenant_id from public.profiles where id = 'c1000000-0000-0000-0000-000000000001'),
      array_fill(1::real, array[768])::extensions.vector,
      5,
      0
    )
  ),
  1,
  'busca service-role retorna somente chunks do tenant informado'
);

select is(
  (
    select document_title
    from public.kb_search_for_tenant(
      (select tenant_id from public.profiles where id = 'c1000000-0000-0000-0000-000000000001'),
      array_fill(1::real, array[768])::extensions.vector,
      5,
      0
    )
    limit 1
  ),
  'Documento tenant A',
  'busca do tenant A não vaza título ou conteúdo do tenant B'
);

select is(
  has_table_privilege('authenticated', 'public.kb_chunks', 'SELECT'),
  false,
  'frontend não lê chunks/embeddings diretamente'
);

delete from public.kb_documents
where id = 'c2000000-0000-0000-0000-000000000001';

select is(
  (
    select count(*)::integer
    from public.kb_chunks
    where document_id = 'c2000000-0000-0000-0000-000000000001'
  ),
  0,
  'exclusão do documento remove chunks e embeddings antigos em cascata'
);

select * from finish();
rollback;
