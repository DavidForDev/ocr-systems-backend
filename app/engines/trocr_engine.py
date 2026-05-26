import time
from PIL import Image
from app.engines.base import OCREngine, OCRResult


class TrOCREngine(OCREngine):
    id = "trocr"
    name = "TrOCR"
    provider = "Microsoft (open)"
    category = "Transformer OCR"

    def _lazy_init(self):
        from transformers import TrOCRProcessor, VisionEncoderDecoderModel
        # Use base model (smaller, faster) instead of large
        model_name = "microsoft/trocr-base-printed"
        self._processor = TrOCRProcessor.from_pretrained(model_name)
        self._model = VisionEncoderDecoderModel.from_pretrained(model_name)

    def _recognize(self, image: Image.Image) -> OCRResult:
        start = time.time()
        try:
            rgb_image = image.convert("RGB")
            pixel_values = self._processor(
                images=rgb_image, return_tensors="pt"
            ).pixel_values
            generated_ids = self._model.generate(pixel_values, max_new_tokens=512)
            text = self._processor.batch_decode(
                generated_ids, skip_special_tokens=True
            )[0]

            return OCRResult(
                text=text,
                confidence=None,
                processing_time=round(time.time() - start, 3),
                engine_id=self.id,
                engine_name=self.name,
                metadata={"note": "English-only model; Georgian not natively supported", "cost_usd": 0, "pricing_model": "free"},
            )
        except Exception as e:
            return OCRResult(
                text="",
                processing_time=round(time.time() - start, 3),
                engine_id=self.id,
                engine_name=self.name,
                error=str(e),
            )
