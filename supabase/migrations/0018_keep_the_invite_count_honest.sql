-- Deleting a contact was deleting the evidence that we had spent an invitation on them.
--
-- `contact_stage_events.contact_id` cascaded from `contacts`, so removing a person took
-- their history with them, and `invite_usage` counts invitations out of that history.
-- Seen while clearing a test contact: the rolling seven-day count went from 1 to 0 the
-- moment the contact was deleted. LinkedIn's count did not. The number exists to keep
-- Luke under a limit whose breach costs him his account, and a number that under-reports
-- after any deletion is worse than no number, because it reads as headroom.
--
-- Deletions are not rare, either. The monthly retention purge is a deletion, and so is
-- every objection.
--
-- The fix is `on delete set null` rather than cascade. What is left behind is a stage and
-- a timestamp with no subject: "an invitation was sent on 1 October". That is not personal
-- data, so it survives an erasure request intact and honestly, and the per-contact history
-- still works for every contact that exists. It also means the funnel's arithmetic
-- outlives the retention period, which is the right way round: the shape of the funnel is
-- our data, the people in it are theirs.

alter table public.contact_stage_events
  alter column contact_id drop not null;

alter table public.contact_stage_events
  drop constraint contact_stage_events_contact_id_fkey,
  add constraint contact_stage_events_contact_id_fkey
    foreign key (contact_id) references public.contacts (id) on delete set null;

comment on table public.contact_stage_events is
  'Append-only transition history. contact_id goes null when the contact is deleted, leaving an anonymous stage and timestamp so the invitation count and funnel arithmetic stay true after an erasure or the retention purge.';
