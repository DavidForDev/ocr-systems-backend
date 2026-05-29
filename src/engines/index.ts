import { Engine } from "./base.js";
import { gemini } from "./gemini.js";
import { mistralOcr } from "./mistralOcr.js";
import { googleDocumentAI } from "./googleDocumentAI.js";

export const engines: Record<string, Engine> = {
  [gemini.id]: gemini,
  [mistralOcr.id]: mistralOcr,
  [googleDocumentAI.id]: googleDocumentAI,
};

export function getEngine(id: string): Engine | undefined {
  return engines[id];
}

export function getAllEngines(): Engine[] {
  return Object.values(engines);
}
