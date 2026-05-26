import time
from PIL import Image
from app.engines.base import OCREngine, OCRResult


class TesseractEngine(OCREngine):
    id = "tesseract"
    name = "Tesseract"
    provider = "Google (open)"
    category = "Traditional OCR"

    def _lazy_init(self):
        import pytesseract
        self._pytesseract = pytesseract
        # Verify tesseract binary is available
        pytesseract.get_tesseract_version()

    def _recognize(self, image: Image.Image) -> OCRResult:
        start = time.time()
        try:
            data = self._pytesseract.image_to_data(
                image, lang="kat+eng", output_type=self._pytesseract.Output.DICT
            )
            texts = []
            confidences = []
            for i, text in enumerate(data["text"]):
                if text.strip():
                    texts.append(text)
                    conf = data["conf"][i]
                    if isinstance(conf, (int, float)) and conf >= 0:
                        confidences.append(conf)

            full_text = " ".join(texts)
            avg_conf = sum(confidences) / len(confidences) if confidences else None

            return OCRResult(
                text=full_text,
                confidence=round(avg_conf, 2) if avg_conf is not None else None,
                processing_time=round(time.time() - start, 3),
                engine_id=self.id,
                engine_name=self.name,
                metadata={
                    "cost_usd": 0,
                    "pricing_model": "free",
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
