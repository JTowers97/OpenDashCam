"""
Blurs license plates and/or faces in a video, entirely on your server.

Frames are decoded with ffmpeg, a detector runs on about six frames a second, and every detected region is
pixelated (strong enough not to be readable) on all frames between detections, so plates and faces stay
covered as they move. The result is re-encoded as H.264. Audio is copied unchanged.

Detectors (loaded on first use):
  plates: the license plate detector from fast-alpr (the same models as plate search)
  faces:  YuNet (OpenCV), a small face detector downloaded into /cache on first use
"""
import json
import logging
import os
import subprocess
import threading
import urllib.request

import numpy as np

log = logging.getLogger("odc-ml")
CACHE = os.environ.get("HF_HOME", "/cache")
YUNET_URL = os.environ.get(
    "ODC_FACE_MODEL_URL",
    "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
)
DETECT_FPS = float(os.environ.get("ODC_BLUR_DETECT_FPS", "6"))


class FakeDetector:
    """For tests: finds pure-red (plates) or pure-green (faces) markers and reports a box around each."""

    def __init__(self, channel):
        self.channel = channel

    def boxes(self, frame):
        b, g, r = frame[:, :, 0].astype(int), frame[:, :, 1].astype(int), frame[:, :, 2].astype(int)
        mask = (r > 200) & (g < 60) & (b < 60) if self.channel == "red" else (g > 200) & (r < 60) & (b < 60)
        ys, xs = np.nonzero(mask)
        if len(xs) < 20:
            return []
        cx, cy = int(xs.mean()), int(ys.mean())
        return [(cx - 40, cy - 25, cx + 40, cy + 25)]


class PlateDetector:
    def __init__(self, alpr_model):
        self.alpr = alpr_model.alpr

    def boxes(self, frame):
        det = getattr(self.alpr, "detector", None)
        results = det.predict(frame) if det is not None else [r.detection for r in self.alpr.predict(frame)]
        out = []
        for r in results:
            bb = getattr(r, "bounding_box", None)
            if bb is not None:
                out.append((int(bb.x1), int(bb.y1), int(bb.x2), int(bb.y2)))
        return out


class FaceDetector:
    def __init__(self):
        import cv2

        path = os.path.join(CACHE, "face_detection_yunet.onnx")
        if not os.path.exists(path):
            log.info("Downloading face detection model…")
            os.makedirs(CACHE, exist_ok=True)
            urllib.request.urlretrieve(YUNET_URL, path + ".tmp")
            os.replace(path + ".tmp", path)
        self.cv2 = cv2
        self.net = cv2.FaceDetectorYN.create(path, "", (320, 320), 0.6, 0.3, 5000)

    def boxes(self, frame):
        h, w = frame.shape[:2]
        scale = min(1.0, 960 / max(w, h))  # detect on a smaller copy for speed
        small = frame if scale == 1.0 else self.cv2.resize(frame, (int(w * scale), int(h * scale)))
        self.net.setInputSize((small.shape[1], small.shape[0]))
        _, faces = self.net.detect(small)
        out = []
        for f in faces if faces is not None else []:
            x, y, fw, fh = (float(v) / scale for v in f[:4])
            out.append((int(x), int(y), int(x + fw), int(y + fh)))
        return out


