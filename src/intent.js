/**
 * Lightweight intent detection for user messages.
 * Runs before the LLM call to add an intent hint to the prompt context.
 * Uses keyword/pattern matching — no additional LLM call.
 */

const INTENT_PATTERNS = [
  {
    intent: "memory_query",
    patterns: [
      /你记[得不]/, /我之前/, /我上次/, /我们聊过/, /我说过/, /你还记/, /之前提到/,
      /我跟你说过/, /前几天/, /上周/, /之前的对话/, /history/, /remember/i,
    ],
    hint: "用户在查询过去的对话或记忆。优先利用检索到的记忆上下文来回答，提供具体的时间和内容细节。",
  },
  {
    intent: "correction",
    patterns: [
      /不是.*是/, /你[搞弄]错/, /其实是/, /那个不对/, /错了/, /纠正/, /应该是/,
      /不对.*应该/, /你说错/, /wrong/i, /actually/i, /correct.*is/i,
    ],
    hint: "用户在纠正一个错误认知。接受纠正，确认正确信息，不要辩解。",
  },
  {
    intent: "emotional",
    patterns: [
      /我[很好]?(难过|伤心|焦虑|烦|累|崩溃|失望|害怕|迷茫|孤独|无聊|生气|开心|兴奋|感动)/,
      /心情[很不]?好/, /受不了/, /太难了/, /撑不住/, /想哭/, /好烦/,
      /我觉得[很好]?(孤独|无助|迷失|疲惫)/, /怎么办/,
    ],
    hint: "用户在分享情绪状态。不要给模板化安慰或therapy-speak。用精确和注意力回应，必要时帮助区分情绪反应和结构性问题。",
  },
  {
    intent: "thinking",
    patterns: [
      /我在想/, /我觉得/, /你怎么看/, /你觉得/, /帮我分析/, /帮我想/, /有没有可能/,
      /如果.*怎么/, /是不是应该/, /我不确定/, /利弊/, /trade-?off/i,
      /what do you think/i, /help me think/i, /should i/i,
    ],
    hint: "用户在思考一个问题，需要对话伙伴帮助理清思路。帮助提炼核心问题，暴露隐藏假设，不要急于给答案。",
  },
];

/**
 * Detect the likely intent of a user message.
 * @param {string} userText
 * @returns {{ intent: string, hint: string } | null}
 */
export function detectIntent(userText) {
  if (!userText || typeof userText !== "string") {
    return null;
  }

  const text = userText.trim();
  if (text.length < 2) {
    return null;
  }

  for (const { intent, patterns, hint } of INTENT_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(text)) {
        return { intent, hint };
      }
    }
  }

  return null;
}
