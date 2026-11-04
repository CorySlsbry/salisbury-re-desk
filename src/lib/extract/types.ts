/** Shared extraction shapes. Every extracted value carries provenance so the review screen can show the crop. */
export type Tier = 1 | 2 | 3;

export interface Extracted<T = string> {
  value: T | null;
  raw?: string;
  page?: number;
  bbox?: [number, number, number, number]; // PDF points (72/in) on that page
  tier: Tier;
  confidence: number; // 0..1
  note?: string;
}

/** A positioned text token: from the PDF text layer (words) or OCR (lines), normalised to PDF points. */
export interface Token { text: string; page: number; x0: number; y0: number; x1: number; y1: number }

export interface RepcFields {
  buyer_names: Extracted; seller_names: Extracted;
  offer_reference_date: Extracted;           // ISO or null
  property_street: Extracted; property_city: Extracted; property_county: Extracted; property_zip: Extracted; property_tax_id: Extracted;
  purchase_price: Extracted<number>; earnest_money: Extracted<number>; earnest_money_form: Extracted;
  is_cash: Extracted<boolean>;
  seller_agent: Extracted; seller_agent_license: Extracted; seller_brokerage: Extracted;
  buyer_agent: Extracted; buyer_agent_license: Extracted; buyer_brokerage: Extracted;
  seller_disclosure_deadline: Extracted; due_diligence_deadline: Extracted; financing_appraisal_deadline: Extracted; settlement_deadline: Extracted;
  offer_expires_date: Extracted; offer_expires_time: Extracted;
  buyer_signed_on: Extracted; seller_signed_on: Extracted; acceptance_on: Extracted;
  additional_emd: Extracted<number>;
}

export interface ExtractionResult { kind: 'repc'; version: string; tier: Tier; fields: RepcFields; warnings: string[] }

/** Listing agreement (UAR Form 8) and Exclusive Buyer-Broker Agreement (UAR Form 6). Flat PDFs: tiers 2 and 3 only. */
export type AgreementKind = 'listing_agreement' | 'bba';
export interface AgreementFields {
  company: Extracted; agent: Extracted;
  client_names: Extracted;                  // Seller(s) on the listing, Buyer(s) on the BBA
  property_street: Extracted; property_city: Extracted; property_county: Extracted; property_zip: Extracted; // listing: the Property; BBA: "located only at" (optional)
  search_area: Extracted;                   // BBA 1.2 counties
  end_date: Extracted;                      // ISO: agreement ENDS 5:00 PM Mountain
  fee_pct: Extracted<number>; fee_flat: Extracted<number>;
  coop_offer_pct: Extracted<number>; coop_offer_flat: Extracted<number>; // listing 2.3 only
  client_phone: Extracted; client_address: Extracted;
  client_signed_on: Extracted; agent_signed_on: Extracted;
  form_revision: Extracted;                 // e.g. "11.5.2024"
}
export interface AgreementExtraction { kind: AgreementKind; version: string; tier: Tier; fields: AgreementFields; warnings: string[] }
