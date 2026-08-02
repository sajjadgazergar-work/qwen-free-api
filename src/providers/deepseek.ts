import axios, { AxiosError } from 'axios';
import { NextFunction, Request, Response } from 'express';

const DEFAULT_MODELS = ['deepseek-default', 'deepseek-expert', 'deepseek-vision'];

export interface ProviderStatus {
  id: 'deepseek';
  enabled: boolean;
  baseUrl: string | null;
  healthy: boolean | null;
  accounts?: number;
  error?: string;
}

export interface DeepSeekAccountInput {
  email?: string;
  mobile?: string;
  areaCode?: string;
  password: string;
}

function baseUrl(): string | null {
  const value = (process.env.DEEPSEEK_BASE_URL || '').trim().replace(/\/$/, '');
  return value || null;
}

function upstreamHeaders(req?: Request): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: req?.headers.accept || 'application/json',
    'user-agent': 'conduit/0.1.1',
  };
  const configuredKey = (process.env.DEEPSEEK_UPSTREAM_API_KEY || '').trim();
  if (configuredKey) headers.authorization = `Bearer ${configuredKey}`;
  const requestId = req?.headers['x-request-id'];
  if (typeof requestId === 'string') headers['x-request-id'] = requestId;
  return headers;
}

function requireBaseUrl(): string {
  const upstream = baseUrl();
  if (!upstream) throw new Error('The DeepSeek provider is not configured. Set DEEPSEEK_BASE_URL.');
  return upstream;
}

export function isDeepSeekRequest(body: Record<string, unknown>): boolean {
  if (body.provider === 'deepseek') return true;
  return typeof body.model === 'string' && body.model.toLowerCase().startsWith('deepseek-');
}

export function deepSeekModels() {
  const configured = (process.env.DEEPSEEK_MODELS || '')
    .split(',').map(value => value.trim()).filter(Boolean);
  return (configured.length ? configured : DEFAULT_MODELS).map(id => ({
    id,
    object: 'model',
    created: 1720000000,
    owned_by: 'deepseek-web',
    description: `DeepSeek web provider model (${id.replace(/^deepseek-/, '')})`,
  }));
}

export async function proxyDeepSeekChat(req: Request, res: Response, next: NextFunction) {
  if (!isDeepSeekRequest(req.body || {})) return next();
  let upstream: string;
  try { upstream = requireBaseUrl(); } catch (error) {
    return res.status(503).json({ error: { message: (error as Error).message, type: 'api_error', code: 'provider_not_configured' } });
  }

  const body = { ...req.body };
  delete body.provider;

  try {
    const streaming = body.stream === true;
    const response = await axios.post(`${upstream}/v1/chat/completions`, body, {
      headers: upstreamHeaders(req), responseType: streaming ? 'stream' : 'json',
      timeout: Number(process.env.DEEPSEEK_TIMEOUT_MS) || 180_000, validateStatus: () => true,
    });
    res.status(response.status);
    res.setHeader('x-conduit-provider', 'deepseek');
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
    return res.status(502).json({ error: { message: err.message || 'DeepSeek provider request failed.', type: 'api_error', code: 'provider_unavailable' } });
  }
}

async function adminRequest<T>(method: 'get' | 'post' | 'put', path: string, token?: string, data?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await axios.request<T>({
    method, url: `${requireBaseUrl()}${path}`, headers, data,
    timeout: 15_000, validateStatus: () => true,
  });
  if (response.status < 200 || response.status >= 300) {
    const payload = response.data as any;
    throw new Error(payload?.error || payload?.message || `DeepSeek admin API returned HTTP ${response.status}.`);
  }
  return response.data;
}

export async function deepSeekAdminLogin(password: string): Promise<{ token: string; setup: boolean }> {
  if (!password || password.length < 6) throw new Error('DeepSeek admin password must contain at least 6 characters.');
  try {
    const result = await adminRequest<{ token: string }>('post', '/admin/api/login', undefined, { password });
    return { ...result, setup: false };
  } catch (loginError) {
    const message = (loginError as Error).message;
    if (!/not set|未设置|setup/i.test(message)) throw loginError;
    const result = await adminRequest<{ token: string }>('post', '/admin/api/setup', undefined, { password });
    return { ...result, setup: true };
  }
}

export async function getDeepSeekAccounts(token: string) {
  const [status, config] = await Promise.all([
    adminRequest<any>('get', '/admin/api/status', token),
    adminRequest<any>('get', '/admin/api/config', token),
  ]);
  const states = new Map((status.accounts || []).map((entry: any) => [entry.email || `${entry.area_code || ''}${entry.mobile || ''}`, entry]));
  return (config.ds_core?.accounts || []).map((account: any, index: number) => {
    const key = account.email || `${account.area_code || ''}${account.mobile || ''}`;
    const runtime: any = states.get(key) || {};
    return {
      index,
      email: account.email || '', mobile: account.mobile || '', areaCode: account.area_code || '',
      identity: key, state: runtime.state || 'configured', errorCount: runtime.error_count || 0,
      lastReleasedMs: runtime.last_released_ms || 0,
    };
  });
}

export async function addDeepSeekAccount(token: string, input: DeepSeekAccountInput) {
  const email = (input.email || '').trim();
  const mobile = (input.mobile || '').trim();
  const areaCode = (input.areaCode || '').trim();
  const password = input.password || '';
  if ((!email && !mobile) || (email && mobile)) throw new Error('Provide either an email address or a mobile number.');
  if (!password) throw new Error('DeepSeek account password is required.');
  const config = await adminRequest<any>('get', '/admin/api/config', token);
  const accounts = config.ds_core?.accounts || [];
  if (accounts.some((a: any) => email ? a.email === email : a.mobile === mobile && a.area_code === areaCode)) {
    throw new Error('This DeepSeek account is already configured.');
  }
  accounts.push({ email, mobile, area_code: areaCode, password });
  config.ds_core.accounts = accounts;
  return adminRequest<any>('put', '/admin/api/config', token, toWritableConfig(config));
}

export async function removeDeepSeekAccount(token: string, index: number) {
  const config = await adminRequest<any>('get', '/admin/api/config', token);
  const accounts = config.ds_core?.accounts || [];
  if (!Number.isInteger(index) || index < 0 || index >= accounts.length) throw new Error('Invalid DeepSeek account index.');
  accounts.splice(index, 1);
  config.ds_core.accounts = accounts;
  return adminRequest<any>('put', '/admin/api/config', token, toWritableConfig(config));
}

function toWritableConfig(config: any) {
  return {
    server: config.server, ds_core: config.ds_core, proxy: config.proxy,
    admin: { password_hash: '', jwt_secret: '', jwt_issued_at: config.admin?.jwt_issued_at || 0, old_password: '', new_password: '' },
    api_keys: config.api_keys || [],
  };
}

export async function getDeepSeekStatus(): Promise<ProviderStatus> {
  const upstream = baseUrl();
  if (!upstream) return { id: 'deepseek', enabled: false, baseUrl: null, healthy: null };
  try {
    const response = await axios.get(`${upstream}/health`, { timeout: 3_000, validateStatus: () => true });
    return { id: 'deepseek', enabled: true, baseUrl: upstream, healthy: response.status >= 200 && response.status < 300, ...(response.status >= 400 ? { error: `HTTP ${response.status}` } : {}) };
  } catch (error) {
    return { id: 'deepseek', enabled: true, baseUrl: upstream, healthy: false, error: (error as Error).message };
  }
}
