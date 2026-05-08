// Entity definitions: who/where/what the user has mentioned that the system
// should treat as canonical entities (one row instead of many).
//
// This file ships with EXAMPLE PLACEHOLDER entities to make tests pass and
// demonstrate the structure. Replace these with the actual people, places,
// and projects relevant to your user.

const ENTITY_DEFINITIONS = [
  // Examples — replace with your own canonical entities.
  // Each entry has a canonical_name and a list of aliases. Any text containing
  // any alias is treated as a mention of that entity.
  { canonicalName: "Person1",  aliases: ["Person1"] },
  { canonicalName: "Person2",  aliases: ["Person2"] },
  { canonicalName: "PartnerA", aliases: ["PartnerA"] },
  { canonicalName: "PartnerB", aliases: ["PartnerB"] },
  { canonicalName: "PartnerC", aliases: ["PartnerC"] },
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
