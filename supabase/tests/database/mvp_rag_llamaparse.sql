-- MVP RAG: schema, privilégios das RPCs e isolamento semântico por tenant.
begin;
create extension if not exists pgtap;

select plan(23);

select has_table('public', 'kb_documents', 'kb_documents existe');
select has_table('public', 'kb_chunks', 'kb_chunks existe');
select col_type_is(
  'public',
  'kb_chunks',
  'embedding',
  'extensions.vector(768)',
  'embedding tem 768 dimensões'
);

select is(
  (select relrowsecurity from pg_class where oid = 'public.kb_documents'::regclass),
  true,
  'kb_documents tem RLS'
);
select is(
  (select relrowsecurity from pg_class where oid = 'public.kb_chunks'::regclass),
  true,
  'kb_chunks tem RLS'
);
select ok(
  exists (
    select 1
    from pg_constraint
    where conrelid = 'public.kb_chunks'::regclass
      and conname = 'kb_chunks_document_same_tenant'
      and array_length(conkey, 1) = 2
      and array_length(confkey, 1) = 2
  ),
  'FK composta impede chunk ligado a documento de outro tenant'
);
select ok(
  exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and indexname = 'kb_documents_tenant_content_hash_uniq'
  ),
  'dedupe é único por tenant e hash'
);
select ok(
  exists (
    select 1
    from public.integrations
    where slug = 'llamacloud'
      and available
      and required_secrets @> '[{"key":"api_key"},{"key":"region"}]'::jsonb
  ),
  'catálogo expõe API key e região do LlamaCloud'
);
select is(
  (
    select default_enabled
    from public.ai_feature_catalog
    where feature_key = 'knowledge_rag'
  ),
  false,
  'RAG nasce desligado por padrão'
);
select is(
  (
    select toggle_authority
    from public.ai_feature_catalog
    where feature_key = 'knowledge_rag'
  ),
  'tenant_admin',
  'admin do tenant pode ligar o RAG pela propria tela'
);

select is(
  (select prosecdef from pg_proc where oid = 'public.replace_kb_chunks(uuid,uuid,jsonb)'::regprocedure),
  true,
  'replace_kb_chunks é SECURITY DEFINER'
);
select is(
  (
    select prosecdef
    from pg_proc
    where oid =
      'public.kb_search_for_tenant(uuid,extensions.vector,integer,real)'::regprocedure
  ),
  true,
  'kb_search_for_tenant é SECURITY DEFINER'
);
select ok(
  (
    select coalesce(proconfig, '{}'::text[]) @> array['hnsw.iterative_scan=relaxed_order']
    from pg_proc
    where oid =
      'public.kb_search_for_tenant(uuid,extensions.vector,integer,real)'::regprocedure
  ),
  'busca semântica força iterative_scan para preservar recall por tenant'
);
select is(
  has_function_privilege(
    'anon',
    'public.kb_search_for_tenant(uuid,extensions.vector,integer,real)',
    'execute'
  ),
  false,
  'anon não executa busca semântica'
);
select is(
  has_function_privilege(
    'authenticated',
    'public.kb_search_for_tenant(uuid,extensions.vector,integer,real)',
    'execute'
  ),
  false,
  'authenticated não escolhe tenant na RPC'
);
select is(
  has_function_privilege(
    'service_role',
    'public.kb_search_for_tenant(uuid,extensions.vector,integer,real)',
    'execute'
  ),
  true,
  'service_role executa busca semântica'
);
select is(
  has_table_privilege('authenticated', 'public.kb_chunks', 'select'),
  false,
  'authenticated não lê chunks diretamente'
);

insert into auth.users (id, email) values
  ('ca000000-0000-4000-8000-000000000001', 'rag-a@test.local'),
  ('cb000000-0000-4000-8000-000000000001', 'rag-b@test.local');

insert into public.kb_documents (
  id, tenant_id, title, source_type, mime_type, bytes, content_hash, source_text, status
)
select
  'da000000-0000-4000-8000-000000000001',
  tenant_id,
  'FAQ tenant A',
  'text',
  'text/plain',
  12,
  repeat('a', 64),
  'Preço do tenant A',
  'ready'
from public.profiles
where id = 'ca000000-0000-4000-8000-000000000001';

insert into public.kb_documents (
  id, tenant_id, title, source_type, mime_type, bytes, content_hash, source_text, status
)
select
  'db000000-0000-4000-8000-000000000001',
  tenant_id,
  'FAQ tenant B',
  'text',
  'text/plain',
  12,
  repeat('b', 64),
  'Preço do tenant B',
  'ready'
from public.profiles
where id = 'cb000000-0000-4000-8000-000000000001';

select throws_ok(
  format(
    $sql$
      insert into public.kb_documents (
        tenant_id, title, source_type, mime_type, bytes, content_hash, source_text
      ) values (%L, 'Duplicado', 'text', 'text/plain', 1, %L, 'x')
    $sql$,
    (
      select tenant_id
      from public.profiles
      where id = 'ca000000-0000-4000-8000-000000000001'
    ),
    repeat('a', 64)
  ),
  '23505',
  null,
  'mesmo conteúdo não duplica dentro do tenant'
);

select is(
  public.replace_kb_chunks(
    (
      select tenant_id
      from public.profiles
      where id = 'ca000000-0000-4000-8000-000000000001'
    ),
    'da000000-0000-4000-8000-000000000001',
    jsonb_build_array(
      jsonb_build_object(
        'chunk_index', 0,
        'content', 'O plano A custa R$ 99.',
        'token_count', 7,
        'embedding', format(
          '[%s]',
          array_to_string(array_fill(1::integer, array[768]), ',')
        )
      )
    )
  ),
  1,
  'replace_kb_chunks grava um lote válido'
);

select is(
  public.replace_kb_chunks(
    (
      select tenant_id
      from public.profiles
      where id = 'cb000000-0000-4000-8000-000000000001'
    ),
    'db000000-0000-4000-8000-000000000001',
    jsonb_build_array(
      jsonb_build_object(
        'chunk_index', 0,
        'content', 'O plano B custa R$ 199.',
        'token_count', 7,
        'embedding', format(
          '[%s]',
          array_to_string(array_fill(1::integer, array[768]), ',')
        )
      )
    )
  ),
  1,
  'tenant B recebe seu próprio índice'
);

select is(
  (
    select document_title
    from public.kb_search_for_tenant(
      (
        select tenant_id
        from public.profiles
        where id = 'ca000000-0000-4000-8000-000000000001'
      ),
      array_fill(1::real, array[768])::extensions.vector(768),
      8,
      0.25
    )
    limit 1
  ),
  'FAQ tenant A',
  'busca do tenant A não retorna documento B'
);
select is(
  (
    select document_title
    from public.kb_search_for_tenant(
      (
        select tenant_id
        from public.profiles
        where id = 'cb000000-0000-4000-8000-000000000001'
      ),
      array_fill(1::real, array[768])::extensions.vector(768),
      8,
      0.25
    )
    limit 1
  ),
  'FAQ tenant B',
  'busca do tenant B não retorna documento A'
);

delete from public.kb_documents
where id = 'da000000-0000-4000-8000-000000000001';

select is(
  (
    select count(*)::integer
    from public.kb_chunks
    where document_id = 'da000000-0000-4000-8000-000000000001'
  ),
  0,
  'excluir documento remove chunks em cascata'
);

select * from finish();
rollback;
