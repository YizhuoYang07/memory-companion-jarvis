// Entity definitions: who/where/what the user has mentioned that the system
// should treat as canonical entities (one row instead of many).
//
// This file ships as a TEMPLATE. Replace the example entries with the people,
// places, and projects relevant to the user. Each entity has a canonical_name
// and a list of aliases — the system will treat any text containing any alias
// as a mention of that entity.
//
// The entities table in the V3 schema (created by scripts/v3-migrate-schema.js)
// is the canonical store; this file is the source of seed entities used at
// runtime for routing and entity card construction.

const ENTITY_DEFINITIONS = [
  // Examples — replace with your own:
  // { canonicalName: "Partner",       aliases: ["Partner", "their full name"] },
  // { canonicalName: "Best Friend",   aliases: ["Best Friend", "their nickname"] },
  // { canonicalName: "Workplace",     aliases: ["Workplace", "company name"] },
];

export function detectEntityNames(text) {
  const normalized = String(text || "");
  const names = [];
  for (const entity of ENTITY_DEFINITIONS) {
    if (entity.aliases.some((alias) => normalized.includes(alias))) {
      names.push(entity.canonicalName);
    }
  }
  return names;
}

export function getEntityDefinition(canonicalName) {
  return ENTITY_DEFINITIONS.find((entity) => entity.canonicalName === canonicalName) || null;
}
