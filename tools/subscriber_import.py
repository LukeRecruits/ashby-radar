"""
Import DDR newsletter subscribers into the warm list (migrations 0028, 0029).

Runs on Luke's machine against his beehiiv subscriber export. Only `active` rows are
used; unsubscribed (inactive) subscribers are dropped before anything else happens. Each
email's domain, or a parent of it, is matched to a Radar company's domain, and only the
matched subscribers are sent: {company_id, count, emails: [{email, subscribed_on}]}.
Everybody else on the list stays on this machine.

    python3 -I tools/subscriber_import.py path/to/subscribers.csv            # dry run
    WARM_IMPORT_TOKEN=... python3 -I tools/subscriber_import.py path/to/subscribers.csv --send

The token works as in tools/warm_import.py: sha256 into settings.warm_import_token_sha256
first; the function deletes it on success.
"""

import collections, csv, json, os, sys, urllib.request

URL = os.environ.get('SUPABASE_URL', 'https://uluuvmuvgoegknujvgww.supabase.co').rstrip('/') + '/rest/v1/'
KEY = os.environ.get('SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_4utaIw9BRRsoC-DJm3nW2A_nl6PrEZG')


def pull(path):
    out, off = [], 0
    while True:
        req = urllib.request.Request(f'{URL}{path}&order=id&offset={off}&limit=1000', headers={'apikey': KEY})
        rows = json.load(urllib.request.urlopen(req))
        if not rows:
            return out
        out += rows
        off += len(rows)


def main():
    src, send = sys.argv[1], '--send' in sys.argv
    by_domain = collections.defaultdict(list)
    for c in pull('lead_list?select=id,domain,status'):
        if c['status'] == 'active' and c['domain']:
            by_domain[c['domain'].lower().removeprefix('www.')].append(c['id'])

    rows = list(csv.DictReader(open(src, encoding='utf-8-sig')))
    active = [r for r in rows if (r.get('status') or '').strip().lower() == 'active']
    emails, matched = collections.defaultdict(dict), 0
    for r in active:
        email = (r.get('email') or '').strip().lower()
        parts = email.rsplit('@', 1)[-1].split('.')
        for i in range(len(parts) - 1):
            ids = by_domain.get('.'.join(parts[i:]))
            if ids:
                matched += 1
                for cid in ids:
                    emails[cid][email] = (r.get('created_at') or '')[:10] or None
                break

    print(f'{len(rows)} rows, {len(active)} active, {len(rows) - len(active)} skipped as not active; '
          f'{matched} matched at {len(emails)} companies')
    if not send:
        return
    payload = [
        {'company_id': k, 'subscribers': len(v),
         'emails': [{'email': e, 'subscribed_on': d} for e, d in v.items()]}
        for k, v in emails.items()
    ]
    req = urllib.request.Request(
        f'{URL}rpc/replace_company_subscribers',
        data=json.dumps({'p_token': os.environ['WARM_IMPORT_TOKEN'], 'p_rows': payload}).encode(),
        headers={'apikey': KEY, 'Content-Type': 'application/json'},
        method='POST',
    )
    print('stored', json.load(urllib.request.urlopen(req)))


main()
