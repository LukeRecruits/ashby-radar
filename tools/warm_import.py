"""
Import Luke's LinkedIn connections into the warm list (migration 0027).

Runs on Luke's machine against his own LinkedIn data export. Matching happens here, so
only connections at a Radar company leave the machine; the rest of the network never
reaches the database.

    python3 -I tools/warm_import.py path/to/Connections.csv            # dry run, prints counts
    WARM_IMPORT_TOKEN=... python3 -I tools/warm_import.py path/to/Connections.csv --send

Before --send, put sha256(WARM_IMPORT_TOKEN) in settings.warm_import_token_sha256. The
function deletes it on success, so every import needs a fresh token. Reads with the
publishable key (SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY, defaulting to Radar's).
"""

import collections, csv, datetime, json, os, re, sys, urllib.request

URL = os.environ.get('SUPABASE_URL', 'https://uluuvmuvgoegknujvgww.supabase.co').rstrip('/') + '/rest/v1/'
KEY = os.environ.get('SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_4utaIw9BRRsoC-DJm3nW2A_nl6PrEZG')

# Connections whose stated employer is one of these are never matched by name: either it
# is not an employer at all, or it is Luke's own (Ava Labs is a colleague, not a lead).
EXCLUDED = {'stealth', 'stealthstartup', 'stealthmode', 'selfemployed', 'freelance',
            'freelancer', 'confidential', 'independent', 'avalabs', 'candidhq'}

SUFFIX = r'\b(inc|ltd|llc|limited|gmbh|corp|corporation|co|plc|sa|bv|ag|pbc|the|group|holdings|hq|technologies|technology|labs|ai|io)\b'
TALENT = re.compile(r'recruit|talent|\bta\b|people|human resources|\bhr\b|hiring|sourc', re.I)


def norm(name):
    n = (name or '').lower().replace('&', ' and ')
    n = re.sub(r'\(.*?\)', '', n)
    n = re.sub(SUFFIX, ' ', n)
    return re.sub(r'[^a-z0-9]', '', n)


def profile_key(url):
    """The same normalisation as normalise_linkedin_url() in migration 0013."""
    m = re.search(r'(?:^|\.|/)linkedin\.com/in/([^/?#\s]+)', (url or '').strip().lower())
    return f'linkedin.com/in/{m.group(1)}' if m else None


def pull(path):
    out, off = [], 0
    while True:
        req = urllib.request.Request(f'{URL}{path}&order=id&offset={off}&limit=1000', headers={'apikey': KEY})
        rows = json.load(urllib.request.urlopen(req))
        if not rows:
            return out
        out += rows
        off += len(rows)


def iso(day):
    try:
        return datetime.datetime.strptime(day.strip(), '%d %b %Y').date().isoformat()
    except ValueError:
        return None


def main():
    src, send = sys.argv[1], '--send' in sys.argv
    companies = [c for c in pull('lead_list?select=id,label,display_name,status') if c['status'] == 'active']
    people = pull('lead_people?select=id,company_id,linkedin_key')

    by_name = collections.defaultdict(set)
    for c in companies:
        for n in {norm(c['display_name']), norm(c['label'])}:
            if len(n) >= 3 and n not in EXCLUDED:
                by_name[n].add(c['id'])
    by_key = collections.defaultdict(set)
    for p in people:
        by_key[p['linkedin_key']].add(p['company_id'])

    lines = open(src, encoding='utf-8-sig').read().splitlines()
    start = next(i for i, l in enumerate(lines) if l.startswith('First Name,'))
    rows = []
    for r in csv.DictReader(lines[start:]):
        key = profile_key(r['URL'])
        if not key:
            continue
        hits = {cid: 'profile' for cid in by_key.get(key, ())}
        named = by_name.get(norm(r['Company']), set())
        for cid in named:
            hits.setdefault(cid, 'employer')
        for cid, how in hits.items():
            rows.append({
                'company_id': cid,
                'full_name': f"{r['First Name']} {r['Last Name']}".strip(),
                'position': r['Position'],
                'linkedin_url': r['URL'],
                'connected_on': iso(r['Connected On']),
                'match_type': how,
                'ambiguous': how == 'employer' and len(named) > 1,
                'is_talent': bool(TALENT.search(r['Position'] or '')),
            })

    print(f"{len(rows)} matches at {len({r['company_id'] for r in rows})} companies; "
          f"{sum(r['match_type'] == 'profile' for r in rows)} on the talent team; "
          f"{sum(r['ambiguous'] for r in rows)} ambiguous")
    if not send:
        return
    token = os.environ['WARM_IMPORT_TOKEN']
    req = urllib.request.Request(
        f'{URL}rpc/replace_warm_connections',
        data=json.dumps({'p_token': token, 'p_rows': rows}).encode(),
        headers={'apikey': KEY, 'Content-Type': 'application/json'},
        method='POST',
    )
    print('stored', json.load(urllib.request.urlopen(req)))


main()
