import en from "./en.json";
import tr from "./tr.json";

export type SupportedLocale = "en" | "tr";

type Catalog = typeof en;

const CATALOGS: Record<SupportedLocale, Catalog> = { en, tr };
const LOCALES: SupportedLocale[] = ["en", "tr"];

function getNestedRecord(source: unknown, path: string[]): unknown {
  let current: unknown = source;
  for (const segment of path) {
    if (!current || typeof current !== "object" || !(segment in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function getCatalog(locale: SupportedLocale): Catalog {
  return CATALOGS[locale] ?? CATALOGS.en;
}

export function normalizeText(text: string): string {
  const replaced = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/ı/g, "i")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  return replaced.replace(/\s+/g, " ");
}

export function getSignals(
  locale: SupportedLocale,
  group: "intent" | "preferences",
  key: string,
): string[] {
  const raw = getNestedRecord(getCatalog(locale), ["signals", group, key]);
  return Array.isArray(raw)
    ? raw.filter((value): value is string => typeof value === "string")
    : [];
}

export function getLanguageHints(locale: SupportedLocale): string[] {
  const raw = getNestedRecord(getCatalog(locale), [
    "signals",
    "language_hints",
  ]);
  return Array.isArray(raw)
    ? raw.filter((value): value is string => typeof value === "string")
    : [];
}

export function matchesAnySignal(text: string, phrases: string[]): boolean {
  const normalized = normalizeText(text);
  return phrases.some((phrase) => normalized.includes(normalizeText(phrase)));
}

function scoreLocale(text: string, locale: SupportedLocale): number {
  const normalized = normalizeText(text);
  if (!normalized) {
    return 0;
  }

  let score = 0;
  for (const hint of getLanguageHints(locale)) {
    if (normalized.includes(normalizeText(hint))) {
      score += 2;
    }
  }

  for (const signalKey of ["autonomous", "pair", "research"] as const) {
    for (const phrase of getSignals(locale, "intent", signalKey)) {
      if (normalized.includes(normalizeText(phrase))) {
        score += 3;
      }
    }
  }

  return score;
}

export function detectLocaleFromTexts(
  ...texts: Array<string | undefined>
): SupportedLocale {
  const combined = texts.filter(Boolean).join("\n");
  if (!combined.trim()) {
    return "en";
  }

  const scores = LOCALES.map((locale) => ({
    locale,
    score: scoreLocale(combined, locale),
  }));
  scores.sort((left, right) => right.score - left.score);
  return scores[0]?.score && scores[0].score > 0 ? scores[0].locale : "en";
}

export function extractTextParts(
  parts: Array<{ type?: string; text?: string }>,
): string {
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
}

export function getAllSignals(
  group: "intent" | "preferences",
  key: string,
): string[] {
  return LOCALES.flatMap((locale) => getSignals(locale, group, key));
}
