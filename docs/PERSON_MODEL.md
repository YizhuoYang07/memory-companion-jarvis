# Person Model

The person model is a plain-text file (`data/person-model.md`) that is injected
into the system prompt on every conversation turn. It gives the AI stable,
structured knowledge about you — the kind of context a close friend would have
after years of knowing you.

Without a person model, the AI only knows what you told it in the current
conversation. With one, it knows who you are before you say a word.

---

## What to put in it

Think of it as a briefing document. The AI reads it every time it replies to you.
Keep it factual, direct, and specific. Vague entries like "creative person" are
less useful than "has been writing fiction since 2015; published two short stories."

A good person model covers:

| Section | What to include |
|---|---|
| **Identity** | Name, age, location, primary language |
| **Work & Study** | Current role, field, career stage, active projects |
| **Background** | Education, formative experiences, where you grew up |
| **Relationships** | Key people in your life (partner, family, close friends) — as much as you're comfortable with |
| **Health** | Chronic conditions, medications, how these affect your daily life |
| **Interests & Aesthetics** | What you read, watch, make, care about |
| **Personality** | How you think, your tendencies, what you find meaningful or frustrating |
| **Goals** | What you're working toward right now |
| **Communication style** | How you want the AI to talk to you |

---

## Template

Copy this into `data/person-model.md` and fill it in:

```markdown
# About [Your Name]

## Identity
- Name: [Your name, including any preferred nickname]
- Age: [Age or birth year]
- Location: [City, Country]
- Primary language: [Language you usually speak in]

## Work & Study
- [Current role/title] at/in [Company or field]
- [What you're currently focused on or building]
- [Any active side projects worth knowing about]

## Background
- Grew up in [place]; moved to [place] in [year]
- Studied [field] at [school], graduated [year]
- [One or two formative experiences that shaped how you think]

## Key Relationships
- [Person]: [who they are and your relationship]
- [Person]: [who they are and your relationship]

## Health
- [Condition or trait, if relevant]: [brief description of how it affects daily life]

## Interests & Aesthetics
- [Interest or domain you spend time in]
- [Aesthetic sensibility — what you find beautiful or compelling]
- [Creative or intellectual interests]

## Personality & Thinking Style
- [How you approach problems or decisions]
- [What you value deeply]
- [What frustrates or energizes you]
- [Known patterns or tendencies worth the AI knowing]

## Current Goals
- [Goal]: [brief context]
- [Goal]: [brief context]

## How to Talk to Me
- [Tone preference — direct, warm, formal, casual, etc.]
- [What to avoid]
- [Language preference if multilingual]
```

---

## How it's used

The contents of `data/person-model.md` are read at startup and injected as part
of the system prompt, prepended before any conversation history. The AI uses it
to:

- Answer questions about your background without you having to repeat yourself
- Interpret what you say with relevant personal context
- Avoid giving generic advice that ignores your actual situation

The file is **never** sent to a third party beyond the LLM you've configured.
It stays on your server.

---

## Privacy note

This file will contain sensitive personal information. It is listed in `.gitignore`
by default. Do not commit it to a public repository.
