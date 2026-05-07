const LOW_VALUE_PREFIX_PATTERN = /^(User discussed:|用户(?:讨论|提到|说)[：:]?)\s*/iu;
const LOW_VALUE_SUMMARY_PATTERN = /^(嗯+|呃+|啊+|哦+|噢+|好+|行+|可以+|漂亮|谢谢|谢了|讲完了|讲完|哈哈+|hhh+|ok|okay|yes|no|done)$/iu;
const MEMORY_ANCHOR_PATTERN = /(\d{4}|\d{1,2}月\d{1,2}日|今天|昨天|前天|上周|下周|capstone|presentation|Truffles|Kings Cross|UNSW|UTS|Tinder)/iu;

const MISATTRIBUTED_OTHER_PERSON_PATTERN =
  /(Ho|Hunho|老金|小陈|Sky|小申).*(发烧|手机|车行|公司|召回|training|训练|上班|下班)/iu;
const PROTECTED_OTHER_PERSON_PREFIX_PATTERN = /^用户(描述|提到|正在观察|认为|对).*(Ho|Hunho|老金|小陈|Sky|小申)/iu;
const USER_SUBJECT_PATTERN = /^(用户|User)(?:在[^，。；]*内)?(?:经历|遭遇|被公司|发烧|手机|去车行|被临时召回)/iu;

const HO_ENDED_PATTERN = /(Ho|Hunho).*(关系已结束|约会关系已结束|主动提出分手|提出分手|已经分手|关系结束)/iu;
const NEGATED_ENDING_PATTERN = /(不是|不代表|不能|并非|未定义|变化|仍在变化|没有分手)/iu;

const CAPSTONE_PREMATURE_PATTERN = /capstone.*(失去|失去了|没机会).*(客户|client|汇报|presentation)|失去.*capstone.*(客户|client|汇报|presentation)/iu;

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

  if (isHoEndedClaim(summary)) {
    return "outdated_ho_relationship_ending_claim";
  }

  if (CAPSTONE_PREMATURE_PATTERN.test(summary)) {
    return "premature_capstone_outcome_claim";
  }

  return null;
}

export function classifyProfileFactRetraction(value) {
  if (!value || typeof value !== "string") {
    return null;
  }

  if (isHoEndedClaim(value)) {
    return "outdated_ho_relationship_ending_claim";
  }

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
  if (PROTECTED_OTHER_PERSON_PREFIX_PATTERN.test(summary)) {
    return false;
  }
  return USER_SUBJECT_PATTERN.test(summary) && MISATTRIBUTED_OTHER_PERSON_PATTERN.test(summary);
}

function isHoEndedClaim(text) {
  return HO_ENDED_PATTERN.test(text) && !NEGATED_ENDING_PATTERN.test(text);
}
