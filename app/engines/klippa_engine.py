import io
import os
import time

import requests
from PIL import Image
from app.engines.base import OCREngine, OCRResult


class KlippaOCREngine(OCREngine):
    id = "klippa-ocr"
    name = "Klippa OCR"
    provider = "Klippa"
    category = "Cloud OCR"

    def _lazy_init(self):
        self._api_key = os.environ.get("KLIPPA_API_KEY")

        if not self._api_key:
            raise RuntimeError(
                "KLIPPA_API_KEY environment variable is required"
            )

    def _recognize(self, image: Image.Image) -> OCRResult:
        start = time.time()
        try:
            buf = io.BytesIO()
            image.save(buf, format="PNG")
            image_bytes = buf.getvalue()

            response = requests.post(
                "https://custom-ocr.klippa.com/api/v1/parseDocument",
                headers={"X-Auth-Key": self._api_key},
                files={"document": ("image.png", image_bytes, "image/png")},
                data={"pdf_text_extraction": "full"},
            )
            response.raise_for_status()
            data = response.json()

            parsed = data.get("data", {}).get("parsed", {})
            full_text = parsed.get("text", "")

            # Try to get text from components if top-level text is empty
            if not full_text:
                components = parsed.get("components", [])
                texts = [c.get("value", "") for c in components if c.get("value")]
                full_text = "\n".join(texts)

            confidence = None
            raw_confidence = parsed.get("confidence")
            if raw_confidence is not None:
                confidence = round(float(raw_confidence) * 100, 2)

            return OCRResult(
                text=full_text,
                confidence=confidence,
                processing_time=round(time.time() - start, 3),
                engine_id=self.id,
                engine_name=self.name,
                metadata={
                    "page_count": 1,
                    "cost_usd": 0,
                    "pricing_model": "custom",
                },
            )
        except Exception as e:
            return OCRResult(
                text="",
                processing_time=round(time.time() - start, 3),
                engine_id=self.id,
                engine_name=self.name,
                error=str(e),
            )
