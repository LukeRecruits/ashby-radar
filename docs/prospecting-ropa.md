# Record of processing: prospecting contacts

The Article 30 entry for the one activity in Ashby Radar that involves a person, plus how
a request from one of them is handled. Article 30's exemption for organisations under 250
staff does not cover processing that is regular rather than occasional, and this runs
weekly, so the record exists.

Companion to `prospecting-lia.md`, which is the lawful-basis assessment. Public-facing
version at https://candidhq.tech/privacy/prospecting.

## The entry

| Field | Value |
| --- | --- |
| Activity | Identifying and approaching the talent-acquisition lead at a company that uses Ashby |
| Controller | Candid HQ Limited, registered in Scotland. ICO registration C1941533 |
| Contact | privacy@candidhq.tech |
| Processor / system | Ashby Radar (`LukeRecruits/ashby-radar`), a CandidHQ internal tool |
| Data subjects | Talent-acquisition, recruiting and people leaders, in a professional capacity |
| Categories of data | Name; current job title; LinkedIn profile URL; the employer they are recorded against. Nothing else |
| Special category data | None sought, none stored |
| Source | Public professional profiles, retrieved through the Exa search API on demand |
| Lawful basis | Article 6(1)(f), legitimate interests. See `prospecting-lia.md` |
| Purpose | Business-to-business outreach about CandidHQ |
| Recipients | None. Not shared, not sold, not disclosed |
| Sub-processors | Supabase (database, London eu-west-2), Vercel (console hosting), GitHub Actions (scheduled jobs). Exa Labs (US) runs the search; it receives a company name and role keywords and no personal data from us |
| International transfers | None of personal data. The database and its backups are in London |
| Retention | 24 months from the last action recorded on a contact, then deleted automatically. Suppression entries are kept indefinitely, because their purpose is to make a removal permanent |
| Security | Single operator. Console gated by HTTP Basic auth in application code, failing closed. Row-level security on every table with no policies, so the browser-grade key reads nothing. Writes restricted to four named database functions behind a shared secret. No service-role key in the console |
| Rights mechanism | privacy@candidhq.tech, or a reply to the LinkedIn message. See below |
| Automated decision-making | None. Ranking a search result by job title is not a decision about a person |

## Retention, in practice

`last_activity_at` on a contact row is stamped when the row is created and again on every
funnel transition. `purge_expired_contacts()` deletes any contact whose last activity is
more than 24 months old, and runs monthly as the `retention` GitHub Actions workflow. The
period is one number in one place (`src/config.ts`, `contacts.retentionMonths`), and the
public notice states the same figure, so changing it means changing both.

A contact who becomes a customer stops being a prospecting record and is deleted from
Radar; the commercial relationship is held in CandidHQ under its own policy.

## Handling a request

Any of these arriving by LinkedIn reply, email, or any other route:

**"Stop contacting me", "remove me", "do not contact", or a block.** Objection under
Article 21(2), which is absolute for direct marketing. No assessment, no reply asking why.
Suppress them, which both deletes the contact and records the profile URL so that a later
search cannot re-add them:

```sql
select suppress_contact('<linkedin profile url>', 'objection', '<write token>');
```

Or the Suppress button on the company page in the console, which calls the same function.

**Erasure (Article 17).** Same action. There is nothing else to delete: no email, no
notes, no history beyond the funnel dates on the row being removed.

**Access (Article 15).** The four fields, the stage they reached, and the dates of each
transition. One query, no redaction needed, no third-party data involved:

```sql
select * from contacts where linkedin_key = normalise_linkedin_url('<url>');
```

Respond within one month. Say where the data came from (a named public profile via the
Exa search API), what it was used for, and that it has now been deleted if they also
objected.

**Rectification (Article 16).** Correct the field or delete the row. A stale job title is
the likely case and deleting is usually the better answer, since a wrong title means the
qualification was wrong too.

**A complaint.** Answer it, and tell them they can take it to the ICO at ico.org.uk. Do
not argue the balancing test with the person; the LIA exists for the regulator, not as a
reply to someone who is annoyed.

Log what was done and when, in the message thread itself. A suppression row carries its
own date and reason, which is the audit trail for the only action that matters.
