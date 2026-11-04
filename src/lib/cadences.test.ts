import { describe, it, expect } from 'vitest';
import { planCadence, fill, type CadenceStep } from './cadences';

const steps: CadenceStep[] = [
  { id: 1, day_offset: 1, anchor: 'start', kind: 'email', title: 'Email 1: Welcome', body_template: 'Hi {{first_name}}', weekdays_only: 1 },
  { id: 2, day_offset: 2, anchor: 'start', kind: 'call', title: 'Call {{first_name}}', body_template: null, weekdays_only: 1 },
  { id: 3, day_offset: -3, anchor: 'due_diligence', kind: 'task', title: 'Repairs done before 5 PM DD', body_template: null, weekdays_only: 0 },
  { id: 4, day_offset: 3, anchor: 'start', kind: 'task', title: 'Submit listing file to Simple Choice', body_template: null, weekdays_only: 0 },
];

describe('cadence planning', () => {
  it('fills merge fields and pushes weekday-only steps off the weekend', () => {
    const t = planCadence(steps.slice(0, 2), { start: '2026-09-04' }, { first_name: 'Jordan' }); // Friday
    expect(t[0].due_on).toBe('2026-09-07'); // Sat -> Mon
    expect(t[0].body).toBe('Hi Jordan');
    expect(t[1].title).toBe('Call Jordan');
  });
  it('skips steps whose anchor is unknown and plans them once it exists', () => {
    expect(planCadence([steps[2]], { start: '2026-09-04' })).toHaveLength(0);
    expect(planCadence([steps[2]], { start: '2026-09-04', due_diligence: '2026-09-18' })[0].due_on).toBe('2026-09-15');
  });
  it('broker steps land on business days with high priority', () => {
    const t = planCadence([steps[3]], { start: '2026-09-04' });
    expect(t[0].due_on).toBe('2026-09-08'); // 9/7 is Labor Day
    expect(t[0].priority).toBe('high');
  });
  it('fill leaves unknown vars visible', () => { expect(fill('{{x}}', {})).toBe('[x]'); });
});
