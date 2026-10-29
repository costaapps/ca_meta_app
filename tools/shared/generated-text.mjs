export function normalizeGeneratedText(text) {
  return text.replace(/\r\n/g, '\n');
}

export function generatedTextMatches(actual, expected) {
  return normalizeGeneratedText(actual) === normalizeGeneratedText(expected);
}
