-- Run in the Supabase SQL editor after the migrations. Every row should say true.
select c.relname as table_name, c.relrowsecurity as rls_enabled
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' order by 1;

-- Anonymous users must hold no privileges on any table (expect zero rows):
select table_name, privilege_type from information_schema.role_table_grants
where table_schema = 'public' and grantee = 'anon';

-- Nobody but service_role should be able to see profile secrets (expect only id, username, created_at):
select column_name from information_schema.column_privileges
where table_schema = 'public' and table_name = 'profiles' and grantee = 'authenticated';

-- Functions callable by anonymous users in public (expect zero rows):
select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute');
