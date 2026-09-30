-- Pin the trigger function's search_path. A mutable search_path lets a caller with
-- CREATE on a schema shadow a built-in and have it run inside the trigger.
-- Flagged by Supabase's database linter (0011_function_search_path_mutable).

create or replace function set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
