import io
import os
import time

import requests
from PIL import Image
from app.engines.base import OCREngine, OCRResult


class AdobeExtractEngine(OCREngine):
    id = "adobe-pdf-extract"
    name = "Adobe PDF Extract"
    provider = "Adobe"
    category = "Cloud OCR"

    def _lazy_init(self):
        self._client_id = os.environ.get("ADOBE_CLIENT_ID")
        self._client_secret = os.environ.get("ADOBE_CLIENT_SECRET")

        if not self._client_id or not self._client_secret:
            raise RuntimeError(
                "ADOBE_CLIENT_ID and ADOBE_CLIENT_SECRET "
                "environment variables are required"
            )
        self._access_token = None

    def _get_access_token(self) -> str:
        response = requests.post(
            "https://ims-na1.adobelogin.com/ims/token/v3",
            data={
                "client_id": self._client_id,
                "client_secret": self._client_secret,
                "grant_type": "client_credentials",
                "scope": "openid,AdobeID,read_organizations",
            },
        )
        response.raise_for_status()
        self._access_token = response.json()["access_token"]
        return self._access_token

    def _get_headers(self) -> dict:
        if not self._access_token:
            self._get_access_token()
        return {
            "Authorization": f"Bearer {self._access_token}",
            "x-api-key": self._client_id,
        }

    def _recognize(self, image: Image.Image) -> OCRResult:
        start = time.time()
        try:
            buf = io.BytesIO()
            image.save(buf, format="PNG")
            image_bytes = buf.getvalue()

            headers = self._get_headers()

            # Step 1: Get upload URI
            upload_resp = requests.post(
                "https://pdf-services.adobe.io/assets",
                headers={**headers, "Content-Type": "application/json"},
                json={"mediaType": "image/png"},
            )
            upload_resp.raise_for_status()
            upload_data = upload_resp.json()
            upload_uri = upload_data["uploadUri"]
            asset_id = upload_data["assetID"]

            # Step 2: Upload the image
            requests.put(
                upload_uri,
                headers={"Content-Type": "image/png"},
                data=image_bytes,
            ).raise_for_status()

            # Step 3: Create extract job
            job_resp = requests.post(
                "https://pdf-services.adobe.io/operation/extractpdf",
                headers={**headers, "Content-Type": "application/json"},
                json={
                    "assetID": asset_id,
                    "elementsToExtract": ["text"],
                },
            )
            job_resp.raise_for_status()
            job_url = job_resp.headers.get("location") or job_resp.headers.get("x-request-id")

            # Step 4: Poll for result
            full_text = ""
            for _ in range(30):
                time.sleep(2)
                status_resp = requests.get(job_url, headers=headers)
                status_resp.raise_for_status()
                status_data = status_resp.json()

                if status_data.get("status") == "done":
                    download_url = status_data.get("resource", {}).get("downloadUri")
                    if download_url:
                        import zipfile

                        result_resp = requests.get(download_url)
                        result_resp.raise_for_status()
                        with zipfile.ZipFile(io.BytesIO(result_resp.content)) as z:
                            import json

                            if "structuredData.json" in z.namelist():
                                data = json.loads(z.read("structuredData.json"))
                                elements = data.get("elements", [])
                                texts = [
                                    el.get("Text", "")
                                    for el in elements
                                    if el.get("Text")
                                ]
                                full_text = "\n".join(texts)
                    break
                elif status_data.get("status") == "failed":
                    raise RuntimeError(
                        f"Adobe extraction failed: {status_data.get('error', 'Unknown error')}"
                    )

            return OCRResult(
                text=full_text,
                confidence=None,
                processing_time=round(time.time() - start, 3),
                engine_id=self.id,
                engine_name=self.name,
                metadata={
                    "page_count": 1,
                    "cost_usd": round(0.05, 6),
                    "pricing_per_transaction": 0.05,
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
