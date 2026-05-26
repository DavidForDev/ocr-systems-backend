import base64
import io
import os
import time

from PIL import Image
from app.engines.base import OCREngine, OCRResult

COST_PER_1000_PAGES = 1.00


class MistralOCREngine(OCREngine):
    id = "mistral-ocr"
    name = "Mistral OCR"
    provider = "Mistral"
    category = "Cloud OCR"

    def _lazy_init(self):
        from mistralai import Mistral

        api_key = os.environ.get("MISTRAL_API_KEY")
        if not api_key:
            raise RuntimeError("MISTRAL_API_KEY environment variable is required")

        self._client = Mistral(api_key=api_key)

    def _recognize(self, image: Image.Image) -> OCRResult:
        start = time.time()
        try:
            buf = io.BytesIO()
            image.save(buf, format="PNG")
            image_b64 = base64.b64encode(buf.getvalue()).decode()

            result = self._client.ocr.process(
                model="mistral-ocr-latest",
                document={
                    "type": "image_url",
                    "image_url": f"data:image/png;base64,{image_b64}",
                },
            )

            pages_text = []
            for page in result.pages:
                pages_text.append(page.markdown)

            full_text = "\n\n".join(pages_text)
            page_count = len(result.pages)
            cost = round(page_count * COST_PER_1000_PAGES / 1000, 6)

            input_tokens = 0
            output_tokens = 0
            total_tokens = 0
            if hasattr(result, "usage") and result.usage:
                input_tokens = getattr(result.usage, "prompt_tokens", 0) or 0
                output_tokens = getattr(result.usage, "completion_tokens", 0) or 0
                total_tokens = getattr(result.usage, "total_tokens", 0) or 0

            return OCRResult(
                text=full_text,
                confidence=None,
                processing_time=round(time.time() - start, 3),
                engine_id=self.id,
                engine_name=self.name,
                metadata={
                    "model": "mistral-ocr-latest",
                    "page_count": page_count,
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "total_tokens": total_tokens,
                    "cost_usd": cost,
                    "pricing_per_1000_pages": COST_PER_1000_PAGES,
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
