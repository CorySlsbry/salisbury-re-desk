import { describe, it, expect } from 'vitest';
import { parseShowings, interestOf } from './showings';

const EMAIL = `Showing Confirmation - 1842 W Harvest Moon Dr, Lehi
Date: 09/05/2026 Time: 2:00 PM
Showing Agent: Maria Lopez
Brokerage: Summit Sotheby's
Feedback: Buyers loved the kitchen but felt the backyard was too small. Considering a second showing this weekend.

Showing Confirmation - 1842 W Harvest Moon Dr, Lehi
Date: Sep 6, 2026 Time: 11:30 am
Shown by: Dan Ward
Comments: Not interested, too close to the busy road.

Reminder: your listing has 2 showings this week.`;

describe('showing feedback parser (deterministic)', () => {
  it('turns pasted showing emails into rows with date, time, agent, feedback and an interest read', () => {
    const rows = parseShowings(EMAIL, 2026);
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({ shown_on: '2026-09-05', shown_at: '14:00', agent: 'Maria Lopez', interest: 'hot' });
    expect(rows[0].feedback).toMatch(/second showing/);
    expect(rows[1]).toMatchObject({ shown_on: '2026-09-06', shown_at: '11:30', agent: 'Dan Ward', interest: 'cold' });
    expect(rows[0].fingerprint).not.toBe(rows[1].fingerprint);
  });
  it('reads interest only from the words present', () => {
    expect(interestOf(null)).toBe('unknown');
    expect(interestOf('No-show, buyer cancelled')).toBe('no_show');
    expect(interestOf('They liked it, thinking it over')).toBe('warm');
    expect(interestOf('Overpriced for the area')).toBe('cold');
  });
  it('ignores blocks without a date', () => { expect(parseShowings('Hello\n\nThanks for the showing!').length).toBe(0); });
});
