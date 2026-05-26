import json
import os


def extract_fields(ocr_text: str, schema_fields: list[str]) -> dict:
    """Extract structured fields from OCR text using an available LLM."""
    api_key = os.environ.get("MISTRAL_API_KEY")
    if api_key:
        return _extract_with_mistral(ocr_text, schema_fields, api_key)

    api_key = os.environ.get("OPENAI_API_KEY")
    if api_key:
        return _extract_with_openai(ocr_text, schema_fields, api_key)

    # Fallback: simple heuristic extraction
    return _extract_heuristic(ocr_text, schema_fields)


def _build_prompt(ocr_text: str, schema_fields: list[str]) -> str:
    fields_str = ", ".join(f'"{f}"' for f in schema_fields)
    return (
        f"Extract the following fields from this OCR text.\n"
        f"Fields: [{fields_str}]\n\n"
        f"OCR Text:\n{ocr_text}\n\n"
        f"Return ONLY valid JSON with the field names as keys and extracted values as strings. "
        f"Use null for fields not found. No explanation."
    )


def _extract_with_mistral(ocr_text: str, schema_fields: list[str], api_key: str) -> dict:
    from mistralai import Mistral

    client = Mistral(api_key=api_key)
    prompt = _build_prompt(ocr_text, schema_fields)

    response = client.chat.complete(
        model="mistral-small-latest",
        messages=[{"role": "user", "content": prompt}],
        response_format={"type": "json_object"},
    )
    raw = response.choices[0].message.content
    return json.loads(raw)


def _extract_with_openai(ocr_text: str, schema_fields: list[str], api_key: str) -> dict:
    import requests

    prompt = _build_prompt(ocr_text, schema_fields)
    response = requests.post(
        "https://api.openai.com/v1/chat/completions",
        headers={"Authorization": f"Bearer {api_key}"},
        json={
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": prompt}],
            "response_format": {"type": "json_object"},
        },
    )
    response.raise_for_status()
    raw = response.json()["choices"][0]["message"]["content"]
    return json.loads(raw)


def _extract_heuristic(ocr_text: str, schema_fields: list[str]) -> dict:
    """Simple fallback: match field names in text using common patterns."""
    result = {field: None for field in schema_fields}
    lines = ocr_text.split("\n")

    for field in schema_fields:
        field_lower = field.lower().replace("_", " ")
        for line in lines:
            line_lower = line.lower()
            if field_lower in line_lower:
                for sep in [":", "=", "-", "\t"]:
                    if sep in line:
                        value = line.split(sep, 1)[1].strip()
                        if value:
                            result[field] = value
                            break
                break
    return result
