# Legitimate interests assessment: prospecting contacts

**Controller:** Candid HQ Limited, registered in Scotland. ICO registration C1941533.
**Contact:** privacy@candidhq.tech
**Processing:** identifying the talent-acquisition lead at a company that uses Ashby, and
approaching them on LinkedIn about CandidHQ.
**Lawful basis relied on:** Article 6(1)(f) UK GDPR, legitimate interests.
**Assessed:** 1 October 2026. **Review:** 1 October 2027, or sooner if the processing changes.
**Assessed by:** Luke Eaton, sole operator.

This is the whole record. It is deliberately short, because the processing is narrow: one
person, four fields, one professional network, no email and no automation.

## 1. Purpose test: is there a legitimate interest?

Yes. CandidHQ sells candidate-experience software to in-house recruiting teams. Ashby
Radar finds companies using Ashby, qualifies them on their own published hiring activity,
and the next step is a conversation with the person who owns talent acquisition there.
Knowing who that person is, is the only way to have it.

The interest is CandidHQ's own commercial interest in finding its first customers. It is
not a public-interest claim and is not dressed up as one. The benefit to the individual is
real but secondary: the companies Radar surfaces are hiring at volume with no in-house
recruiter, which is the situation the product addresses.

No third party receives the data and nothing is sold on.

## 2. Necessity test: is the processing necessary for it?

Yes, and no less intrusive route achieves it.

- A company-level approach does not work. A generic sales enquiry to a shared inbox does
  not reach the person who owns hiring, which is the whole point of the segmentation.
- Advertising is not a substitute. The qualification that makes a lead worth anything
  here is derived from that specific company's open roles, so the approach has to be to
  that specific company.
- The data held is the minimum that makes an approach possible: who they are, what their
  role is, and where to reach them professionally.

What is deliberately not processed, because it is not necessary:

| Not held | Why |
| --- | --- |
| Email address, phone number | Outreach is LinkedIn only. Radar never sends email |
| Biography, summary, posts, photograph | Not needed to decide whether to approach someone |
| Education, work history before the current role | Not needed |
| Location, seniority band, time in post | Used transiently to rank search results, never stored |
| Any special category data | Never sought and never stored |

Four fields are stored: name, current job title, LinkedIn profile URL, and the employer
they are recorded against. Nothing else.

Contacts are found on demand, one company at a time, after a decision has already been
taken to approach that company. There is no bulk crawl and no standing database of people
built in advance of any intention to contact them. A person enters the system only in the
moment they are about to be contacted, which is the single biggest limit on the scale of
this processing.

## 3. Balancing test: does it override their interests?

**Whose data.** Talent-acquisition leaders, heads of people, and recruiting managers, in
their professional capacity. No consumers, no job applicants, no candidates. Nobody is
processed in a personal capacity and the data concerns nobody's private life.

**Where it comes from.** Public professional profiles, reached through the Exa search API.
These are profiles their subjects published in order to be found in a professional
context, on a network whose purpose includes receiving business approaches.

**Would they expect it.** Yes. A recruiting leader with a public LinkedIn profile is
approached by vendors regularly and is likely the most heavily prospected audience in
software. That cuts both ways and is addressed below.

**Impact on them.** Low. One message from a named individual on a platform with a block
button and an in-built decline. No email, no telephone call, no message to a personal
address, no profiling, no automated decision-making, no enrichment beyond the four fields,
no onward disclosure. The realistic harm is a message they did not ask for.

**The honest discomfort.** This audience is saturated with automated outreach and that
saturation is itself a harm, in aggregate, to the people on the receiving end. The
mitigation is the approach taken rather than a promise: messages are written and sent by
hand, by Luke Eaton under his own name, at fifteen to twenty-five a day, with the reason
for approaching that specific company stated in the message. Volume is capped by the
person sending it, not by a quota.

**Safeguards.**

- Data minimisation as above. Four fields, found on demand.
- Article 14 information is given at first contact, as a link in the first LinkedIn
  message, to https://candidhq.tech/privacy/prospecting.
- A suppression list keyed on the normalised LinkedIn profile URL. A removal survives a
  later search re-finding the same person: the database refuses to store them again.
- Objection is honoured immediately and without question, and is absolute for direct
  marketing under Article 21(2). No balancing is applied to a request to stop.
- Retention: 24 months from the last action taken on a contact, then automatic deletion.
- Access: a single operator. The console is password-gated in application code, the
  database denies the browser-grade credential every base table, and writes go through
  four named functions rather than a general-purpose key.
- Data at rest in London (Supabase, eu-west-2). No personal data is sent to the search
  provider: the query contains a company name and role keywords only.

**Outcome.** Legitimate interests applies. The interest is real, the processing is the
minimum that serves it, the data is professional and published, the impact is one hand
written message, and the person can end it permanently with one reply.

## 4. What would change this assessment

Any of these needs the assessment reopened before it is built:

- Storing an email address, a phone number, or anything beyond the four fields.
- Sending email, or any outreach that is not a hand-written message on LinkedIn.
- Automating the sending, or raising the volume beyond what one person writes by hand.
- Approaching anyone outside a professional talent or people role.
- Sharing the list with anyone, including a contractor or a co-founder.
- Using the contact data to train or evaluate a model.
