"""Make a realistic, fully filled sample listing agreement (fake people, fake address) for testing Intake.
Typed onto the real UAR Form 8 the way an e-signed copy prints. Output: Downloads\SAMPLE listing agreement - Whitfield 1842 W Harvest Moon Dr.pdf

Run:  python tests/make_sample_listing.py [fee_pct] [out_path]
"""
import os, sys, datetime
import fitz

UAR = r"C:\Users\you\Documents\Salisbury RE\Forms\UAR"
LISTING = "Exclusive Right to Sell Listing Agreement & Agency Disclosure (Designated Agency Brokerage) (rev November 5, 2024).pdf"
fee = sys.argv[1] if len(sys.argv) > 1 else "1.99"
out = sys.argv[2] if len(sys.argv) > 2 else os.path.expanduser(r"~\Downloads\SAMPLE listing agreement - Whitfield 1842 W Harvest Moon Dr.pdf")

today = datetime.date.today()
signed = today.strftime("%-m/%-d/%Y") if os.name != "nt" else f"{today.month}/{today.day}/{today.year}"
ends = today.replace(year=today.year + (1 if today.month >= 7 else 0), month=(today.month + 6 - 1) % 12 + 1)
ends_s = ends.strftime("%B ") + str(ends.day) + ends.strftime(", %Y")

# (page, x, baseline_y, text, size)
VALUES = [
    (1, 40, 154, "Simple Choice Real Estate", 8.5), (1, 314, 154, "Cory Salisbury", 8.5), (1, 237, 168, "Sam R. Whitfield and Pat S. Whitfield", 8.5),
    (1, 194, 200, "1842 W Harvest Moon Dr, Lehi, Utah 84043", 8.5), (1, 40, 212, "Utah County", 8.5),
    (1, 317, 236, ends_s, 8.5),
    (1, 470, 328, fee, 8.5), (1, 545, 328, "0", 8.5),          # 2.1 brokerage fee % and $
    (1, 541, 364, "1.0", 8.5), (1, 60, 376, "0", 8.5),         # 2.2 unrepresented buyer add-on
    (1, 40, 412, "2.5", 8.5), (1, 96, 412, "0", 8.5),          # 2.3 offer to buyer brokerage
    (4, 40, 268, "Sam R. Whitfield", 9), (4, 256, 268, "1842 W Harvest Moon Dr, Lehi UT  (801) 555-0142   " + signed, 8),
    (4, 40, 304, "Pat S. Whitfield", 9), (4, 256, 304, "same  (801) 555-0143   " + signed, 8),
    (4, 56, 377, "Cory Salisbury", 9), (4, 292, 377, signed, 8.5),
]
INITIALS = [(p, 262, 761, "DW  PW", 7) for p in (1, 2, 3, 4)]

d = fitz.open(os.path.join(UAR, LISTING))
for page, x, y, text, size in VALUES + INITIALS:
    d[page - 1].insert_text((x, y), text, fontsize=size, fontname="helv", color=(0.05, 0.05, 0.45))
d[0].insert_text((40, 40), "SAMPLE - FAKE DATA FOR TESTING", fontsize=7, fontname="helv", color=(0.7, 0, 0))
d.save(out)
print(out, "| fee", fee, "| signed", signed, "| ends", ends_s)
