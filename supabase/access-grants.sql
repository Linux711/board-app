-- Run once after setup.sql if Supabase had automatic table exposure disabled.
-- These grants do not bypass the row-level security policies.
grant select, update on public.boards to authenticated;
grant select on public.board_members to authenticated;
grant select on public.board_history to authenticated;
