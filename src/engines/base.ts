export interface SchemaField {
  name: string;
  /** Hint passed to the model to disambiguate what this field is. */
  description?: string;
  /** Optional ground-truth values for scoring. Match if actual contains ANY entry. */
  expected_values?: string[];
}

export interface EngineResult {
  /** Structured extraction matching the schema. Unset fields → null. */
  fields: Record<string, string | null>;
  /** Optional raw OCR text (when the engine produces one). */
  ocr_text: string | null;
  processing_time: number;
  error: string | null;
  metadata: Record<string, unknown>;
}

/** A single box in the pipeline diagram. */
export interface PipelineNode {
  id: string;
  kind: "input" | "ocr" | "llm" | "output";
  title: string;
  subtitle?: string;
  provider?: string;
  model?: string;
  details?: string[];
}

/** Arrow between two nodes, labelled with what is passed. */
export interface PipelineEdge {
  from: string;
  to: string;
  payload: string;
}

export interface Pipeline {
  nodes: PipelineNode[];
  edges: PipelineEdge[];
}

/** One cost line item ("Input tokens", "OCR pages"…). The backend sums the
 *  `metadata_key` across all results for the engine and multiplies by
 *  `unit_price_usd` to get the line item's total cost. */
export interface PricingComponent {
  label: string;
  /** Field inside EngineResult.metadata to sum (e.g. "input_tokens"). */
  metadata_key: string;
  /** Dollars per single unit (e.g. 0.10 / 1_000_000 for $0.10 per 1M tokens). */
  unit_price_usd: number;
  /** Display word ("tokens", "pages") — frontend formats counts with this. */
  display_unit: string;
  /** Human readable rate, e.g. "$0.10 / 1M tokens" — shown verbatim in the UI. */
  display_rate: string;
}

export interface EnginePricing {
  components: PricingComponent[];
}

export abstract class Engine {
  abstract id: string;
  abstract name: string;
  /** What this engine actually does (one short line, shown in the UI). */
  abstract description: string;

  protected _initialized = false;
  /** Captured during _lazyInit so extract() can return a friendly error per
   *  call instead of throwing at app boot. */
  protected _initError: string | null = null;

  protected async _lazyInit(): Promise<void> {}

  async ensureInitialized(): Promise<void> {
    if (this._initialized) return;
    try {
      await this._lazyInit();
    } catch (e: any) {
      this._initError = e?.message ?? String(e);
    }
    this._initialized = true;
  }

  /** Run the engine on one image, returning structured fields per the schema. */
  abstract extract(imageBuffer: Buffer, schema: SchemaField[]): Promise<EngineResult>;

  /** Architecture diagram for this engine. Override per-engine. */
  abstract pipeline(): Pipeline;

  /** Rate card. Override per-engine; default = no metered cost. */
  pricing(): EnginePricing {
    return { components: [] };
  }

  info() {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      pipeline: this.pipeline(),
      pricing: this.pricing(),
    };
  }
}

export function emptyFields(schema: SchemaField[]): Record<string, null> {
  return Object.fromEntries(schema.map((f) => [f.name, null]));
}
