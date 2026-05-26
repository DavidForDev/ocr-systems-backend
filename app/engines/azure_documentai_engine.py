import io
import os
import time

from PIL import Image
from app.engines.base import OCREngine, OCRResult


class AzureDocumentIntelligenceEngine(OCREngine):
    id = "azure-document-intelligence"
    name = "Azure Document Intelligence"
    provider = "Microsoft"
    category = "Cloud OCR"

    def _lazy_init(self):
        from azure.ai.formrecognizer import DocumentAnalysisClient
        from azure.core.credentials import AzureKeyCredential

        endpoint = os.environ.get("AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT")
        key = os.environ.get("AZURE_DOCUMENT_INTELLIGENCE_KEY")

        if not endpoint or not key:
            raise RuntimeError(
                "AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT and "
                "AZURE_DOCUMENT_INTELLIGENCE_KEY environment variables are required"
            )

        self._client = DocumentAnalysisClient(
            endpoint=endpoint,
            credential=AzureKeyCredential(key),
        )

    def _recognize(self, image: Image.Image) -> OCRResult:
        start = time.time()
        try:
            buf = io.BytesIO()
            image.save(buf, format="PNG")
            image_bytes = buf.getvalue()

            poller = self._client.begin_analyze_document(
                "prebuilt-read", document=image_bytes
            )
            result = poller.result()

            full_text = result.content or ""

            confidences = []
            for page in result.pages:
                for word in page.words:
                    if word.confidence is not None:
                        confidences.append(word.confidence)

            avg_conf = (
                round(sum(confidences) / len(confidences) * 100, 2)
                if confidences
                else None
            )

            page_count = len(result.pages) or 1
            return OCRResult(
                text=full_text,
                confidence=avg_conf,
                processing_time=round(time.time() - start, 3),
                engine_id=self.id,
                engine_name=self.name,
                metadata={
                    "page_count": page_count,
                    "word_count": len(confidences),
                    "cost_usd": round(page_count * 1.50 / 1000, 6),
                    "pricing_per_1000_pages": 1.50,
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
