export class HttpError extends Error {
  statusCode: number;
  constructor(statusCode: number) { super('request_failed'); this.statusCode = statusCode; }
}
export const object = (properties: Record<string, unknown>) => ({
  type: 'object', additionalProperties: false, required: Object.keys(properties), properties,
});

export function parseJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  // JSON.parse validates syntax first. Inspect structural tokens to reject duplicate decoded keys.
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]/g) ?? [];
  const stack: Array<Set<string> | null> = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '{') stack.push(new Set());
    else if (token === '[') stack.push(null);
    else if (token === '}' || token === ']') stack.pop();
    else if (token.startsWith('"') && tokens[i + 1] === ':') {
      const key = JSON.parse(token) as string;
      const keys = stack.at(-1)!;
      if (!keys || keys.has(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new HttpError(400);
      keys.add(key);
    }
  }
  return value;
}
