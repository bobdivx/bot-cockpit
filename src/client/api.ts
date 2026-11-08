export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  headers.set('x-bot-cockpit', '1');
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  if (!response.ok) {
    let message = `Erreur ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* réponse non JSON */
    }
    throw new ApiError(response.status, message);
  }
  if (response.status === 204) return undefined as T;
  const type = response.headers.get('content-type') || '';
  if (type.includes('application/json')) return (await response.json()) as T;
  return undefined as T;
}

export async function apiText(path: string): Promise<string> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'x-bot-cockpit': '1' },
  });
  if (!response.ok) throw new ApiError(response.status, `Erreur ${response.status}`);
  return response.text();
}
