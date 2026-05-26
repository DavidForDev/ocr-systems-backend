from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from PIL import Image


@dataclass
class OCRResult:
    text: str
    confidence: float | None = None
    processing_time: float = 0.0
    engine_id: str = ""
    engine_name: str = ""
    error: str | None = None
    metadata: dict = field(default_factory=dict)


class OCREngine(ABC):
    id: str
    name: str
    provider: str
    category: str

    def __init__(self):
        self._initialized = False
        self._prompt: str | None = None

    def _lazy_init(self):
        """Override this to load models on first use."""
        pass

    def ensure_initialized(self):
        if not self._initialized:
            self._lazy_init()
            self._initialized = True

    @abstractmethod
    def _recognize(self, image: Image.Image) -> OCRResult:
        """Run OCR on a PIL Image and return the result."""
        ...

    def recognize(self, image: Image.Image, prompt: str | None = None) -> OCRResult:
        self.ensure_initialized()
        self._prompt = prompt
        return self._recognize(image)

    def info(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "provider": self.provider,
            "category": self.category,
        }
