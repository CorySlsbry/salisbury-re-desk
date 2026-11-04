"""redesk-doc: document engine sidecar. JSON-RPC 2.0 over stdio, one request per line, one response per line.
Methods: ping, pdf.info, pdf.text, pdf.fields, pdf.widgets, pdf.fill, pdf.thumb, ocr.page.
Nothing but responses is ever written to stdout."""
import sys, os, json, base64, hashlib, io, traceback

CHUNK = 1 << 15
# Responses go through a private copy of fd 1; the real stdout is pointed at stderr so any library
# chatter (MuPDF warnings print to stdout) can never corrupt the JSON-RPC stream.
_OUT = os.fdopen(os.dup(1), "wb", buffering=0)
os.dup2(2, 1)
sys.stdout = sys.stderr


def _json(obj):
    return json.dumps(obj, ensure_ascii=False)


def _emit(obj):
    # Binary, chunked writes: one large text-mode print to a Windows pipe can fail with EINVAL.
    data = (_json(obj) + "\n").encode("utf-8")
    for i in range(0, len(data), CHUNK):
        _OUT.write(data[i:i + CHUNK])


def m_ping(p):
    return {"ok": True, "engine": "redesk-doc", "version": "0.2.0"}


def m_pdf_info(p):
    import fitz
    with open(p["path"], "rb") as fh:
        h = hashlib.sha256(fh.read()).hexdigest()
    with fitz.open(p["path"]) as d:
        return {"pages": d.page_count, "sha256": h, "title": d.metadata.get("title"), "has_forms": bool(d.is_form_pdf)}


def m_pdf_text(p):
    import fitz
    out = []
    with fitz.open(p["path"]) as d:
        for i, page in enumerate(d):
            if p.get("pages") and (i + 1) not in p["pages"]:
                continue
            entry = {"page": i + 1, "width": page.rect.width, "height": page.rect.height, "text": page.get_text("text"), "words": None}
            if p.get("words"):
                entry["words"] = [[round(w[0], 1), round(w[1], 1), round(w[2], 1), round(w[3], 1), w[4]] for w in page.get_text("words")]
            out.append(entry)
    return {"pages": out}


def m_pdf_fields(p):
    """AcroForm values by field name (pypdf, exact)."""
    from pypdf import PdfReader
    r = PdfReader(p["path"])
    fields = r.get_fields() or {}
    res = {}
    for name, f in fields.items():
        v = f.get("/V")
        res[name] = {"value": None if v is None else str(v), "type": str(f.get("/FT"))}
    return {"count": len(res), "fields": res}


def m_pdf_widgets(p):
    """Every widget with page, rect, type, value and the label text to its left (PyMuPDF)."""
    import fitz
    out = []
    with fitz.open(p["path"]) as d:
        for pno, page in enumerate(d):
            words = page.get_text("words")
            for w in page.widgets():
                r = w.rect
                cy = (r.y0 + r.y1) / 2
                left = [x for x in words if abs((x[1] + x[3]) / 2 - cy) < 5 and x[2] <= r.x0 + 2 and x[0] > r.x0 - 260]
                left.sort(key=lambda x: x[0])
                out.append({"page": pno + 1, "name": w.field_name, "type": w.field_type_string, "value": w.field_value,
                            "rect": [round(r.x0, 1), round(r.y0, 1), round(r.x1, 1), round(r.y1, 1)],
                            "label": " ".join(x[4] for x in left)[-80:]})
    return {"count": len(out), "widgets": out}


def m_pdf_fill(p):
    """Fill AcroForm fields {name: value} and save to out_path. flatten=True bakes the values in."""
    import fitz
    values = p.get("values") or {}
    with fitz.open(p["path"]) as d:
        n = 0
        for page in d:
            for w in page.widgets():
                if w.field_name in values:
                    v = values[w.field_name]
                    if w.field_type_string == "CheckBox":
                        w.field_value = bool(v)
                    else:
                        w.field_value = "" if v is None else str(v)
                    w.update()
                    n += 1
        if p.get("flatten"):
            d.bake(annots=True, widgets=True)  # values become page content; text layer stays real text
        d.save(p["out_path"], garbage=3, deflate=True)
    return {"filled": n, "out_path": p["out_path"]}


