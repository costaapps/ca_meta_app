import type { components } from '@ca-meta/contracts';

export type TemplateCreateRequest = components['schemas']['TemplateCreateRequest'];

const NAME = /^[a-z0-9_]{1,128}$/;
const LANGUAGE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,2}$/;
const PLACEHOLDER = /\{\{([1-9][0-9]{0,2})\}\}/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const CATEGORIES = new Set(['AUTHENTICATION', 'MARKETING', 'UTILITY']);

export class TemplateInputError extends Error {
  constructor() { super('The WhatsApp template request is invalid.'); this.name = 'TemplateInputError'; }
}

/**
 * Validates the local BODY request shape. Placeholder/example pairing and order are
 * this API's compatibility rule; they are not represented as a current Meta rule.
 */
export function parseTemplateCreateRequest(value: unknown): TemplateCreateRequest {
  if (!record(value) || Object.keys(value).some((key) =>
    !['name', 'language', 'category', 'bodyText', 'exampleValues'].includes(key))) throw new TemplateInputError();
  const { name, language, category, bodyText, exampleValues } = value;
  if (typeof name !== 'string' || !NAME.test(name) ||
      typeof language !== 'string' || !LANGUAGE.test(language) || language.length > 16 ||
      typeof category !== 'string' || !CATEGORIES.has(category) ||
      typeof bodyText !== 'string' || bodyText.trim().length === 0 || bodyText.length > 1024 || CONTROL.test(bodyText)) {
    throw new TemplateInputError();
  }

  const normalizedExamples = exampleValues === undefined ? [] : exampleValues;
  if (!Array.isArray(normalizedExamples) || normalizedExamples.length > 100 ||
      normalizedExamples.some((item) => typeof item !== 'string' || item.trim().length === 0 || item.length > 1024 || CONTROL.test(item))) {
    throw new TemplateInputError();
  }

  const indices = new Set<number>();
  for (const match of bodyText.matchAll(PLACEHOLDER)) {
    const index = Number(match[1]);
    if (!Number.isSafeInteger(index) || index > 100 || (!indices.has(index) && index !== indices.size + 1)) {
      throw new TemplateInputError();
    }
    indices.add(index);
  }
  const withoutPlaceholders = bodyText.replace(new RegExp(PLACEHOLDER.source, 'g'), '');
  if (withoutPlaceholders.includes('{{') || withoutPlaceholders.includes('}}') || indices.size !== normalizedExamples.length) {
    throw new TemplateInputError();
  }

  return Object.freeze({ name, language, category: category as TemplateCreateRequest['category'], bodyText,
    exampleValues: Object.freeze([...normalizedExamples]) });
}

export function templateBodyProviderComponents(request: TemplateCreateRequest): Readonly<Record<string, unknown>> {
  return Object.freeze({
    name: request.name,
    language: request.language,
    category: request.category,
    components: Object.freeze([Object.freeze({
      type: 'BODY',
      text: request.bodyText,
      ...(request.exampleValues?.length ? { example: Object.freeze({ body_text: Object.freeze([[...request.exampleValues]]) }) } : {}),
    })]),
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
