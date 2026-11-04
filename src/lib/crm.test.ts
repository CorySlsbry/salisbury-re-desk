import { describe, it, expect } from 'vitest';
import { splitName, inboxToClient, digits } from './crm';
import { routeFor, DEFAULT_ROUTE } from './providers';

describe('crm mapping (pure)', () => {
  it('splits a website lead name and maps tags to an interest', () => {
    expect(splitName('Sam R. Whitfield')).toEqual({ first: 'Sam R.', last: 'Whitfield' });
    expect(splitName('Cher')).toEqual({ first: 'Cher', last: '(website)' });
    expect(splitName('')).toEqual({ first: 'Unknown', last: 'Lead' });
    const c = inboxToClient({ crm_id: 'lead:1', kind: 'lead', name: 'Pat Whitfield', email: 'pat@example.com', phone: '(801) 555-0100', source: 'lead-magnet', magnet: 'seller-playbook', tags: 'seller-playbook-download,lead-magnet', notes: null, received_at: '2026-09-09T15:00:00Z', status: 'new', client_id: null, pulled_at: '' });
    expect(c).toMatchObject({ first_name: 'Pat', last_name: 'Whitfield', stage: 'lead', source: 'website', interest: 'seller', lead_received_at: '2026-09-09' });
    expect(c.notes).toContain('Website lead: seller-playbook');
    expect(digits('+1 (801) 555-0100')).toBe('8015550100');
  });
});

describe('model routing (pure)', () => {
  it('stays local unless Claude is switched on, then uses Haiku for reads and Sonnet for writing by default', () => {
    expect(routeFor({}, 'agents')).toMatchObject({ provider: 'local', model: 'local' });
    expect(routeFor({ ai_provider: 'claude' }, 'extraction')).toMatchObject({ provider: 'claude', model: 'haiku' });
    expect(routeFor({ ai_provider: 'claude' }, 'drafts')).toMatchObject({ provider: 'claude', model: 'sonnet' });
    expect(routeFor({ ai_provider: 'claude', ai_model_drafts: 'local' }, 'drafts')).toMatchObject({ provider: 'local' });
    expect(routeFor({ ai_provider: 'claude', ai_model_packet: 'sonnet' }, 'packet').model).toBe('sonnet');
    expect(routeFor({ ai_provider: 'claude', ai_model_packet: 'gpt' }, 'packet').model).toBe(DEFAULT_ROUTE.packet);
  });
});
