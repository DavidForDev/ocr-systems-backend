import io
import os
import time

import requests
from PIL import Image
from app.engines.base import OCREngine, OCRResult


class NanonetsEngine(OCREngine):
    id = "nanonets"
    name = "Nanonets OCR"
    provider = "Nanonets"
    category = "Cloud OCR"

    def _lazy_init(self):
        self._api_key = os.environ.get("NANONETS_API_KEY")
        self._model_id = os.environ.get(
            "NANONETS_MODEL_ID", "OCR"
        )

        if not self._api_key:
            raise RuntimeError(
                "NANONETS_API_KEY environment variable is required"
            )

    def _recognize(self, image: Image.Image) -> OCRResult:
        start = time.time()
        try:
            buf = io.BytesIO()
            image.save(buf, format="PNG")
            image_bytes = buf.getvalue()

            response = requests.post(
                f"https://app.nanonets.com/api/v2/OCR/Model/{self._model_id}/LabelFile/",
                auth=requests.auth.HTTPBasicAuth(self._api_key, ""),
                files={"file": ("image.png", image_bytes, "image/png")},
            )
            response.raise_for_status()
            data = response.json()

            texts = []
            confidences = []
            for result in data.get("result", []):
                for prediction in result.get("prediction", []):
                    ocr_text = prediction.get("ocr_text", "")
                    if ocr_text.strip():
                        texts.append(ocr_text)
                    conf = prediction.get("confidence")
                    if conf is not None:
                        confidences.append(conf)

            full_text = "\n".join(texts) if texts else ""

            # Nanonets may also return raw_text at the page level
            if not full_text:
                for result in data.get("result", []):
                    page_text = result.get("page_data", [{}])[0].get("raw_text", "")
                    if page_text:
                        full_text = page_text
                        break

            avg_conf = (
                round(sum(confidences) / len(confidences) * 100, 2)
                if confidences
                else None
            )

            return OCRResult(
                text=full_text,
                confidence=avg_conf,
                processing_time=round(time.time() - start, 3),
                engine_id=self.id,
                engine_name=self.name,
                metadata={
                    "model_id": self._model_id,
                    "page_count": 1,
                    "cost_usd": round(3.00 / 1000, 6),
                    "pricing_per_1000_pages": 3.00,
                    "pricing_model": "per_page",
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
