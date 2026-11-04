import { describe, it, expect } from 'vitest';
import { folderFor, KIND_FOLDER, KIND_LABEL } from './documents';

describe('document filing map', () => {
  it('files every known kind into a numbered subfolder that the app creates', () => {
    const folders = new Set(['00 Intake', '01 Agreements', '02 Disclosures', '03 Contract & Addenda', '04 Inspection & Appraisal', '05 Title & Closing', '06 Communications']);
    for (const f of Object.values(KIND_FOLDER)) expect(folders.has(f)).toBe(true);
    expect(folderFor('repc')).toBe('03 Contract & Addenda');
    expect(folderFor('spcd')).toBe('02 Disclosures');
    expect(folderFor('nonsense')).toBe('00 Intake');
  });
  it('every kind offered in the Add document picker has a folder', () => {
    for (const [k] of KIND_LABEL) expect(KIND_FOLDER[k]).toBeTruthy();
  });
});
