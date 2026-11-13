-- Fieldnotes: shared boards with anyone-with-the-link editing.
-- Run this once in Supabase Dashboard > SQL Editor for this project.
-- A link is a bearer key: anyone who has it can edit that board.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.boards (
  id uuid primary key default extensions.gen_random_uuid(),
  name text not null default 'Untitled project',
  document jsonb not null default '{}'::jsonb,
  invite_token_hash text not null,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.board_members (
  board_id uuid not null references public.boards(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (board_id, user_id)
);

create table if not exists public.board_history (
  id bigint generated always as identity primary key,
  board_id uuid not null references public.boards(id) on delete cascade,
  changed_by uuid references auth.users(id) on delete set null,
  changed_at timestamptz not null default now(),
  before_document jsonb not null,
  after_document jsonb not null
);

create index if not exists board_history_board_changed_at_idx
  on public.board_history (board_id, changed_at desc);

alter table public.boards enable row level security;
alter table public.board_members enable row level security;
alter table public.board_history enable row level security;

-- RLS policies control which rows are visible; grants allow these specific
-- operations to reach the policies through the browser Data API.
grant select, update on public.boards to authenticated;
grant select on public.board_members to authenticated;
grant select on public.board_history to authenticated;

-- A user's own membership rows are visible to that user only.
create policy "Members can see their own board memberships"
  on public.board_members for select to authenticated
  using (user_id = (select auth.uid()));

-- Board data is available only after the invite token has been redeemed.
create policy "Members can view their boards"
  on public.boards for select to authenticated
  using (
    exists (
      select 1 from public.board_members m
      where m.board_id = boards.id and m.user_id = (select auth.uid())
    )
  );

create policy "Members can edit their boards"
  on public.boards for update to authenticated
  using (
    exists (
      select 1 from public.board_members m
      where m.board_id = boards.id and m.user_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.board_members m
      where m.board_id = boards.id and m.user_id = (select auth.uid())
    )
  );

create policy "Members can read board history"
  on public.board_history for select to authenticated
  using (
    exists (
      select 1 from public.board_members m
      where m.board_id = board_history.board_id and m.user_id = (select auth.uid())
    )
  );

create or replace function public.create_shared_board(
  board_name text,
  initial_document jsonb default '{}'::jsonb
)
returns table (board_id uuid, invite_token text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_board_id uuid;
  new_invite_token text;
begin
  if auth.uid() is null then
    raise exception 'Sign in anonymously before creating a board';
  end if;

  new_board_id := extensions.gen_random_uuid();
  new_invite_token := encode(extensions.gen_random_bytes(32), 'hex');

  insert into public.boards (id, name, document, invite_token_hash, created_by)
  values (
    new_board_id,
    coalesce(nullif(trim(board_name), ''), 'Untitled project'),
    coalesce(initial_document, '{}'::jsonb),
    encode(extensions.digest(new_invite_token, 'sha256'), 'hex'),
    auth.uid()
  );

  insert into public.board_members (board_id, user_id)
  values (new_board_id, auth.uid());

  return query select new_board_id, new_invite_token;
end;
$$;

create or replace function public.join_shared_board(
  requested_board_id uuid,
  supplied_invite_token text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  matching_board_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in anonymously before joining a board';
  end if;

  select b.id into matching_board_id
  from public.boards b
  where b.id = requested_board_id
    and b.invite_token_hash = encode(extensions.digest(supplied_invite_token, 'sha256'), 'hex');

  if matching_board_id is null then
    return false;
  end if;

  insert into public.board_members (board_id, user_id)
  values (matching_board_id, auth.uid())
  on conflict do nothing;

  return true;
end;
$$;

revoke all on function public.create_shared_board(text, jsonb) from public, anon;
revoke all on function public.join_shared_board(uuid, text) from public, anon;
grant execute on function public.create_shared_board(text, jsonb) to authenticated;
grant execute on function public.join_shared_board(uuid, text) to authenticated;

-- Every document update records a before/after snapshot and the editing user.
create or replace function public.record_board_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.document is distinct from old.document then
    insert into public.board_history (board_id, changed_by, before_document, after_document)
    values (new.id, auth.uid(), old.document, new.document);
    new.updated_at := now();
  end if;
  return new;
end;
$$;

create trigger boards_record_history
  before update on public.boards
  for each row execute function public.record_board_history();

-- Images use private Storage paths: <board-id>/<card-id>/<filename>.
insert into storage.buckets (id, name, public)
values ('fieldnotes-images', 'fieldnotes-images', false)
on conflict (id) do nothing;

create policy "Board members can view board images"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'fieldnotes-images'
    and exists (
      select 1 from public.board_members m
      where m.board_id::text = (storage.foldername(name))[1]
        and m.user_id = (select auth.uid())
    )
  );

create policy "Board members can upload board images"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'fieldnotes-images'
    and exists (
      select 1 from public.board_members m
      where m.board_id::text = (storage.foldername(name))[1]
        and m.user_id = (select auth.uid())
    )
  );

create policy "Board members can update board images"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'fieldnotes-images'
    and exists (
      select 1 from public.board_members m
      where m.board_id::text = (storage.foldername(name))[1]
        and m.user_id = (select auth.uid())
    )
  )
  with check (
    bucket_id = 'fieldnotes-images'
    and exists (
      select 1 from public.board_members m
      where m.board_id::text = (storage.foldername(name))[1]
        and m.user_id = (select auth.uid())
    )
  );

create policy "Board members can delete board images"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'fieldnotes-images'
    and exists (
      select 1 from public.board_members m
      where m.board_id::text = (storage.foldername(name))[1]
        and m.user_id = (select auth.uid())
    )
  );

-- Enable Realtime updates for connected board clients.
alter publication supabase_realtime add table public.boards;
