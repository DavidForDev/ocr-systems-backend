import { Router, Request, Response } from "express";
import { getDB } from "../db.js";
import { getAllEngines } from "../engines/index.js";

const router = Router();

interface PerFieldAcc {
  correct: number;
  total: number;
}

interface EngineAcc {
  calls: number;
  errors: number;
  sum_seconds: number;
  sum_cost: number;
  sum_input_tokens: number;
  sum_output_tokens: number;
  sum_total_tokens: number;
  /** Eval-only — items with ground truth. */
  eval_items: number;
  eval_items_passed: number;
  /** Field-level totals across all eval items. */
  eval_field_correct: number;
  eval_field_total: number;
  per_field: Record<string, PerFieldAcc>;
}

const blank = (): EngineAcc => ({
  calls: 0,
  errors: 0,
  sum_seconds: 0,
  sum_cost: 0,
  sum_input_tokens: 0,
  sum_output_tokens: 0,
  sum_total_tokens: 0,
  eval_items: 0,
  eval_items_passed: 0,
  eval_field_correct: 0,
  eval_field_total: 0,
  per_field: {},
});

const num = (v: unknown): number => (typeof v === "number" && isFinite(v) ? v : 0);

router.get("/analytics", async (_req: Request, res: Response) => {
  try {
    const db = getDB();
    if (!db) return void res.status(503).json({ error: "Database not available" });

    const nameById = new Map(getAllEngines().map((e) => [e.id, e.name] as const));

    const [runs, evalRuns] = await Promise.all([
      db.collection("runs").find({}).toArray(),
      db.collection("eval_runs").find({}).toArray(),
    ]);

    const byEngine = new Map<string, EngineAcc>();
    const acc = (id: string) => {
      let a = byEngine.get(id);
      if (!a) {
        a = blank();
        byEngine.set(id, a);
      }
      return a;
    };

    // ── compare runs: cost / time / errors only (no ground truth) ────
    for (const run of runs) {
      for (const r of (run.results ?? []) as any[]) {
        if (!r?.engine_id) continue;
        const a = acc(r.engine_id);
        a.calls++;
        if (r.error) a.errors++;
        a.sum_seconds += num(r.processing_time);
        const meta = r.metadata ?? {};
        a.sum_cost += num(meta.cost_usd);
        a.sum_input_tokens += num(meta.input_tokens);
        a.sum_output_tokens += num(meta.output_tokens);
        a.sum_total_tokens += num(meta.total_tokens);
      }
    }

    // ── eval runs: accuracy + everything else (per item) ─────────────
    for (const er of evalRuns) {
      for (const r of (er.results ?? []) as any[]) {
        if (!r?.engine_id) continue;
        const a = acc(r.engine_id);
        for (const item of (r.items ?? []) as any[]) {
          a.calls++;
          a.eval_items++;
          if (item.error) a.errors++;
          a.sum_seconds += num(item.ocr_seconds);
          a.sum_cost += num(item.cost_usd);
          a.sum_input_tokens += num(item.input_tokens);
          a.sum_output_tokens += num(item.output_tokens);
          a.sum_total_tokens += num(item.total_tokens);
          if (item.passed) a.eval_items_passed++;
          a.eval_field_correct += num(item.correct);
          a.eval_field_total += num(item.total);
          for (const c of (item.checks ?? []) as any[]) {
            const slot = (a.per_field[c.field] ??= { correct: 0, total: 0 });
            slot.total++;
            if (c.match) slot.correct++;
          }
        }
      }
    }

    const engines = Array.from(byEngine.entries()).map(([engine_id, a]) => {
      const accuracy = a.eval_field_total > 0 ? a.eval_field_correct / a.eval_field_total : null;
      const pass_rate = a.eval_items > 0 ? a.eval_items_passed / a.eval_items : null;
      const avg_seconds = a.calls > 0 ? a.sum_seconds / a.calls : 0;
      const avg_cost = a.calls > 0 ? a.sum_cost / a.calls : 0;
      const error_rate = a.calls > 0 ? a.errors / a.calls : 0;
      // Best-value score: accuracy per dollar.
      // Free engines (cost=0) get an explicit Infinity-like marker handled
      // by the frontend; report null here when accuracy is unknown.
      const value_score =
        accuracy == null
          ? null
          : avg_cost > 0
          ? accuracy / avg_cost
          : accuracy * 1e6; // treat "free" as very high value
      return {
        engine_id,
        engine_name: nameById.get(engine_id) ?? engine_id,
        calls: a.calls,
        errors: a.errors,
        error_rate,
        avg_seconds,
        avg_cost,
        total_cost: a.sum_cost,
        total_input_tokens: a.sum_input_tokens,
        total_output_tokens: a.sum_output_tokens,
        total_tokens: a.sum_total_tokens,
        eval_items: a.eval_items,
        eval_items_passed: a.eval_items_passed,
        eval_items_failed: a.eval_items - a.eval_items_passed,
        accuracy,
        pass_rate,
        value_score,
        per_field: a.per_field,
      };
    });

    // ── Verdicts ─────────────────────────────────────────────────────
    const pickMax = <T>(
      items: T[],
      key: (t: T) => number | null
    ): T | null => {
      let best: T | null = null;
      let bestVal = -Infinity;
      for (const it of items) {
        const v = key(it);
        if (v == null) continue;
        if (v > bestVal) {
          bestVal = v;
          best = it;
        }
      }
      return best;
    };
    const pickMin = <T>(
      items: T[],
      key: (t: T) => number | null,
      requireCalls?: (t: T) => boolean
    ): T | null => {
      let best: T | null = null;
      let bestVal = Infinity;
      for (const it of items) {
        if (requireCalls && !requireCalls(it)) continue;
        const v = key(it);
        if (v == null) continue;
        if (v < bestVal) {
          bestVal = v;
          best = it;
        }
      }
      return best;
    };

    const verdictFrom = (
      eng: (typeof engines)[number] | null,
      val: number | null
    ) =>
      eng
        ? { engine_id: eng.engine_id, engine_name: eng.engine_name, value: val ?? 0 }
        : null;

    const most_accurate = pickMax(engines, (e) => e.accuracy);
    const cheapest = pickMin(
      engines,
      (e) => e.avg_cost,
      (e) => e.calls > 0 && e.total_cost > 0 // ignore engines that never reported a cost
    );
    const fastest = pickMin(
      engines,
      (e) => (e.calls > 0 ? e.avg_seconds : null)
    );
    const best_value = pickMax(engines, (e) => e.value_score);
    const worst_errors = pickMax(engines, (e) => (e.calls > 0 ? e.error_rate : null));

    // Per-field winner
    const allFields = new Set<string>();
    for (const e of engines) for (const f of Object.keys(e.per_field)) allFields.add(f);
    const per_field_winner: Record<
      string,
      { engine_id: string; engine_name: string; accuracy: number } | null
    > = {};
    for (const field of allFields) {
      let best: { engine_id: string; engine_name: string; accuracy: number } | null = null;
      for (const e of engines) {
        const pf = e.per_field[field];
        if (!pf || pf.total === 0) continue;
        const a = pf.correct / pf.total;
        if (!best || a > best.accuracy)
          best = { engine_id: e.engine_id, engine_name: e.engine_name, accuracy: a };
      }
      per_field_winner[field] = best;
    }

    res.json({
      generated_at: new Date().toISOString(),
      counts: { compare_runs: runs.length, eval_runs: evalRuns.length },
      engines,
      fields: Array.from(allFields).sort(),
      verdicts: {
        most_accurate: verdictFrom(most_accurate, most_accurate?.accuracy ?? null),
        cheapest: verdictFrom(cheapest, cheapest?.avg_cost ?? null),
        fastest: verdictFrom(fastest, fastest?.avg_seconds ?? null),
        best_value: verdictFrom(best_value, best_value?.value_score ?? null),
        worst_errors: verdictFrom(worst_errors, worst_errors?.error_rate ?? null),
        per_field_winner,
      },
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
