import time
import numpy as np
from PIL import Image
from app.engines.base import OCREngine, OCRResult


class EasyOCREngine(OCREngine):
    id = "easyocr"
    name = "EasyOCR"
    provider = "JaidedAI (open)"
    category = "Traditional OCR"

    def _lazy_init(self):
        import easyocr
        # Georgian ('ka') is not in EasyOCR's supported list.
        # Use English + Cyrillic as closest available; Georgian script
        # will be attempted through the general character recognition.
        self._reader = easyocr.Reader(["en"], gpu=False)

    def _recognize(self, image: Image.Image) -> OCRResult:
        start = time.time()
        try:
            img_array = np.array(image)
            results = self._reader.readtext(img_array)

            texts = []
            confidences = []
            for bbox, text, conf in results:
                texts.append(text)
                confidences.append(conf)

            full_text = " ".join(texts)
            avg_conf = sum(confidences) / len(confidences) if confidences else None

            return OCRResult(
                text=full_text,
                confidence=round(avg_conf * 100, 2) if avg_conf is not None else None,
                processing_time=round(time.time() - start, 3),
                engine_id=self.id,
                engine_name=self.name,
                metadata={"note": "Georgian not supported by EasyOCR; using English fallback", "cost_usd": 0, "pricing_model": "free"},
            )
        except Exception as e:
            return OCRResult(
                text="",
                processing_time=round(time.time() - start, 3),
                engine_id=self.id,
                engine_name=self.name,
                error=str(e),
            )
