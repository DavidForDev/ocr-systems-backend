import time
from PIL import Image
from app.engines.base import OCREngine, OCRResult


class SuryaEngine(OCREngine):
    id = "surya"
    name = "Surya"
    provider = "Datalab (open)"
    category = "Layout OCR"

    def _lazy_init(self):
        from surya.foundation import FoundationPredictor
        from surya.recognition import RecognitionPredictor
        from surya.detection import DetectionPredictor

        foundation = FoundationPredictor()
        self._rec_predictor = RecognitionPredictor(foundation)
        self._det_predictor = DetectionPredictor()

    def _recognize(self, image: Image.Image) -> OCRResult:
        start = time.time()
        try:
            predictions = self._rec_predictor(
                [image], det_predictor=self._det_predictor
            )

            texts = []
            confidences = []
            if predictions:
                for pred in predictions:
                    for line in pred.text_lines:
                        texts.append(line.text)
                        if line.confidence is not None:
                            confidences.append(line.confidence)

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
