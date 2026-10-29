begin;
create extension if not exists pgtap;
select plan(21);

-- O cadastro real cria tenant, perfil admin e membership. Tudo sofre rollback.
insert into auth.users(id, email) values
  ('f2110000-0000-4000-8000-000000000001', 'comportamento-admin@test.local'),
  ('f2110000-0000-4000-8000-000000000002', 'comportamento-outro@test.local');
select set_config('teste.tenant_ia', (select tenant_id::text from public.profiles where id = 'f2110000-0000-4000-8000-000000000001'), true);
select set_config('teste.outro_tenant_ia', (select tenant_id::text from public.profiles where id = 'f2110000-0000-4000-8000-000000000002'), true);
insert into public.ai_settings(tenant_id) values
  (current_setting('teste.tenant_ia')::uuid),
  (current_setting('teste.outro_tenant_ia')::uuid)
on conflict do nothing;

select is((select max_response_blocks from public.ai_settings where tenant_id = current_setting('teste.tenant_ia')::uuid), 1, 'sem configuração mantém um bloco');
select is((select response_block_delay_ms from public.ai_settings where tenant_id = current_setting('teste.tenant_ia')::uuid), 1200, 'intervalo padrão mantém 1200 ms');
select is((select message_coalesce_window_ms from public.ai_settings where tenant_id = current_setting('teste.tenant_ia')::uuid), 3000, 'agrupamento padrão mantém 3000 ms');

select throws_ok($$update public.ai_settings set max_response_blocks = 0 where tenant_id = current_setting('teste.tenant_ia')::uuid$$, '23514', null, 'rejeita zero blocos');
select throws_ok($$update public.ai_settings set max_response_blocks = 6 where tenant_id = current_setting('teste.tenant_ia')::uuid$$, '23514', null, 'rejeita seis blocos');
select throws_ok($$update public.ai_settings set response_block_delay_ms = -1 where tenant_id = current_setting('teste.tenant_ia')::uuid$$, '23514', null, 'rejeita intervalo negativo');
select throws_ok($$update public.ai_settings set response_block_delay_ms = 10001 where tenant_id = current_setting('teste.tenant_ia')::uuid$$, '23514', null, 'rejeita intervalo acima de 10000 ms');
select throws_ok($$update public.ai_settings set message_coalesce_window_ms = -1 where tenant_id = current_setting('teste.tenant_ia')::uuid$$, '23514', null, 'rejeita janela negativa');
select throws_ok($$update public.ai_settings set message_coalesce_window_ms = 120001 where tenant_id = current_setting('teste.tenant_ia')::uuid$$, '23514', null, 'rejeita janela acima de 120000 ms');
select lives_ok($$update public.ai_settings set max_response_blocks = 5, response_block_delay_ms = 10000, message_coalesce_window_ms = 50000 where tenant_id = current_setting('teste.tenant_ia')::uuid$$, 'aceita cinco blocos com intervalo máximo no limite combinado de 90000 ms');
select throws_ok($$update public.ai_settings set max_response_blocks = 5, response_block_delay_ms = 10000, message_coalesce_window_ms = 50001 where tenant_id = current_setting('teste.tenant_ia')::uuid$$, '23514', null, 'rejeita combinação acima de 90000 ms mesmo com faixas individuais válidas');
select lives_ok($$update public.ai_settings set max_response_blocks = 1, response_block_delay_ms = 10000, message_coalesce_window_ms = 90000 where tenant_id = current_setting('teste.tenant_ia')::uuid$$, 'um bloco não reserva intervalo e aceita janela de 90000 ms');
select throws_ok($$update public.ai_settings set max_response_blocks = 1, response_block_delay_ms = 0, message_coalesce_window_ms = 90001 where tenant_id = current_setting('teste.tenant_ia')::uuid$$, '23514', null, 'rejeita janela que sozinha supera orçamento');
select throws_ok($$update public.ai_settings set max_response_blocks = 2, response_block_delay_ms = null, message_coalesce_window_ms = 90000 where tenant_id = current_setting('teste.tenant_ia')::uuid$$, '23514', null, 'null não contorna orçamento pois aplica intervalo padrão de 1200 ms');
select lives_ok($$update public.ai_settings set max_response_blocks = 1, response_block_delay_ms = 0, message_coalesce_window_ms = 0 where tenant_id = current_setting('teste.tenant_ia')::uuid$$, 'aceita mínimos inclusivos');
select lives_ok($$update public.ai_settings set max_response_blocks = null, response_block_delay_ms = null, message_coalesce_window_ms = null where tenant_id = current_setting('teste.tenant_ia')::uuid$$, 'null usa fallback do runtime');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f2110000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select results_eq($$update public.ai_settings set max_response_blocks = 3 where tenant_id = current_setting('teste.tenant_ia')::uuid returning max_response_blocks$$, $$values (3)$$, 'admin altera configuração do próprio tenant');
select is_empty($$update public.ai_settings set max_response_blocks = 4 where tenant_id = current_setting('teste.outro_tenant_ia')::uuid returning tenant_id$$, 'admin não altera configuração de outro tenant');
select is_empty($$select tenant_id from public.ai_settings where tenant_id = current_setting('teste.outro_tenant_ia')::uuid$$, 'admin não lê configuração de outro tenant');
select throws_ok($$insert into public.ai_settings(tenant_id, max_response_blocks) values (current_setting('teste.outro_tenant_ia')::uuid, 4)$$, '42501', null, 'admin não insere configuração em outro tenant');
reset role;
select ok(not has_table_privilege('anon', 'public.ai_settings', 'UPDATE'), 'anon não pode editar configuração');

select * from finish();
rollback;
