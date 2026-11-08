import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function newId(): string {
  return randomBytes(16).toString('hex');
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('base64url');
  const key = scryptSync(password, salt, 64);
  return `scrypt$${salt}$${key.toString('base64url')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [algo, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const key = scryptSync(password, salt, 64);
  if (key.length !== expected.length) return false;
  return timingSafeEqual(key, expected);
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function newSecret(prefix: string): { secret: string; hash: string; hint: string } {
  const secret = `${prefix}${randomBytes(32).toString('base64url')}`;
  return { secret, hash: sha256(secret), hint: secret.slice(0, 10) };
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

export function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function cleanBlock(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n/g, '\n')
    .trim()
    .slice(0, max);
}

export function cleanFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? 'import.csv';
  return cleanText(base, 120) || 'import.csv';
}

const SECRET_KEY = /authorization|cookie|token|password|secret|bearer|setup/i;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SECRET_KEY.test(key) ? '[masqué]' : redact(item);
  }
  return output;
}

export function log(
  level: 'info' | 'warn' | 'error',
  message: string,
  fields?: Record<string, unknown>,
): void {
  const line = JSON.stringify({
    time: new Date().toISOString(),
    level,
    message,
    ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export function isLoopback(address: string): boolean {
  const host = address.toLowerCase().replace(/^::ffff:/, '');
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}
