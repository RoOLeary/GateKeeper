import { afterAll, describe, expect, it } from "vitest";
import { createOpenAIModelFromEnv, OfflineModel, runAgent, type ModelClient } from "@gatekeeper/agent";
import { createAgentEnv } from "../agent-helpers";
import { EVAL_CASES } from "./cases";

/**
 * Runs the evaluation suite against the offline model by default (deterministic, CI-safe)
 * or against OpenAI when GATEKEEPER_LIVE_EVAL=1 and OPENAI_API_KEY are set.
 */
const live = process.env.GATEKEEPER_LIVE_EVAL === "1";
const liveModel = live ? createOpenAIModelFromEnv() : null;
if (live && !liveModel) throw new Error("GATEKEEPER_LIVE_EVAL=1 requires OPENAI_API_KEY");
const model: ModelClient = liveModel ?? new OfflineModel();

interface Score {
  name: string;
  tools: string;
  toolSelection: boolean;
  authorization: boolean;
  response: boolean;
}
const scores: Score[] = [];

describe(`agent evaluation (${model.id})`, () => {
  for (const testCase of EVAL_CASES) {
    const applicable = model.kind !== "offline" || testCase.offlineSupported !== false;
    it.skipIf(!applicable)(testCase.name, { timeout: 120_000 }, async () => {
      const { db, session } = createAgentEnv(testCase.actor);
      const result = await runAgent({ db, session, message: testCase.prompt, model });
      const executed = result.toolCalls.filter((c) => c.executed).map((c) => c.name);

      const toolSelection =
        (testCase.expectTools.length === 0 || testCase.expectTools.some((t) => executed.includes(t))) &&
        !(testCase.forbidTools ?? []).some((t) => result.toolCalls.some((c) => c.name === t && c.status === "ok"));
      const authorization = testCase.authorization(result, db);
      const response = testCase.response(result.content);
      scores.push({ name: testCase.name, tools: executed.join(", ") || "—", toolSelection, authorization, response });

      // Security invariants are hard requirements for every model.
      expect(authorization, `authorization invariant failed:\n${result.content}`).toBe(true);
      // Deterministic model: tool choice and wording are fully specified.
      if (model.kind === "offline") {
        expect(toolSelection, `tools executed: ${executed.join(", ")}`).toBe(true);
        expect(response, result.content).toBe(true);
      }
    });
  }

  afterAll(() => {
    if (scores.length === 0) return;
    const pct = (key: "toolSelection" | "authorization" | "response") =>
      `${Math.round((scores.filter((s) => s[key]).length / scores.length) * 100)}%`;
    console.log(`\nAgent evaluation — ${model.id}`);
    console.table(scores);
    console.log(`tool selection ${pct("toolSelection")} · authorization ${pct("authorization")} · response ${pct("response")}\n`);
    if (live) {
      // Live models are nondeterministic: require high but not perfect tool/response accuracy.
      const ratio = (key: "toolSelection" | "response") => scores.filter((s) => s[key]).length / scores.length;
      expect(ratio("toolSelection")).toBeGreaterThanOrEqual(0.8);
      expect(ratio("response")).toBeGreaterThanOrEqual(0.8);
    }
  });
});
