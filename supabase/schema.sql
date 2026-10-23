-- =====================================================
-- Biblioteca PDF estilo Netflix - Esquema Supabase
-- Ejecutar completo en: Supabase > SQL Editor
-- =====================================================

-- Tabla de libros
create table if not exists public.books (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade default auth.uid(),
  title        text not null,
  author       text,
  category     text not null default 'General',
  tags         text[] not null default '{}',  -- etiquetas para filtrar (rol o género)
  opens        integer not null default 0,    -- veces abierto (más leídos)
  downloads    integer not null default 0,    -- veces descargado
  last_opened_at timestamptz,
  pages        int,
  pdf_path     text not null,
  cover_path   text,
  created_at   timestamptz not null default now()
);

create index if not exists books_user_idx on public.books(user_id);
create index if not exists books_category_idx on public.books(category);

-- Progreso de lectura
create table if not exists public.reading_progress (
  user_id     uuid not null references auth.users(id) on delete cascade default auth.uid(),
  book_id     uuid not null references public.books(id) on delete cascade,
  last_page   int not null default 1,
  updated_at  timestamptz not null default now(),
  primary key (user_id, book_id)
);

-- =====================================================
-- Row Level Security: cada usuario ve solo lo suyo
-- =====================================================
alter table public.books enable row level security;
alter table public.reading_progress enable row level security;

create policy "books_select_own" on public.books
  for select using (auth.uid() = user_id);
create policy "books_insert_own" on public.books
  for insert with check (auth.uid() = user_id);
create policy "books_update_own" on public.books
  for update using (auth.uid() = user_id);
create policy "books_delete_own" on public.books
  for delete using (auth.uid() = user_id);

create policy "progress_select_own" on public.reading_progress
  for select using (auth.uid() = user_id);
create policy "progress_insert_own" on public.reading_progress
  for insert with check (auth.uid() = user_id);
create policy "progress_update_own" on public.reading_progress
  for update using (auth.uid() = user_id);
create policy "progress_delete_own" on public.reading_progress
  for delete using (auth.uid() = user_id);

-- =====================================================
-- Storage: buckets privados
-- Los archivos se guardan en <user_id>/<archivo>
-- =====================================================
insert into storage.buckets (id, name, public)
values ('pdfs', 'pdfs', false), ('covers', 'covers', false)
on conflict (id) do nothing;

create policy "storage_select_own" on storage.objects
  for select to authenticated
  using (bucket_id in ('pdfs','covers') and (storage.foldername(name))[1] = auth.uid()::text);

create policy "storage_insert_own" on storage.objects
  for insert to authenticated
  with check (bucket_id in ('pdfs','covers') and (storage.foldername(name))[1] = auth.uid()::text);

create policy "storage_update_own" on storage.objects
  for update to authenticated
  using (bucket_id in ('pdfs','covers') and (storage.foldername(name))[1] = auth.uid()::text);

create policy "storage_delete_own" on storage.objects
  for delete to authenticated
  using (bucket_id in ('pdfs','covers') and (storage.foldername(name))[1] = auth.uid()::text);

-- Favoritos, tamaño y marcadores (migración "favorites_bookmarks_sizes")
alter table public.books add column if not exists favorite boolean not null default false;
alter table public.books add column if not exists size_bytes bigint;
create table if not exists public.bookmarks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  book_id uuid not null references public.books(id) on delete cascade,
  page integer not null check (page >= 1),
  note text check (note is null or char_length(note) <= 300),
  created_at timestamptz not null default now()
);
create index if not exists bookmarks_book_idx on public.bookmarks (book_id);
alter table public.bookmarks enable row level security;
create policy "marcadores propios: leer" on public.bookmarks for select to authenticated using (auth.uid() = user_id);
create policy "marcadores propios: crear" on public.bookmarks for insert to authenticated with check (auth.uid() = user_id);
create policy "marcadores propios: borrar" on public.bookmarks for delete to authenticated using (auth.uid() = user_id);

-- Biblioteca compartida (migración "shared_library"): books.is_public, políticas de lectura para todos los
-- usuarios con sesión (libros públicos y sus archivos), moderación por admin, tabla favorites y la función
-- bump_book_counter(p_book, p_field) para contar lecturas y descargas. Ver el panel de Supabase > Migrations.
