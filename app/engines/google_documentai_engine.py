import io
import os
import time

from PIL import Image
from app.engines.base import OCREngine, OCRResult


class GoogleDocumentAIEngine(OCREngine):
    id = "google-documentai"
    name = "Google Document AI"
    provider = "Google"
    category = "Cloud OCR"

    def _lazy_init(self):
        from google.cloud import documentai_v1
        from google.api_core.client_options import ClientOptions

        self._documentai = documentai_v1

        project_id = os.environ.get("GOOGLE_DOCUMENTAI_PROJECT_ID")
        location = os.environ.get("GOOGLE_DOCUMENTAI_LOCATION", "us")
        processor_id = os.environ.get("GOOGLE_DOCUMENTAI_PROCESSOR_ID")

        if not project_id or not processor_id:
            raise RuntimeError(
                "GOOGLE_DOCUMENTAI_PROJECT_ID and GOOGLE_DOCUMENTAI_PROCESSOR_ID "
                "environment variables are required"
            )

        self._processor_name = (
            f"projects/{project_id}/locations/{location}/processors/{processor_id}"
        )
        self._client = documentai_v1.DocumentProcessorServiceClient(
            client_options=ClientOptions(
                api_endpoint=f"{location}-documentai.googleapis.com"
            )
        )

    def _recognize(self, image: Image.Image) -> OCRResult:
        start = time.time()
        try:
            buf = io.BytesIO()
            image.save(buf, format="PNG")
            image_bytes = buf.getvalue()

            raw_document = self._documentai.RawDocument(
                content=image_bytes, mime_type="image/png"
            )
            request = self._documentai.ProcessRequest(
                name=self._processor_name,
                raw_document=raw_document,
            )
            result = self._client.process_document(request=request)
            document = result.document

            confidence = None
            if document.pages:
                page_confidences = [
                    block.layout.confidence
                    for page in document.pages
                    for block in page.blocks
                    if block.layout.confidence
                ]
                if page_confidences:
                    confidence = round(
                        sum(page_confidences) / len(page_confidences) * 100, 2
                    )

            page_count = len(document.pages) or 1
            return OCRResult(
                text=document.text,
                confidence=confidence,
                processing_time=round(time.time() - start, 3),
                engine_id=self.id,
                engine_name=self.name,
                metadata={
                    "page_count": page_count,
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
