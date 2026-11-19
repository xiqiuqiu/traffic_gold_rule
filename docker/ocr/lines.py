from contextlib import asynccontextmanager
from importlib.metadata import version
from io import BytesIO
from pathlib import Path
from threading import Lock

import numpy as np
from fastapi import FastAPI, HTTPException, Request
from PIL import Image, UnidentifiedImageError
from starlette.concurrency import run_in_threadpool

DETECTOR = "PP-OCRv6_medium_det"
RECOGNIZER = "PP-OCRv6_medium_rec"
ENGINE = f"PaddleOCR-{version('paddleocr')}/{DETECTOR}+{RECOGNIZER}/original-pixels-v1"
MAX_BYTES = 25_000_000
MAX_PIXELS = 16_000_000
inference_lock = Lock()


@asynccontextmanager
async def lifespan(app):
    from paddleocr import PaddleOCR

    det, rec = (Path("/models", name) for name in (DETECTOR, RECOGNIZER))
    if not (det.is_dir() and rec.is_dir()):
        raise RuntimeError("Missing local PP-OCRv6 models in /models")
    # Lines are reported in the submitted PNG's coordinate system.
    app.state.engine = PaddleOCR(
        text_detection_model_name=DETECTOR, text_detection_model_dir=str(det),
        text_recognition_model_name=RECOGNIZER, text_recognition_model_dir=str(rec),
        use_doc_orientation_classify=False, use_doc_unwarping=False, use_textline_orientation=False,
    )
    yield


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None)


@app.get("/healthz")
def health():
    return {"engine": ENGINE}


def recognize(data):
    with inference_lock:
        try:
            with Image.open(BytesIO(data)) as image:
                width, height = image.size
                if image.format != "PNG":
                    raise HTTPException(415, "PNG required")
                if width * height > MAX_PIXELS:
                    raise HTTPException(413, "page pixel limit exceeded")
                # Paddle's ndarray input uses BGR channel order.
                bgr = np.asarray(image.convert("RGB"))[:, :, ::-1].copy()
        except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
            raise HTTPException(422, "invalid PNG")

        result, = app.state.engine.predict(bgr)
        lines = [
            {"text": text, "rawBox": box.tolist(), "confidence": float(score)}
            for text, box, score in zip(result["rec_texts"], result["rec_boxes"], result["rec_scores"], strict=True)
        ]
        return {"width": width, "height": height, "engine": ENGINE, "lines": lines}


@app.post("/v1/ocr/lines")
async def ocr_lines(request: Request):
    if request.headers.get("content-type", "").split(";")[0] != "image/png":
        raise HTTPException(415, "PNG required")
    data = bytearray()
    async for chunk in request.stream():
        if len(data) + len(chunk) > MAX_BYTES:
            raise HTTPException(413, "page byte limit exceeded")
        data.extend(chunk)
    return await run_in_threadpool(recognize, data)
