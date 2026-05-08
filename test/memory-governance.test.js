import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMemoryGovernanceActions,
  classifyMemoryEventRetraction,
  classifyProfileFactRetraction,
  isLowValueMemorySummary,
} from "../src/memory-governance.js";

test("memory governance identifies standalone low-value memory events", () => {
  assert.equal(isLowValueMemorySummary("User discussed: 漂亮"), true);
  assert.equal(isLowValueMemorySummary("讲完了"), true);
  assert.equal(isLowValueMemorySummary("用户完成了 capstone presentation"), false);
});

test("memory governance identifies known outdated or misattributed claims conservatively", () => {
  assert.equal(
    classifyMemoryEventRetraction("用户经历 Person1 发烧、手机碎、去车行和被公司临时召回"),
    "misattributed_other_person_event",
  );
  assert.equal(
    classifyMemoryEventRetraction("用户描述 Person1：Person1 原本在休假，公司因人手告急临时召回他上班，用户感到诡异"),
    null,
  );
  assert.equal(
    classifyProfileFactRetraction("与 Person1 的约会关系已结束，用户主动提出分手"),
    "outdated_ho_relationship_ending_claim",
  );
  assert.equal(
    classifyProfileFactRetraction("Person1 的关系状态仍在变化，不能说已经分手"),
    null,
  );
  assert.equal(
    classifyMemoryEventRetraction("用户的 capstone 失去了 client presentation 汇报机会"),
    "premature_capstone_outcome_claim",
  );
});

test("memory governance emits retraction actions without mutating inputs", () => {
  const actions = buildMemoryGovernanceActions({
    memoryEvents: [
      { id: "event-1", summary: "User discussed: 漂亮" },
      { id: "event-2", summary: "用户完成了 capstone presentation" },
    ],
    profileFacts: [
      { id: "fact-1", kind: "relationship", value: "与 Person1 的约会关系已结束，用户主动提出分手" },
    ],
  });

  assert.deepEqual(
    actions.map((action) => [action.targetType, action.targetId, action.reason]),
    [
      ["memory_event", "event-1", "low_value_memory_event"],
      ["profile_fact", "fact-1", "outdated_ho_relationship_ending_claim"],
    ],
  );
});
