import base64
import io
import os
import time

from PIL import Image
from app.engines.base import OCREngine, OCRResult

# Pricing per 1M tokens (USD)
MISTRAL_PRICING = {
    "pixtral-large-latest": {"input": 2.00, "output": 6.00},
    "pixtral-12b-2409": {"input": 0.15, "output": 0.15},
}


class _MistralVisionBase(OCREngine):
    provider = "Mistral"
    category = "Cloud LLM OCR"
    _model_id: str

    def _lazy_init(self):
        from mistralai import Mistral

        api_key = os.environ.get("MISTRAL_API_KEY")
        if not api_key:
            raise RuntimeError("MISTRAL_API_KEY environment variable is required")

        self._client = Mistral(api_key=api_key)

    def _calculate_cost(self, input_tokens: int, output_tokens: int) -> float:
        pricing = MISTRAL_PRICING.get(self._model_id, {"input": 0.15, "output": 0.15})
        cost = (input_tokens * pricing["input"] + output_tokens * pricing["output"]) / 1_000_000
        return round(cost, 6)

    def _recognize(self, image: Image.Image) -> OCRResult:
        start = time.time()
        try:
            buf = io.BytesIO()
            image.save(buf, format="PNG")
            image_b64 = base64.b64encode(buf.getvalue()).decode()

            prompt = self._prompt or (
                "Extract all text from this image exactly as it appears. "
                "Return only the raw extracted text, no formatting or explanation."
            )
            response = self._client.chat.complete(
                model=self._model_id,
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "text",
                                "text": prompt,
                            },
                            {
                                "type": "image_url",
                                "image_url": {
                                    "url": f"data:image/png;base64,{image_b64}"
                                },
                            },
                        ],
                    }
                ],
            )
            full_text = response.choices[0].message.content or ""

            input_tokens = 0
            output_tokens = 0
            total_tokens = 0
            if hasattr(response, "usage") and response.usage:
                input_tokens = getattr(response.usage, "prompt_tokens", 0) or 0
                output_tokens = getattr(response.usage, "completion_tokens", 0) or 0
                total_tokens = getattr(response.usage, "total_tokens", 0) or 0

            cost = self._calculate_cost(input_tokens, output_tokens)
            pricing = MISTRAL_PRICING.get(self._model_id, {"input": 0.15, "output": 0.15})

            return OCRResult(
                text=full_text.strip(),
                confidence=None,
                processing_time=round(time.time() - start, 3),
                engine_id=self.id,
                engine_name=self.name,
                metadata={
                    "model": self._model_id,
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "total_tokens": total_tokens,
                    "cost_usd": cost,
                    "pricing_per_1m_input": pricing["input"],
                    "pricing_per_1m_output": pricing["output"],
                    "pricing_model": "per_token",
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


class MistralPixtralLargeEngine(_MistralVisionBase):
    id = "mistral-pixtral-large"
    name = "Mistral Pixtral Large"
    _model_id = "pixtral-large-latest"


class MistralPixtral12BEngine(_MistralVisionBase):
    id = "mistral-pixtral-12b"
    name = "Mistral Pixtral 12B"
    _model_id = "pixtral-12b-2409"
