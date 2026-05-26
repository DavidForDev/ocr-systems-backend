import io
import os
import time
import xml.etree.ElementTree as ET

import requests
from PIL import Image
from app.engines.base import OCREngine, OCRResult


class ABBYYCloudEngine(OCREngine):
    id = "abbyy-cloud"
    name = "ABBYY Cloud OCR"
    provider = "ABBYY"
    category = "Cloud OCR"

    BASE_URL = "https://cloud-westus.ocrsdk.com/v2"

    def _lazy_init(self):
        self._app_id = os.environ.get("ABBYY_APPLICATION_ID")
        self._password = os.environ.get("ABBYY_PASSWORD")

        if not self._app_id or not self._password:
            raise RuntimeError(
                "ABBYY_APPLICATION_ID and ABBYY_PASSWORD "
                "environment variables are required"
            )

    def _recognize(self, image: Image.Image) -> OCRResult:
        start = time.time()
        try:
            buf = io.BytesIO()
            image.save(buf, format="PNG")
            image_bytes = buf.getvalue()

            # Step 1: Submit image for processing
            submit_resp = requests.post(
                f"{self.BASE_URL}/processImage",
                auth=(self._app_id, self._password),
                params={
                    "language": "English",
                    "exportFormat": "txt",
                },
                files={"file": ("image.png", image_bytes, "image/png")},
            )
            submit_resp.raise_for_status()

            root = ET.fromstring(submit_resp.text)
            ns = {"abbyy": "http://ocrsdk.com/schema/taskDescription-1.0.xsd"}
            task = root.find(".//abbyy:task", ns) or root
            task_id = task.get("id")
            if not task_id:
                raise RuntimeError("Failed to get task ID from ABBYY response")

            # Step 2: Poll for completion
            result_url = None
            for _ in range(30):
                time.sleep(2)
                status_resp = requests.get(
                    f"{self.BASE_URL}/getTaskStatus",
                    auth=(self._app_id, self._password),
                    params={"taskId": task_id},
                )
                status_resp.raise_for_status()

                root = ET.fromstring(status_resp.text)
                task = root.find(".//abbyy:task", ns) or root
                status = task.get("status")

                if status == "Completed":
                    result_url = task.get("resultUrl")
                    break
                elif status in ("ProcessingFailed", "NotEnoughCredits"):
                    raise RuntimeError(f"ABBYY processing failed: {status}")

            if not result_url:
                raise RuntimeError("ABBYY processing timed out")

            # Step 3: Download result
            result_resp = requests.get(result_url)
            result_resp.raise_for_status()
            full_text = result_resp.text

            return OCRResult(
                text=full_text.strip(),
                confidence=None,
                processing_time=round(time.time() - start, 3),
                engine_id=self.id,
                engine_name=self.name,
                metadata={
                    "task_id": task_id,
                    "page_count": 1,
                    "cost_usd": round(1.20 / 1000, 6),
                    "pricing_per_1000_pages": 1.20,
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
