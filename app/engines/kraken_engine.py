import time
import glob
import os
from PIL import Image
from app.engines.base import OCREngine, OCRResult


class KrakenEngine(OCREngine):
    id = "kraken"
    name = "Kraken"
    provider = "Open source"
    category = "Traditional OCR"

    def _lazy_init(self):
        from kraken import blla, rpred
        from kraken.lib import models
        self._blla = blla
        self._rpred = rpred
        self._models_lib = models

        # Find downloaded model in htrmopo cache
        htrmopo_dir = os.path.expanduser(
            "~/Library/Application Support/htrmopo"
        )
        model_files = glob.glob(os.path.join(htrmopo_dir, "**/*.mlmodel"), recursive=True)
        if not model_files:
            raise RuntimeError(
                "No Kraken model found. Run: kraken get 10.5281/zenodo.10602357"
            )
        self._model_path = model_files[0]
        self._rec_model = self._models_lib.load_any(self._model_path)

    def _recognize(self, image: Image.Image) -> OCRResult:
        start = time.time()
        try:
            bw_image = image.convert("L")
            baseline_seg = self._blla.segment(bw_image)
            pred_it = self._rpred.rpred(self._rec_model, bw_image, baseline_seg)

            texts = []
            confidences = []
            for record in pred_it:
                texts.append(record.prediction)
                if hasattr(record, "confidences") and record.confidences:
                    confidences.extend(record.confidences)

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
