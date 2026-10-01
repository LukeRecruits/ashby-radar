-- The outreach funnel, and the queue that gets worked from it.
--
-- One ordered stage per contact, not a row of checkboxes. Checkboxes permit states that
-- cannot happen (customer, never contacted) and they do not answer the only question the
-- console is for, which is "where is this person now, and what do I do about them
-- today". An ordered stage answers both and makes the funnel arithmetic free.
--
-- Stages: Identified, Invite sent, Connected, Messaged, Replied, Demo, then the two
-- terminals, Customer and No. "Already a connection" is deliberately NOT a stage: it is a
-- property of Luke's own network that happens to let somebody skip the invitation, and
-- those people are the warm list to work first. It stays a separate flag on the contact,
-- as it has been since 0013.
--
-- Every transition writes a row to contact_stage_events, by trigger rather than by the
-- caller remembering, so days-in-stage, conversion between stages and the rolling
-- invitation count all come out of the history rather than being maintained. LinkedIn
-- allows about a hundred invitations per rolling seven days on every tier including Sales
-- Navigator, so that last one is not a nicety: going over it is an account problem.

-- 1. The ladder ---------------------------------------------------------------
--
-- A table rather than a check constraint, for three reasons: the views can order by
-- `position` instead of a CASE repeated in each one, the labels live next to the values
-- they label, and adding a stage later is an insert rather than a constraint rewrite.
--
-- `needs_action` is the whole queue in one column: it marks the stages where the ball is
-- with Luke. The waiting stages are not idle, they are just not his move.

create table public.contact_stages (
  stage        text primary key,
  position     int  not null unique,
  label        text not null,
  is_terminal  boolean not null default false,
  needs_action boolean not null default false,
  action_label text
);

insert into public.contact_stages (stage, position, label, is_terminal, needs_action, action_label) values
  ('identified',  10, 'Identified',  false, true,  'Invite'),
  ('invite_sent', 20, 'Invite sent', false, false, null),
  ('connected',   30, 'Connected',   false, true,  'Message'),
  ('messaged',    40, 'Messaged',    false, false, null),
  ('replied',     50, 'Replied',     false, true,  'Reply'),
  ('demo',        60, 'Demo booked', false, false, null),
  ('customer',    70, 'Customer',    true,  false, null),
  -- Out of the ladder rather than at the end of it: a No is not further along than a
  -- demo, and a funnel chart that implies otherwise is lying about the shape.
  ('no',          99, 'No',          true,  false, null);

alter table public.contact_stages enable row level security;

-- 2. Stage on the contact -----------------------------------------------------
--
-- A foreign key rather than a check: the ladder is data now, so the constraint should
-- read from it.
--
-- `no_reason` is a fixed vocabulary, not free text, and that is a data-protection
-- decision as much as a reporting one. A free-text note against a named person would be
-- an opinion about them held indefinitely in a prospecting database, which is exactly
-- what docs/prospecting-lia.md promises is not happening here. A reason code says why
-- the approach ended without recording anything about who they are.

alter table public.contacts
  add column stage            text not null default 'identified'
                                references public.contact_stages (stage),
  add column stage_changed_at timestamptz not null default now(),
  add column no_reason        text
                                check (no_reason in (
                                  'no_response', 'not_relevant', 'wrong_person',
                                  'said_no', 'left_company', 'other'
                                ));

create index contacts_stage_idx on public.contacts (stage, stage_changed_at);

-- 3. The history --------------------------------------------------------------
--
-- Append-only. One row per transition, including the first one, so every contact has a
-- complete record from the moment it was created and "days since identified" is never a
-- guess. It holds no personal data of its own: a contact id, a stage and a timestamp.
--
-- Cascading from contacts matters for retention: the monthly purge deletes a contact, and
-- the history of somebody who no longer exists would be a record about a person we have
-- undertaken to delete.

create table public.contact_stage_events (
  id         uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts (id) on delete cascade,
  stage      text not null references public.contact_stages (stage),
  at         timestamptz not null default now()
);

create index contact_stage_events_contact_idx on public.contact_stage_events (contact_id, at);
create index contact_stage_events_stage_idx on public.contact_stage_events (stage, at desc);

alter table public.contact_stage_events enable row level security;

-- Recorded by trigger, so a transition made in the SQL editor is in the history too. The
-- console is not the only thing that will ever touch this table and the history is only
-- worth having if it is complete.
create function public.record_stage_event()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.stage is distinct from old.stage then
    insert into public.contact_stage_events (contact_id, stage) values (new.id, new.stage);
  end if;
  return null;
end;
$$;

revoke all on function public.record_stage_event() from public, anon, authenticated;

create trigger contacts_record_stage
  after insert or update of stage on public.contacts
  for each row execute function public.record_stage_event();

-- 4. Moving somebody along ----------------------------------------------------
--
-- The fifth write function, on the same terms as the other four: security definer, the
-- shared token, nothing else reachable. It does not police the order of the ladder.
-- Somebody who replies to the invitation before accepting it skips Connected, and a
-- stage that can only be reached through the stage before it is a workflow fighting the
-- actual conversation.

