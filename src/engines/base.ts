export interface OCRResult {
  text: string;
  confidence: number | null;
  processing_time: number;
  engine_id: string;
  engine_name: string;
  error: string | null;
  metadata: Record<string, unknown>;
  fields?: Record<string, string | null>;
}

export abstract class OCREngine {
  abstract id: string;
  abstract name: string;
  abstract provider: string;
  abstract category: string;

  protected _initialized = false;
  protected _prompt: string | null = null;

  protected async _lazyInit(): Promise<void> {}

  async ensureInitialized(): Promise<void> {
    if (!this._initialized) {
      await this._lazyInit();
      this._initialized = true;
    }
  }

  protected abstract _recognize(imageBuffer: Buffer): Promise<OCRResult>;

  async recognize(imageBuffer: Buffer, prompt?: string): Promise<OCRResult> {
    await this.ensureInitialized();
    this._prompt = prompt ?? null;
    return this._recognize(imageBuffer);
  }

  info() {
    return {
      id: this.id,
      name: this.name,
      provider: this.provider,
      category: this.category,
    };
  }
}
