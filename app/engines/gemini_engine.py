import io
import os
import time

from PIL import Image
from app.engines.base import OCREngine, OCRResult

# Pricing per 1M tokens (USD)
GEMINI_PRICING = {
    "gemini-2.5-flash-lite": {"input": 0.075, "output": 0.30},
    "gemini-2.5-flash": {"input": 0.15, "output": 0.60},
    "gemini-3.0-flash": {"input": 0.15, "output": 0.60},
    "gemini-3.1-flash-lite": {"input": 0.075, "output": 0.30},
    "gemini-3.1-pro": {"input": 1.25, "output": 5.00},
}


class _GeminiBase(OCREngine):
    provider = "Google"
    category = "Cloud LLM OCR"
    _model_id: str

    def _lazy_init(self):
        import google.generativeai as genai

        api_key = os.environ.get("GEMINI_API_KEY")
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY environment variable is required")

        genai.configure(api_key=api_key)
        self._genai = genai
        self._model = genai.GenerativeModel(self._model_id)

    def _calculate_cost(self, input_tokens: int, output_tokens: int) -> float:
        pricing = GEMINI_PRICING.get(self._model_id, {"input": 0.15, "output": 0.60})
        cost = (input_tokens * pricing["input"] + output_tokens * pricing["output"]) / 1_000_000
        return round(cost, 6)

    def _recognize(self, image: Image.Image) -> OCRResult:
        start = time.time()
        try:
            prompt = self._prompt or (
                "Extract all text from this image exactly as it appears. "
                "Return only the raw extracted text, no formatting or explanation."
            )
            response = self._model.generate_content([prompt, image])
            full_text = response.text or ""

            input_tokens = 0
            output_tokens = 0
            total_tokens = 0
            if hasattr(response, "usage_metadata") and response.usage_metadata:
                um = response.usage_metadata
                input_tokens = getattr(um, "prompt_token_count", 0) or 0
                output_tokens = getattr(um, "candidates_token_count", 0) or 0
                total_tokens = getattr(um, "total_token_count", 0) or 0

            cost = self._calculate_cost(input_tokens, output_tokens)
            pricing = GEMINI_PRICING.get(self._model_id, {"input": 0.15, "output": 0.60})

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


class Gemini25FlashLiteEngine(_GeminiBase):
    id = "gemini-2.5-flash-lite"
    name = "Gemini 2.5 Flash-Lite"
    _model_id = "gemini-2.5-flash-lite"


class Gemini25FlashEngine(_GeminiBase):
    id = "gemini-2.5-flash"
    name = "Gemini 2.5 Flash"
    _model_id = "gemini-2.5-flash"


class Gemini3FlashEngine(_GeminiBase):
    id = "gemini-3-flash"
    name = "Gemini 3 Flash"
    _model_id = "gemini-3.0-flash"


class Gemini31FlashLiteEngine(_GeminiBase):
    id = "gemini-3.1-flash-lite"
    name = "Gemini 3.1 Flash-Lite"
    _model_id = "gemini-3.1-flash-lite"


class Gemini31ProEngine(_GeminiBase):
    id = "gemini-3.1-pro"
    name = "Gemini 3.1 Pro"
    _model_id = "gemini-3.1-pro"