create function public.set_contact_stage(
  p_contact_id uuid,
  p_stage      text,
  p_reason     text,
  p_token      text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.console_write_allowed(p_token) then
    raise exception 'not permitted' using errcode = 'insufficient_privilege';
  end if;

  if not exists (select 1 from public.contact_stages s where s.stage = p_stage) then
    raise exception '% is not a stage' , p_stage using errcode = 'check_violation';
  end if;

  update public.contacts
     set stage            = p_stage,
         stage_changed_at = now(),
         last_activity_at = now(),
         -- The reason belongs to the No and goes when the No does, so that reopening
         -- somebody does not leave a stale explanation attached to them.
         no_reason        = case
                              when p_stage = 'no'
                                then coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'other')
                              else null
                            end
   where id = p_contact_id;

  return found;
end;
$$;

grant execute on function public.set_contact_stage(uuid, text, text, text) to anon;

-- 5. What the console reads ---------------------------------------------------

-- lead_contacts gains the stage fields. Dropped and recreated rather than altered,
-- because a view's column list cannot be extended in place.
drop view public.lead_contacts;

create view public.lead_contacts as
select
  c.id,
  c.company_id,
  c.full_name,
  c.job_title,
  c.linkedin_url,
  c.linkedin_key,
  c.source,
  c.is_connection,
  c.added_at,
  c.last_activity_at,
  c.stage,
  c.stage_changed_at,
  c.no_reason,
  st.label        as stage_label,
  st.position     as stage_position,
  st.is_terminal,
  st.needs_action,
  st.action_label,
  (current_date - c.stage_changed_at::date) as days_in_stage
from public.contacts c
join public.contact_stages st on st.stage = c.stage;

-- The queue: every live contact with the company context needed to act without opening
-- another page.
--
-- It joins `lead_list` rather than recomputing the latest snapshot, which is a deliberate
-- trade. There will be tens of contacts here, not thousands, and a planner that has to
-- walk lead_list once costs tens of milliseconds, against the certainty of two
-- definitions of "open roles today" drifting apart. The 25x CTE lesson from 0011 does not
-- apply: that was four scans of 64,827 rows inside one statement, this is one pass keyed
-- on an id.
--
-- `next_action` folds in the one case the ladder cannot express on its own: somebody Luke
-- is already connected to does not need an invitation, so they are a message from the
-- moment they are identified. Parked companies drop out: parking a company is a decision
-- not to work it, and leaving its contacts in the queue would undo that.

create view public.work_queue as
select
  c.id            as contact_id,
  c.company_id,
  c.full_name,
  c.job_title,
  c.linkedin_url,
  c.is_connection,
  c.source,
  c.added_at,
  c.stage,
  st.label        as stage_label,
  st.position     as stage_position,
  st.is_terminal,
  st.needs_action,
  c.stage_changed_at,
  (current_date - c.stage_changed_at::date) as days_in_stage,
  c.no_reason,
  case
    when st.is_terminal                              then 'done'
    when c.stage = 'identified' and c.is_connection  then 'message'
    when c.stage = 'identified'                      then 'invite'
    when c.stage = 'connected'                       then 'message'
    when c.stage = 'replied'                         then 'reply'
    else 'waiting'
  end             as next_action,
  l.label         as company_label,
  l.domain,
  l.top_country,
  l.top_locality,
  l.open_roles,
  l.stale_roles_120,
  l.recruiter_roles,
  l.signal_count
from public.contacts c
join public.contact_stages st on st.stage = c.stage
join public.lead_list l on l.id = c.company_id
where l.parked_at is null;

-- The funnel, including the stages nobody is in. A funnel with rows missing reads as
-- though those stages do not exist rather than as though they are empty, and empty is
-- the interesting state when you are looking for where people stop.
create view public.funnel_counts as
select
  st.stage,
  st.label,
  st.position,
  st.is_terminal,
  count(c.id) as contacts
from public.contact_stages st
left join public.contacts c on c.stage = st.stage
group by st.stage, st.label, st.position, st.is_terminal;

-- Invitations sent in the rolling seven days, because LinkedIn's limit is a rolling
-- window rather than a calendar week, and the only way to stay under it is to count the
-- same way it does.
create view public.invite_usage as
select
  count(*) filter (where e.at > now() - interval '7 days')  as last_7_days,
  count(*) filter (where e.at > now() - interval '1 day')   as last_24_hours,
  count(*) filter (where e.at > now() - interval '30 days') as last_30_days,
  max(e.at)                                                 as last_invite_at
from public.contact_stage_events e
where e.stage = 'invite_sent';

-- 6. Grants -------------------------------------------------------------------

revoke all on public.contact_stages, public.contact_stage_events from anon, authenticated;

revoke insert, update, delete, truncate, references, trigger
  on public.lead_contacts, public.work_queue, public.funnel_counts, public.invite_usage
  from anon, authenticated;

grant select
  on public.lead_contacts, public.work_queue, public.funnel_counts, public.invite_usage
  to anon, authenticated;

-- 7. One misnomer, documented where it lives ----------------------------------
--
-- `has_in_house_ta` is true when a recruiting role is open on the board, which is not the
-- claim the console made from it until today. The first live contact lookup found a Head
-- of Talent of eighteen months and ten colleagues at a company the list called "Nobody".
-- Renaming the column means recreating lead_list for no behavioural gain, so it gets a
-- comment instead and every label in the console now says "recruiter req".

comment on column public.lead_list.has_in_house_ta is
  'True when a recruiting role is OPEN on the board today. Not evidence that the company has no talent team: use it as "not hiring a recruiter today".';
