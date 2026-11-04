"""Build agreement fixtures: type values onto the blank UAR listing agreement and buyer-broker agreement
(the way a signed-and-printed copy looks), then dump the text layer with word geometry and an OCR pass of
a simulated scan. The blank UAR forms are member-only and are NOT committed; only the derived JSON is.

Run from the repo root:  python tests/make_agreement_fixtures.py
"""
import io, json, os, sys
import fitz

UAR = r"C:\Users\you\Documents\Salisbury RE\Forms\UAR"
OUT = os.path.join(os.path.dirname(__file__), "fixtures")
LISTING = "Exclusive Right to Sell Listing Agreement & Agency Disclosure (Designated Agency Brokerage) (rev November 5, 2024).pdf"
BBA = "Exclusive Buyer-Broker Agreement & Agency Disclosure (Designated Agency Brokerage) (rev June 20, 2024).pdf"

# (page, x, baseline_y, text) -- baselines sit 2pt above the underline so the value reads like typed-on-the-line
LISTING_VALUES = [
    (1, 40, 154, "Simple Choice Real Estate"), (1, 314, 154, "Cory Salisbury"), (1, 237, 168, "Sam R. Whitfield and Pat S. Whitfield"),
    (1, 194, 200, "1842 W Harvest Moon Dr, Lehi, Utah 84043"), (1, 40, 212, "Utah County"),
    (1, 317, 236, "March 5, 2027"),
    (1, 470, 328, "2.5"), (1, 545, 328, "0"), (1, 541, 364, "0"), (1, 60, 376, "0"), (1, 40, 412, "2.5"), (1, 96, 412, "0"),
    (4, 40, 268, "Sam R. Whitfield"), (4, 256, 268, "1842 W Harvest Moon Dr, Lehi UT  (801) 555-0142   9/5/2026"),
    (4, 40, 304, "Pat S. Whitfield"), (4, 256, 304, "same  (801) 555-0143   9/5/2026"),
    (4, 56, 377, "Cory Salisbury"), (4, 292, 377, "9/5/2026"),
]
BBA_VALUES = [
    (1, 26, 133, "Simple Choice Real Estate"), (1, 282, 133, "Cory Salisbury"), (1, 182, 145, "Jordan M. Reyes and Avery L. Reyes"),
    (1, 21, 218, "March 5, 2027"), (1, 149, 263, "Utah and Salt Lake"),
    (1, 184, 497, "0"), (1, 261, 497, "2.5"),
    (3, 26, 349, "Jordan M. Reyes"), (3, 242, 349, "77 E 400 S, Provo UT  (385) 555-0199"), (3, 494, 349, "9/5/2026"),
    (3, 26, 380, "Avery L. Reyes"), (3, 242, 380, "same  (385) 555-0198"), (3, 494, 380, "9/5/2026"),
    (3, 39, 451, "Cory Salisbury"), (3, 314, 451, "9/5/2026"),
]


def fill(src, values, out_pdf):
    d = fitz.open(os.path.join(UAR, src))
    for page, x, y, text in values:
        d[page - 1].insert_text((x, y), text, fontsize=8.5, fontname="helv", color=(0, 0, 0.5))
    d.save(out_pdf)
    d.close()


def dump_text(pdf, out_json):
    d = fitz.open(pdf)
    pages = []
    for i, page in enumerate(d):
        pages.append({"page": i + 1, "width": page.rect.width, "height": page.rect.height, "text": page.get_text("text"),
                      "words": [[round(w[0], 1), round(w[1], 1), round(w[2], 1), round(w[3], 1), w[4]] for w in page.get_text("words")]})
    json.dump({"pages": pages}, open(out_json, "w", encoding="utf-8"), ensure_ascii=False)
    d.close()


def scan(pdf, out_pdf, dpi=150):
    """Rasterise and re-wrap as an image-only PDF (a phone scan without a text layer)."""
    d = fitz.open(pdf)
    out = fitz.open()
    for page in d:
        pix = page.get_pixmap(dpi=dpi)
        img = fitz.open("png", pix.tobytes("png"))
        rect = page.rect
        p = out.new_page(width=rect.width, height=rect.height)
        p.insert_image(rect, stream=pix.tobytes("png"))
        img.close()
    out.save(out_pdf)
    out.close(); d.close()


def ocr(pdf, page, out_json, dpi=200):
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "sidecar", "doc"))
    import server  # the same code the app ships
    res = server.m_ocr_page({"path": pdf, "page": page, "dpi": dpi})
    json.dump(res, open(out_json, "w", encoding="utf-8"), ensure_ascii=False)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for name, src, values, pages in [("listing", LISTING, LISTING_VALUES, [1, 4]), ("bba", BBA, BBA_VALUES, [1, 3])]:
        filled = os.path.join(OUT, f"{name}-filled.pdf")
        fill(src, values, filled)
        dump_text(filled, os.path.join(OUT, f"{name}-filled.text.json"))
        scanned = os.path.join(OUT, f"{name}-scan.pdf")
        scan(filled, scanned)
        for p in pages:
            ocr(scanned, p, os.path.join(OUT, f"{name}-scan.p{p}.ocr.json"))
        print(name, "ok")
