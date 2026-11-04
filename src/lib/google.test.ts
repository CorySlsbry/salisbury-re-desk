import { describe, it, expect } from 'vitest';
import { splitAddress, GOOGLE_PERMISSIONS, calendarDuplicates, matchContact, singleFlight, isAppEvent, isAppMadeOrKnown, calendarIncludes, CALENDAR_SCOPES, type GEvent } from './google';

describe('google contacts address split', () => {
  it('splits street, city, state and zip', () => {
    expect(splitAddress('1842 W Harvest Moon Dr, Lehi, UT 84043')).toEqual({ streetAddress: '1842 W Harvest Moon Dr', city: 'Lehi', region: 'UT', postalCode: '84043' });
  });
  it('keeps a unit line with the street', () => {
    expect(splitAddress('123 Main St, Apt 4, Provo, UT 84601')).toEqual({ streetAddress: '123 Main St, Apt 4', city: 'Provo', region: 'UT', postalCode: '84601' });
  });
  it('never invents parts it cannot see', () => {
    expect(splitAddress('PO Box 12')).toEqual({ streetAddress: 'PO Box 12' });
    expect(splitAddress('123 Main St, Lehi')).toEqual({ streetAddress: '123 Main St', city: 'Lehi' });
  });
});

describe('google permissions list', () => {
  it('names every scope the app asks for, in plain words, with no send or delete rights', () => {
    expect(GOOGLE_PERMISSIONS.map(p => p.name)).toEqual(['Calendar', 'Gmail drafts', 'Drive', 'Contacts']);
    for (const p of GOOGLE_PERMISSIONS) { expect(p.scope).toMatch(/^https:\/\/www\.googleapis\.com\/auth\//); expect(p.does.length).toBeGreaterThan(40); }
    expect(GOOGLE_PERMISSIONS.some(p => /gmail\.send|gmail\.readonly|mail\.google\.com|auth\/drive$/.test(p.scope))).toBe(false);
  });
});

const ev = (id: string, summary: string, date: string, created: string, key?: string, desc = 'x\nSalisbury RE Desk'): GEvent => ({ id, summary, description: desc, created, start: { date }, extendedProperties: key ? { private: { redesk_key: key, redesk_tx: '1' } } : undefined });

describe('calendar duplicates (pure)', () => {
  it('keeps the linked copy and removes the twin from a double push', () => {
    const { keep, remove } = calendarDuplicates([ev('a', 'Due Diligence - Whitfield, Sam', '2026-09-20', '2026-09-07T16:23:36Z', 'deadline:1'), ev('b', 'Due Diligence - Whitfield, Sam', '2026-09-20', '2026-09-07T16:23:37Z', 'deadline:1')], new Set(['b']));
    expect(keep.map(e => e.id)).toEqual(['b']); expect(remove.map(e => e.id)).toEqual(['a']);
  });
  it('keeps the oldest when nothing is linked, and folds an untagged older copy into the tagged group', () => {
    const { keep, remove } = calendarDuplicates([ev('old', 'Weekly seller update - Whitfield, Sam', '2026-09-14', '2026-09-07T16:00:00Z'), ev('new', 'Weekly seller update - Whitfield, Sam', '2026-09-14', '2026-09-07T16:30:00Z', 'task:11')], new Set());
    expect(keep.map(e => e.id)).toEqual(['old']); expect(remove.map(e => e.id)).toEqual(['new']);
  });
  it('never treats two different keys or two different days as duplicates', () => {
    const { remove } = calendarDuplicates([ev('a', 'Open house', '2026-09-12', '1', 'open_house:1'), ev('b', 'Open house', '2026-09-12', '2', 'open_house:2'), ev('c', 'Open house', '2026-09-19', '3', 'open_house:1')], new Set());
    expect(remove).toEqual([]);
  });
  it('recognises only events the app made', () => {
    expect(isAppEvent(ev('a', 'x', '2026-09-12', '1', 'deadline:1', 'no signature'))).toBe(true);
    expect(isAppEvent(ev('a', 'x', '2026-09-12', '1'))).toBe(true);
    expect(isAppEvent({ id: 'z', summary: 'Dentist', description: 'personal' })).toBe(false);
  });
});

describe('google contact matching (pure)', () => {
  const me = { id: 7, first_name: 'Sam', last_name: 'Whitfield', email: 'sam@example.com', phone: '(801) 555-0100' };
  it('prefers the contact tagged with the client id, then email, then phone', () => {
    const people = [
      { resourceName: 'people/1', names: [{ givenName: 'Sam', familyName: 'Whitfield' }], emailAddresses: [{ value: 'other@example.com' }] },
      { resourceName: 'people/2', names: [{ givenName: 'Sam', familyName: 'Whitfield' }], emailAddresses: [{ value: 'SAM@example.com' }] },
      { resourceName: 'people/3', names: [{ givenName: 'D', familyName: 'W' }], clientData: [{ key: 'redesk_client_id', value: '7' }] },
    ];
    expect(matchContact(me, people)?.resourceName).toBe('people/3');
    expect(matchContact(me, people.slice(0, 2))?.resourceName).toBe('people/2');
    expect(matchContact({ ...me, email: null }, [{ resourceName: 'people/4', phoneNumbers: [{ value: '+1 801-555-0100' }] }])?.resourceName).toBe('people/4');
  });
  it('does not adopt a same-name contact that clearly belongs to someone else', () => {
    expect(matchContact({ ...me, email: null, phone: null }, [{ resourceName: 'people/9', names: [{ givenName: 'Sam', familyName: 'Whitfield' }], emailAddresses: [{ value: 'person1@example.com' }] }])).toBeNull();
    expect(matchContact({ ...me, email: null, phone: null }, [{ resourceName: 'people/8', names: [{ givenName: 'sam', familyName: 'whitfield' }] }])?.resourceName).toBe('people/8');
  });
});

describe('single flight', () => {
  it('runs one execution for concurrent calls with the same key, then allows a fresh run', async () => {
    let runs = 0;
    const fn = () => new Promise<number>(res => setTimeout(() => res(++runs), 10));
    const [a, b] = await Promise.all([singleFlight('k', fn), singleFlight('k', fn)]);
    expect(a).toBe(1); expect(b).toBe(1); expect(runs).toBe(1);
    expect(await singleFlight('k', fn)).toBe(2);
  });
});

describe('calendar scope (pure)', () => {
  it('is deadlines only by default and when the setting is missing or unknown', () => {
    for (const sc of [undefined, '', 'deadlines', 'nonsense']) { expect(calendarIncludes(sc, 'deadline')).toBe(true); expect(calendarIncludes(sc, 'open_house')).toBe(false); expect(calendarIncludes(sc, 'task')).toBe(false); }
  });
  it('widens step by step and never drops deadlines', () => {
    expect(calendarIncludes('deadlines_open_houses', 'open_house')).toBe(true); expect(calendarIncludes('deadlines_open_houses', 'task')).toBe(false);
    expect(calendarIncludes('all', 'task')).toBe(true);
    for (const [sc] of CALENDAR_SCOPES) expect(calendarIncludes(sc, 'deadline')).toBe(true);
  });
});

describe('calendar purge candidates (pure)', () => {
  const known = new Set(['due diligence deadline - whitfield, sam - 1842 w harvest moon dr, lehi', 'due diligence deadline - whitfield, sam']);
  it('recognises tagged, signed, .ics-imported and app-titled events', () => {
    expect(isAppMadeOrKnown({ id: '1', summary: 'anything', extendedProperties: { private: { redesk_key: 'deadline:1' } } }, known)).toBe(true);
    expect(isAppMadeOrKnown({ id: '2', summary: 'anything', description: 'Salisbury RE Desk' }, known)).toBe(true);
    expect(isAppMadeOrKnown({ id: '3', summary: 'anything', iCalUID: 'deadline-4@salisbury-re-desk' }, known)).toBe(true);
    expect(isAppMadeOrKnown({ id: '4', summary: 'Due Diligence Deadline - Whitfield, Sam', description: '' }, known)).toBe(true);
  });
  it('leaves an event that merely mentions the client alone', () => {
    expect(isAppMadeOrKnown({ id: '5', summary: 'Lunch with Sam Whitfield', description: 'personal' }, known)).toBe(false);
    expect(isAppMadeOrKnown({ id: '6', summary: 'Call Whitfield, Sam about the disclosure', description: '' }, known)).toBe(false);
  });
});
