// Memory governance: rule-based classifier that identifies memory entries
// (events / facts) which should be retracted because they were extracted in
// error or have become outdated.
//
// This module ships with the GENERIC framework. Specific patterns are
// intentionally minimal — adapt to your own data after observing actual
// extraction failures in your DB. See docs/MEMORY_GOVERNANCE.md for examples.
//
// The framework detects:
//   - low_value_memory_event:        short utterances with no anchor (yes/ok/嗯/啊...)
//   - misattributed_other_person:    user-subject summaries that actually describe someone else
//   - outdated_relationship_claim:   relationship-state assertions superseded by user correction
//
// Customization: extend the patterns below with the canonical names from
// your entities table and the contexts you actually observe in your data.

const LOW_VALUE_PREFIX_PATTERN = /^(User discussed:|用户(?:讨论|提到|说)[：:]?)\s*/iu;
const LOW_VALUE_SUMMARY_PATTERN = /^(嗯+|呃+|啊+|哦+|噢+|好+|行+|可以+|谢谢|谢了|哈哈+|hhh+|ok|okay|yes|no|done)$/iu;
const MEMORY_ANCHOR_PATTERN = /(\d{4}|\d{1,2}月\d{1,2}日|今天|昨天|前天|上周|下周)/iu;

// Customize: list canonical names of important other-people entities here
// to enable misattribution detection.
const OTHER_PERSON_NAMES = [
  // "Person A", "Person B", ...
];

const PROTECTED_OTHER_PERSON_PREFIX_PATTERN = OTHER_PERSON_NAMES.length
  ? new RegExp(`^用户(描述|提到|正在观察|认为|对).*(${OTHER_PERSON_NAMES.join("|")})`, "iu")
  : null;

const USER_SUBJECT_PATTERN = /^(用户|User)(?:在[^，。；]*内)?(?:经历|遭遇|被公司|发烧|被临时召回)/iu;

export function buildMemoryGovernanceActions({ profileFacts = [], memoryEvents = [] } = {}) {
  const actions = [];

  for (const event of memoryEvents) {
    const reason = classifyMemoryEventRetraction(event.summary);
    if (reason) {
      actions.push({
        targetType: "memory_event",
        targetId: event.id,
        reason,
        text: event.summary,
      });
    }
  }

  for (const fact of profileFacts) {
    const reason = classifyProfileFactRetraction(fact.value);
    if (reason) {
      actions.push({
        targetType: "profile_fact",
        targetId: fact.id,
        reason,
        text: `${fact.kind}: ${fact.value}`,
      });
    }
  }

  return actions;
}

export function classifyMemoryEventRetraction(summary) {
  if (!summary || typeof summary !== "string") {
    return null;
  }

  if (isLowValueMemorySummary(summary)) {
    return "low_value_memory_event";
  }

  if (isMisattributedOtherPersonEvent(summary)) {
    return "misattributed_other_person_event";
  }

  return null;
}

export function classifyProfileFactRetraction(_value) {
  // Customize: add patterns for outdated claims you want auto-retracted.
  // Default: no automatic retraction at the fact level.
  return null;
}

export function isLowValueMemorySummary(summary) {
  const normalized = String(summary || "")
    .replace(LOW_VALUE_PREFIX_PATTERN, "")
    .trim();
  if (!LOW_VALUE_SUMMARY_PATTERN.test(normalized)) {
    return false;
  }
  return !MEMORY_ANCHOR_PATTERN.test(normalized);
}

function isMisattributedOtherPersonEvent(summary) {
  if (OTHER_PERSON_NAMES.length === 0) return false;
  if (PROTECTED_OTHER_PERSON_PREFIX_PATTERN && PROTECTED_OTHER_PERSON_PREFIX_PATTERN.test(summary)) {
    return false;
  }
  // Match: user-subject pattern AND mentions an other-person name
  const otherPersonRegex = new RegExp(`(${OTHER_PERSON_NAMES.join("|")})`, "iu");
  return USER_SUBJECT_PATTERN.test(summary) && otherPersonRegex.test(summary);
}
