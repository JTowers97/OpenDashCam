"""
Open Dash Cam ML service: turns video frames and search phrases into CLIP embeddings, so the ODC server
can find footage by what's in it ("red pickup truck", "bridge", "snow"). Runs only on your server;
images never leave it. The model (default: clip-ViT-B-32) downloads on first start into /cache.

API (internal; don't expose this port to the internet):
  GET  /health        -> {"ready": bool, "model": str, "dim": int, "error": str|null}
  POST /embed/image   body: JPEG/PNG bytes  -> {"embedding": [float, ...]}   (unit length)
  POST /embed/text    body: {"text": "..."} -> {"embedding": [float, ...]}   (unit length)
  POST /plates        body: JPEG/PNG bytes  -> {"plates": [{"text", "confidence", "box": [x1, y1, x2, y2]}]}
                      License plate reading (fast-alpr). Its models load on first use only, so they cost
                      nothing unless plate search is turned on in the ODC server.
"""
import io
import json
import logging
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
from PIL import Image

MODEL_NAME = os.environ.get("ODC_ML_MODEL", "clip-ViT-B-32")
PORT = int(os.environ.get("PORT", "3003"))
THREADS = int(os.environ.get("ODC_ML_THREADS", "0")) or max(1, (os.cpu_count() or 2) // 2)
FAKE = os.environ.get("ODC_ML_FAKE") == "1"  # deterministic stand-in model, for tests only
MAX_BODY = 15 * 1024 * 1024

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("odc-ml")


class FakeModel:
    """Embeds images by average colour and text by colour words. Only for automated tests."""
    dim = 512
    COLORS = {"red": (1, 0, 0), "green": (0, 1, 0), "blue": (0, 0, 1), "white": (1, 1, 1), "black": (0.05, 0.05, 0.05)}

    def _vec(self, rgb):
        v = np.zeros(self.dim, dtype=np.float32)
        v[:3] = rgb
        v[3] = 0.15  # shared component so unrelated things still score a little
        return v / np.linalg.norm(v)

    def images(self, imgs):
        return np.stack([self._vec(np.asarray(im.convert("RGB"), dtype=np.float32).reshape(-1, 3).mean(0) / 255) for im in imgs])

    def text(self, t):
        words = t.lower().split()
        rgb = next((self.COLORS[w] for w in words if w in self.COLORS), (0.3, 0.3, 0.3))
        return self._vec(rgb)


class FakePlates:
    """Reports plate "RED 123" in mostly-red images. Only for automated tests."""

    def read(self, img):
        r, g, b = np.asarray(img.convert("RGB"), dtype=np.float32).reshape(-1, 3).mean(0)
        if r > 150 and g < 100 and b < 100:
            return [{"text": "RED123", "confidence": 0.93, "box": [10, 10, 90, 40]}]
        return []


class AlprModel:
    def __init__(self):
        from fast_alpr import ALPR

        self.alpr = ALPR(
            detector_model=os.environ.get("ODC_PLATE_DETECTOR", "yolo-v9-t-384-license-plate-end2end"),
            ocr_model=os.environ.get("ODC_PLATE_OCR", "cct-xs-v1-global-model"),
        )

    def read(self, img):
        frame = np.asarray(img.convert("RGB"))[:, :, ::-1].copy()  # RGB -> BGR, as OpenCV expects
        out = []
        for r in self.alpr.predict(frame):
            ocr = getattr(r, "ocr", None)
            if ocr is None or not getattr(ocr, "text", None):
                continue
            conf = ocr.confidence
            if isinstance(conf, (list, tuple, np.ndarray)):  # some versions report per-character confidence
                conf = float(np.mean(conf)) if len(conf) else 0.0
            box = getattr(getattr(r, "detection", None), "bounding_box", None)
            coords = [int(getattr(box, k)) for k in ("x1", "y1", "x2", "y2")] if box is not None else None
            out.append({"text": str(ocr.text), "confidence": round(float(conf), 3), "box": coords})
        return out


class ClipModel:
    def __init__(self, name):
        import torch
        from sentence_transformers import SentenceTransformer

        torch.set_num_threads(THREADS)
        self.model = SentenceTransformer(name, device="cpu")
        self.dim = int(self.model.encode(["test"], convert_to_numpy=True).shape[1])

    def images(self, imgs):
        return self.model.encode(imgs, convert_to_numpy=True, normalize_embeddings=True, batch_size=8)

    def text(self, t):
        return self.model.encode([t], convert_to_numpy=True, normalize_embeddings=True)[0]


state = {"model": None, "error": None, "plates": None, "plates_error": None}
plates_lock = threading.Lock()


def plate_model():
    """Loads the plate reader on first use."""
    if state["plates"] is None and state["plates_error"] is None:
        with plates_lock:
            if state["plates"] is None and state["plates_error"] is None:
                try:
                    log.info("Loading license plate models…")
                    state["plates"] = FakePlates() if FAKE else AlprModel()
                    log.info("License plate models ready")
                except Exception as e:  # noqa: BLE001
                    state["plates_error"] = f"{type(e).__name__}: {e}"
                    log.exception("License plate models failed to load")
    return state["plates"]
lock = threading.Lock()  # one inference at a time keeps memory and CPU predictable


def load():
    try:
        log.info("Loading %s model %s (%d threads)…", "fake" if FAKE else "CLIP", MODEL_NAME, THREADS)
        state["model"] = FakeModel() if FAKE else ClipModel(MODEL_NAME)
        log.info("Model ready (%d dimensions)", state["model"].dim)
    except Exception as e:  # noqa: BLE001
        state["error"] = f"{type(e).__name__}: {e}"
        log.exception("Model failed to load")


class Handler(BaseHTTPRequestHandler):
    server_version = "odc-ml/1.0"

    def log_message(self, fmt, *args):  # quieter logs
        pass

    def _send(self, status, obj):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > MAX_BODY:
            raise ValueError("missing or oversized body")
        return self.rfile.read(n)

    def do_GET(self):
        if self.path == "/health":
            m = state["model"]
            return self._send(200, {"ready": m is not None, "model": "fake" if FAKE else MODEL_NAME,
                                    "dim": getattr(m, "dim", None), "error": state["error"],
                                    "plates": {"loaded": state["plates"] is not None, "error": state["plates_error"]}})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path == "/plates":
            try:
                img = Image.open(io.BytesIO(self._body()))
                img.load()
            except Exception as e:  # noqa: BLE001
                return self._send(400, {"error": f"{type(e).__name__}: {e}"})
            pm = plate_model()
            if pm is None:
                return self._send(503, {"error": state["plates_error"] or "plate models unavailable"})
            try:
                with lock:
                    plates = pm.read(img)
            except Exception as e:  # noqa: BLE001
                return self._send(500, {"error": f"{type(e).__name__}: {e}"})
            return self._send(200, {"plates": plates})
        m = state["model"]
        if m is None:
            return self._send(503, {"error": state["error"] or "model is still loading"})
        try:
            if self.path == "/embed/image":
                img = Image.open(io.BytesIO(self._body()))
                img.load()
                with lock:
                    vec = m.images([img])[0]
            elif self.path == "/embed/text":
                text = str(json.loads(self._body()).get("text", "")).strip()[:300]
                if not text:
                    return self._send(400, {"error": "text is required"})
                with lock:
                    vec = m.text(text)
            else:
                return self._send(404, {"error": "not found"})
        except Exception as e:  # noqa: BLE001
            return self._send(400, {"error": f"{type(e).__name__}: {e}"})
        self._send(200, {"embedding": [round(float(x), 6) for x in vec]})


if __name__ == "__main__":
    threading.Thread(target=load, daemon=True).start()
    log.info("Listening on port %d", PORT)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
