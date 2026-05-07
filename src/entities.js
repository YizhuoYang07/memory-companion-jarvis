const ENTITY_DEFINITIONS = [
  { canonicalName: "Ho", aliases: ["Ho", "Hunho", "Hunho Yee"] },
  { canonicalName: "小陈", aliases: ["小陈"] },
  { canonicalName: "老金", aliases: ["老金"] },
  { canonicalName: "Sky", aliases: ["Sky"] },
  { canonicalName: "小申", aliases: ["小申"] },
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
