begin;
select plan(12);
create temp table ctx as
select (select id from profiles where name ilike 'Viviane%') v,
       (select id from profiles where name ilike 'Jaime%') j,
       (select id from profiles where name ilike 'Júnior%') jr,
       (select tenant_id from profiles where name ilike 'Viviane%') t,
       (select s.id from board_stages s join boards b on b.id=s.board_id where b.board_key='main' and s.stage_key='lead_novo' and b.tenant_id=(select tenant_id from profiles where name ilike 'Viviane%')) st,
       (select b.id from boards b where b.board_key='main' and b.tenant_id=(select tenant_id from profiles where name ilike 'Viviane%')) bd;
grant select on ctx to authenticated;
create temp table res(k text, c uuid);
grant all on res to authenticated;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub',(select v from ctx),'role','authenticated')::text, true);
with c as (insert into contacts(tenant_id,name,address_state,address_city) select t,'pg viv RS','RS','Passo Fundo' from ctx returning id) insert into res select 'vrs', id from c;
with c as (insert into contacts(tenant_id,name,address_state,address_city) select t,'pg viv PR','PR','Curitiba' from ctx returning id) insert into res select 'vpr', id from c;
select lives_ok($$insert into deals(tenant_id,title,contact_id,board_id,stage_id) select t,'pg viv RS',(select c from res where k='vrs'),bd,st from ctx returning id$$, 'Viviane cria negócio RS com RETURNING');
select lives_ok($$insert into deals(tenant_id,title,contact_id,board_id,stage_id) select t,'pg viv PR',(select c from res where k='vpr'),bd,st from ctx returning id$$, 'Viviane cria negócio PR com RETURNING');
select is((select owner_id from contacts where id=(select c from res where k='vrs')), (select v from ctx), 'contato RS fica da Viviane');
select is((select opened_by::text||client_origin from contacts where id=(select c from res where k='vrs')), (select v::text from ctx)||'prospeccao_propria', 'RS: aberto por ela, prospecção própria');
select is((select out_of_area from contacts where id=(select c from res where k='vpr')), true, 'PR vai para fora da área');
select is((select owner_id from contacts where id=(select c from res where k='vpr')), (select v from ctx), 'PR continua dela');
select is((select count(*)::int from deals where title like 'pg viv%' and owner_id=(select v from ctx)), 2, 'negócios ficam dela');
select set_config('request.jwt.claims', json_build_object('sub',(select j from ctx),'role','authenticated')::text, true);
with c as (insert into contacts(tenant_id,name,address_state,address_city) select t,'pg j RS','RS','Passo Fundo' from ctx returning id) insert into res select 'jrs', id from c;
with c as (insert into contacts(tenant_id,name,address_state,address_city) select t,'pg j SC','SC','Itajaí' from ctx returning id) insert into res select 'jsc', id from c;
insert into deals(tenant_id,title,contact_id,board_id,stage_id) select t,'pg j RS',(select c from res where k='jrs'),bd,st from ctx;
insert into deals(tenant_id,title,contact_id,board_id,stage_id) select t,'pg j SC',(select c from res where k='jsc'),bd,st from ctx;
select is((select owner_id from contacts where id=(select c from res where k='jrs')), (select v from ctx), 'Jaime RS → Viviane');
select is((select client_origin::text from contacts where id=(select c from res where k='jrs')), 'lead_empresa', 'Jaime RS → lead_empresa');
select is((select owner_id from deals where title='pg j RS'), (select v from ctx), 'negócio RS → Viviane');
select is((select owner_id from contacts where id=(select c from res where k='jsc')), (select jr from ctx), 'Jaime SC → Júnior');
select is((select owner_id from deals where title='pg j SC'), (select jr from ctx), 'negócio SC → Júnior');
select * from finish();
rollback;