def pixelate(frame, box, pad):
    """Pixelates a region (grown by `pad` of its size) so text and faces can't be read."""
    import cv2

    h, w = frame.shape[:2]
    x1, y1, x2, y2 = box
    bw, bh = x2 - x1, y2 - y1
    x1 = max(0, int(x1 - bw * pad)); y1 = max(0, int(y1 - bh * pad))
    x2 = min(w, int(x2 + bw * pad)); y2 = min(h, int(y2 + bh * pad))
    if x2 - x1 < 2 or y2 - y1 < 2:
        return
    roi = frame[y1:y2, x1:x2]
    block = max(6, min(x2 - x1, y2 - y1) // 6)
    small = cv2.resize(roi, (max(1, (x2 - x1) // block), max(1, (y2 - y1) // block)), interpolation=cv2.INTER_AREA)
    roi[:] = cv2.GaussianBlur(cv2.resize(small, (x2 - x1, y2 - y1), interpolation=cv2.INTER_NEAREST), (0, 0), block / 2)


def probe(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                        "stream=width,height,r_frame_rate,nb_frames:stream_side_data=rotation", "-show_entries", "format=duration",
                        "-of", "json", path], capture_output=True, text=True, check=True)
    info = json.loads(r.stdout)
    s = info["streams"][0]
    num, den = (int(x) for x in s.get("r_frame_rate", "30/1").split("/"))
    fps = num / den if den else 30.0
    rot = 0
    for sd in s.get("side_data_list", []) or []:
        if "rotation" in sd:
            rot = int(sd["rotation"])
    w, h = int(s["width"]), int(s["height"])
    if abs(rot) % 180 == 90:  # ffmpeg rotates frames upright when decoding
        w, h = h, w
    dur = float(info.get("format", {}).get("duration") or 0)
    frames = int(s.get("nb_frames") or 0) or int(dur * fps)
    return w, h, fps, frames


def blur_video(src, dst, detectors, progress=lambda p: None):
    """detectors: list of (detector, pad). Writes dst (H.264 MP4). Returns number of regions blurred."""
    w, h, fps, total = probe(src)
    frame_bytes = w * h * 3
    dec = subprocess.Popen(["ffmpeg", "-v", "error", "-i", src, "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=frame_bytes * 2)
    tmp = dst + ".part.mp4"
    enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}", "-r", f"{fps:.6f}",
                            "-i", "-", "-i", src, "-map", "0:v", "-map", "1:a?", "-c:v", "libx264", "-preset", "veryfast",
                            "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart", "-shortest", tmp],
                           stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    every = max(1, round(fps / DETECT_FPS))
    buffered = []       # frames since the last detection, waiting for the next one
    prev_boxes = []     # [(box, pad)] from the previous detection
    regions = 0
    idx = 0

    def detect(frame):
        found = []
        for det, pad in detectors:
            found += [(b, pad) for b in det.boxes(frame)]
        return found

    def flush(frames, boxes):
        nonlocal regions
        for f in frames:
            for b, pad in boxes:
                pixelate(f, b, pad)
            regions += len(boxes)
            enc.stdin.write(f.tobytes())

    try:
        while True:
            raw = dec.stdout.read(frame_bytes)
            if len(raw) < frame_bytes:
                break
            frame = np.frombuffer(raw, np.uint8).reshape(h, w, 3).copy()
            if idx % every == 0:
                boxes = detect(frame)
                # Frames between two detections get the regions from both, so moving objects stay covered.
                flush(buffered, prev_boxes + boxes)
                buffered = []
                flush([frame], prev_boxes + boxes)
                prev_boxes = boxes
            else:
                buffered.append(frame)
            idx += 1
            if total and idx % 15 == 0:
                progress(min(0.99, idx / total))
        flush(buffered, prev_boxes)
        enc.stdin.close()
        err = enc.stderr.read().decode(errors="replace")
        if enc.wait() != 0:
            raise RuntimeError(f"encoder failed: {err[-300:]}")
        os.replace(tmp, dst)
        progress(1.0)
        return regions
    finally:
        dec.kill()
        if os.path.exists(tmp):
            os.remove(tmp)


class BlurJobs:
    """One blur at a time, in a background thread; the ODC server polls for progress."""

    def __init__(self, plate_model_fn, fake):
        self.jobs = {}
        self.lock = threading.Lock()
        self.queue = []
        self.cv = threading.Condition(self.lock)
        self.plate_model_fn = plate_model_fn
        self.fake = fake
        self.faces = None
        threading.Thread(target=self._run, daemon=True).start()

    def submit(self, job_id, src, dst, plates, faces):
        with self.lock:
            self.jobs[job_id] = {"status": "queued", "progress": 0.0, "error": None, "regions": 0}
            self.queue.append((job_id, src, dst, plates, faces))
            self.cv.notify()

    def get(self, job_id):
        with self.lock:
            return dict(self.jobs.get(job_id) or {})

    def _detectors(self, plates, faces):
        dets = []
        if plates:
            if self.fake:
                dets.append((FakeDetector("red"), 0.15))
            else:
                pm = self.plate_model_fn()
                if pm is None:
                    raise RuntimeError("license plate models unavailable")
                dets.append((PlateDetector(pm), 0.25))
        if faces:
            if self.fake:
                dets.append((FakeDetector("green"), 0.15))
            else:
                if self.faces is None:
                    self.faces = FaceDetector()
                dets.append((self.faces, 0.3))
        return dets

    def _run(self):
        while True:
            with self.lock:
                while not self.queue:
                    self.cv.wait()
                job_id, src, dst, plates, faces = self.queue.pop(0)
                self.jobs[job_id]["status"] = "running"

            def prog(p, j=job_id):
                with self.lock:
                    self.jobs[j]["progress"] = round(p, 3)
            try:
                regions = blur_video(src, dst, self._detectors(plates, faces), prog)
                with self.lock:
                    self.jobs[job_id].update(status="done", progress=1.0, regions=regions)
            except Exception as e:  # noqa: BLE001
                log.exception("Blur failed")
                with self.lock:
                    self.jobs[job_id].update(status="failed", error=f"{type(e).__name__}: {e}")
            # Keep finished jobs for a while, then forget them.
            with self.lock:
                if len(self.jobs) > 200:
                    for k in [k for k, v in self.jobs.items() if v["status"] in ("done", "failed")][:100]:
                        del self.jobs[k]
