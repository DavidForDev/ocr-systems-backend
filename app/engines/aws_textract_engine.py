import io
import os
import time

from PIL import Image
from app.engines.base import OCREngine, OCRResult


class AWSTextractEngine(OCREngine):
    id = "aws-textract"
    name = "AWS Textract"
    provider = "Amazon"
    category = "Cloud OCR"

    def _lazy_init(self):
        import boto3

        self._client = boto3.client(
            "textract",
            aws_access_key_id=os.environ.get("AWS_ACCESS_KEY_ID"),
            aws_secret_access_key=os.environ.get("AWS_SECRET_ACCESS_KEY"),
            region_name=os.environ.get("AWS_REGION", "us-east-1"),
        )

    def _prepare_image(self, image: Image.Image) -> bytes:
        """Resize if needed and convert to JPEG for Textract (max 10MB, min 50x50)."""
        # Ensure minimum dimensions
        w, h = image.size
        if w < 50 or h < 50:
            image = image.resize((max(w, 50), max(h, 50)))

        # Resize if image is very large (Textract limit is 10MB)
        max_dim = 4000
        if w > max_dim or h > max_dim:
            image.thumbnail((max_dim, max_dim))

        # Save as JPEG (smaller than PNG, well-supported by Textract)
        buf = io.BytesIO()
        image.save(buf, format="JPEG", quality=95)
        image_bytes = buf.getvalue()

        # If still too large, reduce quality
        if len(image_bytes) > 10_000_000:
            buf = io.BytesIO()
            image.save(buf, format="JPEG", quality=70)
            image_bytes = buf.getvalue()

        return image_bytes

    def _recognize(self, image: Image.Image) -> OCRResult:
        start = time.time()
        try:
            image_bytes = self._prepare_image(image)

            response = self._client.detect_document_text(
                Document={"Bytes": image_bytes}
            )

            lines = []
            confidences = []
            for block in response.get("Blocks", []):
                if block["BlockType"] == "LINE":
                    lines.append(block.get("Text", ""))
                    confidences.append(block.get("Confidence", 0))

            full_text = "\n".join(lines)
            avg_conf = (
                sum(confidences) / len(confidences) if confidences else None
            )

            return OCRResult(
                text=full_text,
                confidence=round(avg_conf, 2) if avg_conf is not None else None,
                processing_time=round(time.time() - start, 3),
                engine_id=self.id,
                engine_name=self.name,
                metadata={
                    "block_count": len(response.get("Blocks", [])),
                    "page_count": 1,
                    "cost_usd": round(1.50 / 1000, 6),
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
