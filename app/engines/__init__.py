from app.engines.base import OCREngine, OCRResult
from app.engines.surya_engine import SuryaEngine
from app.engines.google_documentai_engine import GoogleDocumentAIEngine
from app.engines.mistral_ocr_engine import MistralOCREngine
from app.engines.gemini_engine import (
    Gemini31FlashLiteEngine,
)
from app.engines.mistral_vision_engine import (
    MistralPixtralLargeEngine,
    MistralPixtral12BEngine,
)

ENGINE_CLASSES = [
    # Local / Open-source
    SuryaEngine,
    # Google
    GoogleDocumentAIEngine,
    # Gemini LLM OCR
    Gemini31FlashLiteEngine,
    # Mistral
    MistralOCREngine,
    MistralPixtralLargeEngine,
    MistralPixtral12BEngine,
]


def load_engines() -> dict[str, OCREngine]:
    """Register all engines instantly. Models load lazily on first use."""
    engines = {}
    for cls in ENGINE_CLASSES:
        engine = cls()
        engines[engine.id] = engine
        print(f"[REGISTERED] {engine.name}")
    return engines