def m_pdf_stamp(p):
    """Type values onto a FLAT form (no AcroForm): items = [{page, x, y, text, size?, box?}] where (x, y) is the
    baseline in PDF points, or box = [x0, y0, x1, y1] to fit the text inside a blank. Saves to out_path."""
    import fitz
    with fitz.open(p["path"]) as d:
        n = 0
        for it in p.get("items") or []:
            text = "" if it.get("text") is None else str(it["text"])
            if not text:
                continue
            page = d[int(it.get("page", 1)) - 1]
            size = float(it.get("size", 8.5))
            color = tuple(it.get("color", (0.05, 0.05, 0.45)))
            if it.get("box"):
                x0, y0, x1, y1 = it["box"]
                # shrink until it fits on one line inside the blank
                while size > 5.5 and fitz.get_text_length(text, fontname="helv", fontsize=size) > (x1 - x0 - 4):
                    size -= 0.5
                page.insert_text((x0 + 2, y1 - 2.5), text, fontsize=size, fontname="helv", color=color)
            else:
                page.insert_text((float(it["x"]), float(it["y"])), text, fontsize=size, fontname="helv", color=color)
            n += 1
        d.save(p["out_path"], garbage=3, deflate=True)
    return {"stamped": n, "out_path": p["out_path"]}


def m_pdf_make(p):
    """Build a simple letter-size PDF from text blocks: blocks = [{text, size?, bold?, gap?}]. Used for the client
    questionnaire, packet cover sheets and the Complete File index."""
    import fitz
    d = fitz.open()
    page = d.new_page(width=612, height=792)
    y = 54
    for b in p.get("blocks") or []:
        text = str(b.get("text", ""))
        size = float(b.get("size", 10.5))
        font = "hebo" if b.get("bold") else "helv"
        rect = fitz.Rect(54, y, 558, 760)
        used = page.insert_textbox(rect, text, fontsize=size, fontname=font, color=(0, 0, 0), align=0)
        if used < 0:  # did not fit: new page and retry
            page = d.new_page(width=612, height=792); y = 54
            rect = fitz.Rect(54, y, 558, 760)
            used = page.insert_textbox(rect, text, fontsize=size, fontname=font, color=(0, 0, 0), align=0)
        y = 760 - used + float(b.get("gap", 6))
        if y > 720:
            page = d.new_page(width=612, height=792); y = 54
    d.save(p["out_path"], garbage=3, deflate=True)
    return {"pages": d.page_count, "out_path": p["out_path"]}


def m_pdf_rasterize(p):
    """Render every page to an image-only PDF (simulates a scan). dpi default 150."""
    import fitz
    out = fitz.open()
    with fitz.open(p["path"]) as d:
        for page in d:
            pix = page.get_pixmap(dpi=p.get("dpi", 150))
            pg = out.new_page(width=page.rect.width, height=page.rect.height)
            pg.insert_image(pg.rect, pixmap=pix)
    out.save(p["out_path"], deflate=True)
    return {"pages": out.page_count, "out_path": p["out_path"]}


def m_pdf_thumb(p):
    import fitz
    with fitz.open(p["path"]) as d:
        page = d[p.get("page", 1) - 1]
        clip = fitz.Rect(*p["bbox"]) if p.get("bbox") else None
        pix = page.get_pixmap(dpi=p.get("dpi", 72), clip=clip)
        return {"png_b64": base64.b64encode(pix.tobytes("png")).decode(), "w": pix.width, "h": pix.height}


_ocr = None


def m_ocr_page(p):
    global _ocr
    import fitz
    if _ocr is None:
        from rapidocr_onnxruntime import RapidOCR
        _ocr = RapidOCR()
    with fitz.open(p["path"]) as d:
        page = d[p.get("page", 1) - 1]
        pix = page.get_pixmap(dpi=p.get("dpi", 200))
        img = pix.tobytes("png")
    import numpy as np
    from PIL import Image
    arr = np.array(Image.open(io.BytesIO(img)).convert("RGB"))
    result, _ = _ocr(arr)
    lines = [{"box": [[round(x, 1), round(y, 1)] for x, y in r[0]], "text": r[1], "conf": round(float(r[2]), 3)} for r in (result or [])]
    return {"page": p.get("page", 1), "dpi": p.get("dpi", 200), "lines": lines, "text": "\n".join(l["text"] for l in lines)}


METHODS = {
    "ping": m_ping, "pdf.info": m_pdf_info, "pdf.text": m_pdf_text, "pdf.fields": m_pdf_fields,
    "pdf.widgets": m_pdf_widgets, "pdf.fill": m_pdf_fill, "pdf.stamp": m_pdf_stamp, "pdf.make": m_pdf_make, "pdf.rasterize": m_pdf_rasterize, "pdf.thumb": m_pdf_thumb, "ocr.page": m_ocr_page,
}


def main():
    for raw in sys.stdin.buffer:
        line = raw.decode("utf-8", "replace").strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            fn = METHODS.get(req.get("method"))
            if fn is None:
                raise ValueError("unknown method %s" % req.get("method"))
            _emit({"jsonrpc": "2.0", "id": rid, "result": fn(req.get("params") or {})})
        except Exception as e:  # noqa: BLE001
            _emit({"jsonrpc": "2.0", "id": rid, "error": {"code": -32000, "message": str(e), "data": traceback.format_exc()[-800:]}})


if __name__ == "__main__":
    main()
