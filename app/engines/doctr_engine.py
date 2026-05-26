import time
import numpy as np
from PIL import Image
from app.engines.base import OCREngine, OCRResult


class DocTREngine(OCREngine):
    id = "doctr"
    name = "docTR"
    provider = "Mindee (open)"
    category = "Document OCR"

    def _lazy_init(self):
        from doctr.models import ocr_predictor
        self._model = ocr_predictor(pretrained=True)

    def _recognize(self, image: Image.Image) -> OCRResult:
        start = time.time()
        try:
            img_array = np.array(image)
            result = self._model([img_array])
            output = result.export()

            texts = []
            confidences = []
            for page in output["pages"]:
                for block in page["blocks"]:
                    for line in block["lines"]:
                        line_text = " ".join(w["value"] for w in line["words"])
                        texts.append(line_text)
                        for word in line["words"]:
                            confidences.append(word["confidence"])

            full_text = "\n".join(texts)
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
