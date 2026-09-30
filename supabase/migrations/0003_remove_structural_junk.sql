-- One-off cleanup of crawler artefacts ingested by the first discovery run, before the
-- structural junk filter existed in src/discovery/boardName.ts.
--
-- 2,061 of 7,792 discovered names (26%) were one of three shapes that cannot be a
-- company board. All were confirmed 404 against the posting API, and none had any
-- jobs, snapshots or triggers attached, so this removes artefacts, not history.
--
--   root.<uuid>[.<uuid>]   2,059   embedded job-board widget artefact
--   jobs-page-<uuid>            2   paginated board listing
--   <uuid with underscores>     -   caught by the same pass
--
-- The "never hard-delete" rule protects company and job history. These rows were never
-- companies. Anything genuinely gone from Ashby is marked not_found by the refresh
-- instead, because a 404 alone does not prove junk: "Stanza" and "DECA Dental Group"
-- are ordinary names that 404 as former customers.

do $$
declare
  junk_pattern text := '^root\.'
    || '|^jobs-page-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    || '|[0-9a-f]{8}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{12}';
begin
  delete from discovery_log where board_name ~* junk_pattern;
  delete from companies     where board_name ~* junk_pattern;
end $$;
