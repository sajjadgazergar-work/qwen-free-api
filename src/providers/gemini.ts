import axios, { AxiosError } from 'axios';
import { NextFunction, Request, Response } from 'express';

const FALLBACK_MODELS = ['gemini-3-pro', 'gemini-3-flash'];

export interface GeminiAccountInput {
  id?: string;
  secure1psid?: string;
  secure1psidts?: string;
  cookie?: string;
  proxy?: string;
}

export interface GeminiAccountView {
  id: string;
  proxy: string | null;
  healthy: boolean;
}

export function geminiBaseUrl(): string {
  const configured = (process.env.GEMINI_BASE_URL || 'http://127.0.0.1:18000').trim();
  try {
    const url = new URL(configured);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol');
    return configured.replace(/\/$/, '');
  } catch {
    throw new Error(`Invalid GEMINI_BASE_URL: ${configured || '(empty)'}`);
  }
}

function providerError(error: unknown): string {
  const err = error as AxiosError & { code?: string };
  const upstream = (() => { try { return geminiBaseUrl(); } catch { return 'the configured URL'; } })();
  if (err.code === 'ENOTFOUND') return `Cannot resolve the Gemini host at ${upstream}. Use http://gemini:8000 inside Docker Compose or http://127.0.0.1:18000 when Conduit runs on the host.`;
  if (err.code === 'ECONNREFUSED') return `Gemini is not listening at ${upstream}. Start the Gemini service or correct GEMINI_BASE_URL.`;
  if (err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED') return `Gemini timed out at ${upstream}. The service may still be starting or waiting for account initialization.`;
  return err.message || 'Gemini provider request failed.';
}

function managementHeaders(): Record<string, string> {
  const key = (process.env.GEMINI_MANAGEMENT_KEY || '').trim();
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    ...(key ? { 'x-conduit-management-key': key } : {}),
  };
}

function upstreamHeaders(req?: Request): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: req?.headers.accept || 'application/json',
    'user-agent': 'conduit/0.2.0',
  };
  const configuredKey = (process.env.GEMINI_UPSTREAM_API_KEY || '').trim();
  if (configuredKey) headers.authorization = `Bearer ${configuredKey}`;
  const requestId = req?.headers['x-request-id'];
  if (typeof requestId === 'string') headers['x-request-id'] = requestId;
  return headers;
}

export function isGeminiRequest(body: Record<string, unknown>): boolean {
  if (body.provider === 'gemini') return true;
  return typeof body.model === 'string' && body.model.toLowerCase().startsWith('gemini-');
}

export function fallbackGeminiModels() {
  const configured = (process.env.GEMINI_MODELS || '')
    .split(',').map(value => value.trim()).filter(Boolean);
  return (configured.length ? configured : FALLBACK_MODELS).map(id => ({
    id,
    object: 'model',
    created: 1720000000,
    owned_by: 'gemini-web',
    description: `Gemini web provider model (${id.replace(/^gemini-/, '')})`,
  }));
}

export async function geminiModels() {
  const upstream = geminiBaseUrl();
  try {
    const response = await axios.get(`${upstream}/v1/models`, {
      headers: upstreamHeaders(), timeout: 5_000, validateStatus: () => true,
    });
    if (response.status >= 200 && response.status < 300 && Array.isArray(response.data?.data)) {
      return response.data.data.map((model: any) => ({
        ...model,
        owned_by: model.owned_by || 'gemini-web',
        description: model.description || `Gemini web provider model (${model.id})`,
      }));
    }
  } catch {}
  return fallbackGeminiModels();
}

export async function proxyGeminiChat(req: Request, res: Response, next: NextFunction) {
  if (!isGeminiRequest(req.body || {})) return next();
  const upstream = geminiBaseUrl();

  const body = { ...req.body };
  delete body.provider;
  try {
    const streaming = body.stream === true;
    const response = await axios.post(`${upstream}/v1/chat/completions`, body, {
      headers: upstreamHeaders(req), responseType: streaming ? 'stream' : 'json',
      timeout: Number(process.env.GEMINI_TIMEOUT_MS) || 300_000, validateStatus: () => true,
    });
    res.status(response.status);
    res.setHeader('x-conduit-provider', 'gemini');
    const contentType = response.headers['content-type'];
    if (typeof contentType === 'string') res.setHeader('content-type', contentType);
    if (streaming && response.data && typeof response.data.pipe === 'function') {
      req.on('close', () => response.data.destroy());
      response.data.pipe(res);
      return;
    }
    return res.send(response.data);
  } catch (error) {
    const err = error as AxiosError;
    return res.status(502).json({ error: { message: providerError(err), type: 'api_error', code: 'provider_unavailable' } });
  }
}

async function managementRequest<T>(method: 'get' | 'post' | 'delete', route: string, data?: unknown): Promise<T> {
  const response = await axios.request<T>({
    method, url: `${geminiBaseUrl()}${route}`, headers: managementHeaders(), data,
    timeout: Number(process.env.GEMINI_MANAGEMENT_TIMEOUT_MS) || 60_000,
    validateStatus: () => true,
  });
  if (response.status < 200 || response.status >= 300) {
    const payload = response.data as any;
    throw new Error(payload?.detail || payload?.error || payload?.message || `Gemini management API returned HTTP ${response.status}.`);
  }
  return response.data;
}

export async function getGeminiAccounts(): Promise<GeminiAccountView[]> {
  const result = await managementRequest<{ accounts: GeminiAccountView[] }>('get', '/conduit/accounts');
  return result.accounts || [];
}

function cookieValue(cookie: string, name: string): string {
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}=([^;]+)`));
  return match?.[1]?.trim() || '';
}

export async function addGeminiAccount(input: GeminiAccountInput): Promise<GeminiAccountView> {
  const pastedCookie = (input.cookie || '').trim();
  const secure1psid = (input.secure1psid || '').trim() || cookieValue(pastedCookie, '__Secure-1PSID');
  const secure1psidts = (input.secure1psidts || '').trim() || cookieValue(pastedCookie, '__Secure-1PSIDTS');
  if (!secure1psid) throw new Error('Paste the complete Gemini Cookie header or its __Secure-1PSID value.');
  const result = await managementRequest<{ account: GeminiAccountView }>('post', '/conduit/accounts', {
    id: (input.id || '').trim() || undefined,
    secure_1psid: secure1psid,
    secure_1psidts: secure1psidts,
    proxy: (input.proxy || '').trim() || null,
  });
  return result.account;
}

export async function removeGeminiAccount(id: string) {
  if (!id) throw new Error('Gemini account id is required.');
  return managementRequest('delete', `/conduit/accounts/${encodeURIComponent(id)}`);
}

export async function getGeminiStatus() {
  let upstream: string | undefined;
  try {
    upstream = geminiBaseUrl();
    const response = await axios.get(`${upstream}/health`, { timeout: 5_000, validateStatus: () => true });
    const clients = response.data?.clients && typeof response.data.clients === 'object' ? response.data.clients : {};
    const states = Object.values(clients) as boolean[];
    return {
      id: 'gemini', enabled: true,
      healthy: response.status >= 200 && response.status < 300 && response.data?.ok === true,
      accounts: states.length, setup: states.length ? 'ready' : 'needs_account',
      healthyAccounts: states.filter(Boolean).length,
      ...(response.data?.error ? { error: String(response.data.error) } : {}),
    };
  } catch (error) {
    return { id: 'gemini', enabled: true, healthy: false, accounts: 0, setup: 'service_unavailable', error: providerError(error), ...(upstream ? { baseUrl: upstream } : {}) };
  }
}
