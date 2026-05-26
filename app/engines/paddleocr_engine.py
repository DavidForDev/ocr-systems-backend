import time
import numpy as np
from PIL import Image
from app.engines.base import OCREngine, OCRResult


class PaddleOCREngine(OCREngine):
    id = "paddleocr"
    name = "PaddleOCR"
    provider = "Baidu (open)"
    category = "Traditional OCR"

    def _lazy_init(self):
        from paddleocr import PaddleOCR
        self._ocr = PaddleOCR(lang="ka")

    def _recognize(self, image: Image.Image) -> OCRResult:
        start = time.time()
        try:
            img_array = np.array(image)
            results = list(self._ocr.predict(img_array))

            texts = []
            confidences = []
            if results:
                r = results[0]
                rec_texts = r.get("rec_texts", [])
                rec_scores = r.get("rec_scores", [])
                for i, text in enumerate(rec_texts):
                    if text.strip():
                        texts.append(text)
                        if i < len(rec_scores):
                            confidences.append(float(rec_scores[i]))

            full_text = " ".join(texts)
            avg_conf = sum(confidences) / len(confidences) if confidences else None

            return OCRResult(
                text=full_text,
                confidence=round(avg_conf * 100, 2) if avg_conf is not None else None,
                processing_time=round(time.time() - start, 3),
                engine_id=self.id,
                engine_name=self.name,
                metadata={"cost_usd": 0, "pricing_model": "free"},
            )
        except Exception as e:
            return OCRResult(
                text="",
                processing_time=round(time.time() - start, 3),
                engine_id=self.id,
                engine_name=self.name,
                error=str(e),
            )
