-- Catalog fingerprint of the public schema: one row per object as
-- (kind, name, detail), so two databases can be diffed row by row.
--
-- Read-only. To fingerprint the live database: paste this whole file into the
-- Supabase SQL editor, run it, then "Export" -> "Download CSV". Compare with
--   node scripts/schema-fingerprint.js diff <live.csv> <other.csv>
-- Locally, `node scripts/schema-fingerprint.js build ...` runs this same file
-- in PGlite. It must stay valid on Postgres 15 to 18.
--
-- Objects owned by an extension (btree_gist's functions, for example) are left
-- out: they come from the extension version, not from our migrations.
-- Text aggregates sort with collate "C" so the output does not depend on the
-- database's locale.

with
ext_owned as (
  select classid, objid from pg_depend where deptype = 'e'
),
api_roles as (
  select 0::oid as oid, 'PUBLIC'::text as rolname
  union all
  select oid, rolname::text from pg_roles
  where rolname in ('anon', 'authenticated', 'service_role')
),
rels as (
  select c.oid, c.relname::text as relname, c.relkind, c.relrowsecurity,
         c.relforcerowsecurity, c.reloptions, c.relacl, c.relowner
  from pg_class c
  where c.relnamespace = 'public'::regnamespace
    and c.relkind in ('r', 'p', 'v', 'm')
    and not exists (select 1 from ext_owned e
                    where e.classid = 'pg_class'::regclass and e.objid = c.oid)
),
procs as (
  select p.*, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as signature
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and not exists (select 1 from ext_owned e
                    where e.classid = 'pg_proc'::regclass and e.objid = p.oid)
),

extension_rows as (
  select 'extension'::text as kind, extname::text as name, extversion::text as detail
  from pg_extension
  where extname <> 'plpgsql'
),

enum_rows as (
  select 'enum', t.typname::text,
         string_agg(e.enumlabel::text, ',' order by e.enumsortorder)
  from pg_type t
  join pg_enum e on e.enumtypid = t.oid
  where t.typnamespace = 'public'::regnamespace
    and not exists (select 1 from ext_owned x
                    where x.classid = 'pg_type'::regclass and x.objid = t.oid)
  group by t.typname
),

table_rows as (
  select 'table', relname,
         'relkind=' || relkind::text || ' rls=' || relrowsecurity
           || ' force_rls=' || relforcerowsecurity
           || ' options=' || coalesce(reloptions::text, '')
  from rels
),

column_rows as (
  select 'column', r.relname || '.' || a.attname,
         format_type(a.atttypid, a.atttypmod)
           || ' notnull=' || a.attnotnull
           || ' default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '')
           || ' identity=' || a.attidentity::text
           || ' generated=' || a.attgenerated::text
  from rels r
  join pg_attribute a on a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
),

column_order_rows as (
  select 'column_order', r.relname,
         string_agg(a.attname::text, ',' order by a.attnum)
  from rels r
  join pg_attribute a on a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped
  group by r.relname
),

-- contype 'n' is Postgres 18's catalogued NOT NULL; column_rows already
-- carries attnotnull, and older servers have no such rows.
constraints as (
  select r.relname, con.conname::text as conname, con.contype::text as contype,
         pg_get_constraintdef(con.oid) as def
  from rels r
  join pg_constraint con on con.conrelid = r.oid
  where con.contype <> 'n'
),

constraint_rows as (
  select 'constraint', relname || '.' || conname,
         case when conname = 'notifications_type_known' then
           -- The type list is restated in many migrations in varying order;
           -- compare it as a set here and keep the raw text below.
           contype || ' sorted: ' || (
             select string_agg(m[1], ',' order by m[1] collate "C")
             from regexp_matches(def, '''([^'']*)''', 'g') as m)
         else contype || ' ' || def end
  from constraints
),

constraint_raw_rows as (
  select 'constraint_raw', relname || '.' || conname, contype || ' ' || def
  from constraints
  where conname = 'notifications_type_known'
),

index_rows as (
  select 'index', i.relname::text, pg_get_indexdef(i.oid)
  from pg_index x
  join pg_class i on i.oid = x.indexrelid
  join rels r on r.oid = x.indrelid
),

trigger_rows as (
  select 'trigger', r.relname || '.' || t.tgname, pg_get_triggerdef(t.oid)
  from pg_trigger t
  join rels r on r.oid = t.tgrelid
  where not t.tgisinternal
),

function_rows as (
  select 'function', p.signature,
         'kind=' || p.prokind::text || ' lang=' || l.lanname
           || ' volatile=' || p.provolatile::text || ' strict=' || p.proisstrict
           || ' secdef=' || p.prosecdef || ' parallel=' || p.proparallel::text
           || ' config=' || coalesce(p.proconfig::text, '')
           || ' args=' || pg_get_function_arguments(p.oid)
           || ' returns=' || coalesce(pg_get_function_result(p.oid), '')
           -- Bodies pasted from Windows keep CRLF line endings; hash them as LF so
           -- only real code changes show up.
           || ' body_md5=' || md5(replace(p.prosrc, E'\r\n', E'\n'))
  from procs p
  join pg_language l on l.oid = p.prolang
),

function_acl_rows as (
  select 'function_acl', p.signature,
         coalesce((
           select string_agg(ar.rolname || ':' || a.privilege_type,
                             ',' order by ar.rolname collate "C", a.privilege_type collate "C")
           from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
           join api_roles ar on ar.oid = a.grantee), '')
  from procs p
),

-- MAINTAIN is left out: Postgres 17 added it and grants it with ALL, so it
-- reflects the server version, not anything a migration chose.
table_acl_rows as (
  select 'table_acl', r.relname,
         coalesce((
           select string_agg(ar.rolname || ':' || a.privilege_type,
                             ',' order by ar.rolname collate "C", a.privilege_type collate "C")
           from aclexplode(coalesce(r.relacl, acldefault('r', r.relowner))) a
           join api_roles ar on ar.oid = a.grantee
           where a.privilege_type <> 'MAINTAIN'), '')
  from rels r
),

view_rows as (
  select 'view', relname, md5(pg_get_viewdef(oid))
  from rels
  where relkind in ('v', 'm')
),

policy_rows as (
  select 'policy', tablename || '.' || policyname,
         'cmd=' || cmd || ' permissive=' || permissive || ' roles=' || roles::text
           || ' qual=' || coalesce(qual, '') || ' with_check=' || coalesce(with_check, '')
  from pg_policies
  where schemaname = 'public'
),

-- Reference rows that migration 002 seeds; the app reads them as vocabulary.
seed_rows as (
  select 'seed', 'room_layouts.' || code, label from room_layouts
  union all
  select 'seed', 'accessibility_features.' || code, label from accessibility_features
  union all
  select 'seed', 'facilities.' || code, label from facilities
)

select kind, name, detail from (
  select * from extension_rows
  union all select * from enum_rows
  union all select * from table_rows
  union all select * from column_rows
  union all select * from column_order_rows
  union all select * from constraint_rows
  union all select * from constraint_raw_rows
  union all select * from index_rows
  union all select * from trigger_rows
  union all select * from function_rows
  union all select * from function_acl_rows
  union all select * from table_acl_rows
  union all select * from view_rows
  union all select * from policy_rows
  union all select * from seed_rows
) fingerprint
order by kind collate "C", name collate "C";
