-- =====================================================
-- Usuarios con roles (admin / user)
-- Ejecutar DESPUÉS de schema.sql, en: Supabase > SQL Editor
-- Es seguro volver a ejecutarlo (idempotente).
-- =====================================================

create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  username    text,
  role        text not null default 'user' check (role in ('admin', 'user')),
  created_at  timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Funciones auxiliares (security definer para evitar recursión en las políticas)
create or replace function public.current_role_name()
returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;

create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'admin' from public.profiles where id = auth.uid()), false)
$$;

-- Políticas
drop policy if exists "profiles_select_own_or_admin" on public.profiles;
create policy "profiles_select_own_or_admin" on public.profiles
  for select using (auth.uid() = id or public.is_admin());

-- Un usuario puede editar su perfil, pero NO cambiarse el rol
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id)
  with check (auth.uid() = id and role = public.current_role_name());

-- Un admin puede editar cualquier perfil (incluido el rol)
drop policy if exists "profiles_update_admin" on public.profiles;
create policy "profiles_update_admin" on public.profiles
  for update using (public.is_admin()) with check (public.is_admin());

-- Sin políticas de insert/delete: los perfiles solo los crea el trigger
-- y se eliminan en cascada al borrar el usuario de auth.

-- Alta automática del perfil al registrarse.
-- La PRIMERA cuenta creada recibe el rol 'admin'; las siguientes, 'user'.
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, username, role)
  values (
    new.id,
    new.email,
    coalesce(nullif(new.raw_user_meta_data->>'username', ''), split_part(new.email, '@', 1)),
    case when not exists (select 1 from public.profiles) then 'admin' else 'user' end
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Endurece permisos: las funciones no deben poder llamarse por la API pública.
-- is_admin() y current_role_name() siguen disponibles para usuarios con sesión (las usan las políticas).
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.current_role_name() from public, anon;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.current_role_name() to authenticated;

-- Si ya había usuarios registrados antes de este script, les crea el perfil...
insert into public.profiles (id, email, username, role)
select u.id, u.email, split_part(u.email, '@', 1), 'user'
from auth.users u
on conflict (id) do nothing;

-- ...y deja como admin al más antiguo si todavía no hay ningún admin.
update public.profiles
set role = 'admin'
where id = (
  select p.id from public.profiles p
  join auth.users u on u.id = p.id
  order by u.created_at
  limit 1
)
and not exists (select 1 from public.profiles where role = 'admin');

-- Para cambiar el rol de alguien manualmente:
--   update public.profiles set role = 'admin' where email = 'correo@ejemplo.com';

-- Mensajes del formulario de contacto (cualquiera puede enviar; solo el admin los lee)
create table if not exists public.contact_messages (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 100),
  email text not null check (char_length(email) between 5 and 160 and email like '%@%'),
  phone text check (phone is null or char_length(phone) <= 40),
  message text not null check (char_length(message) between 5 and 2000),
  read boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.contact_messages enable row level security;
create policy "cualquiera puede enviar" on public.contact_messages for insert to anon, authenticated with check (read = false);
create policy "admin lee" on public.contact_messages for select to authenticated using (public.is_admin());
create policy "admin actualiza" on public.contact_messages for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admin elimina" on public.contact_messages for delete to authenticated using (public.is_admin());

-- Identidad: nombre completo, RUT (validado con módulo 11) y consentimiento. Ver migración "profiles_identity_fields"
-- en el panel de Supabase: columnas full_name, rut, consent_at; funciones valid_rut, norm_rut, admin_users;
-- y handle_new_user actualizado para leer full_name / rut / consent de los metadatos del registro.

-- Avisos de libros nuevos (migración "notifications_new_uploads")
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  username text,
  kind text not null default 'upload',
  count int not null check (count between 1 and 1000),
  titles text[] not null default '{}',
  read boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.notifications enable row level security;
create policy "usuario crea su aviso" on public.notifications for insert to authenticated with check (user_id = auth.uid() and read = false);
create policy "ver avisos propios o admin" on public.notifications for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy "admin actualiza avisos" on public.notifications for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admin elimina avisos" on public.notifications for delete to authenticated using (public.is_admin());

-- Etiquetas y categorías oficiales creadas por el admin (migración "taxonomy_admin_lists")
create table if not exists public.taxonomy (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('tag','category')),
  name text not null check (char_length(name) between 2 and 60),
  created_at timestamptz not null default now()
);
create unique index if not exists taxonomy_kind_name_uq on public.taxonomy (kind, lower(name));
alter table public.taxonomy enable row level security;
create policy "todos ven la lista" on public.taxonomy for select to authenticated using (true);
create policy "admin crea" on public.taxonomy for insert to authenticated with check (public.is_admin());
create policy "admin elimina" on public.taxonomy for delete to authenticated using (public.is_admin());
