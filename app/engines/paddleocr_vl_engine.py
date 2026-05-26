import time
import numpy as np
from PIL import Image
from app.engines.base import OCREngine, OCRResult


class PaddleOCRVLEngine(OCREngine):
    id = "paddleocr-vl"
    name = "PaddleOCR-VL"
    provider = "Baidu (open)"
    category = "Vision OCR"

    def _lazy_init(self):
        from paddleocr import PaddleOCRVL
        self._ocr = PaddleOCRVL()

    def _recognize(self, image: Image.Image) -> OCRResult:
        start = time.time()
        try:
            img_array = np.array(image)
            results = list(self._ocr.predict(img_array))

            texts = []
            if results:
                r = results[0]
                if "rec_texts" in r:
                    texts = [t for t in r["rec_texts"] if t.strip()]
                elif hasattr(r, "str"):
                    texts.append(str(r.str))

            full_text = "\n".join(texts)

            return OCRResult(
                text=full_text,
                confidence=None,
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
