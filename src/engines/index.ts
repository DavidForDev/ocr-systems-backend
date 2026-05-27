import { OCREngine } from "./base.js";
import { gemini31FlashLite } from "./gemini.js";
import { mistralOcr } from "./mistralOcr.js";
import { googleDocumentAI } from "./googleDocumentAI.js";
import { surya } from "./surya.js";

export const engines: Record<string, OCREngine> = {
  [gemini31FlashLite.id]: gemini31FlashLite,
  [mistralOcr.id]: mistralOcr,
  [googleDocumentAI.id]: googleDocumentAI,
  [surya.id]: surya,
};

export function getEngine(id: string): OCREngine | undefined {
  return engines[id];
}

export function getAllEngines(): OCREngine[] {
  return Object.values(engines);
}
