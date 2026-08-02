import axios, { AxiosError } from 'axios';
import crypto = require('crypto');
import fs = require('fs');
import path = require('path');
import { NextFunction, Request, Response } from 'express';

const DEFAULT_MODELS = ['deepseek-default', 'deepseek-expert', 'deepseek-vision'];
let cachedAdminToken = '';
let adminSessionPromise: Promise<string> | null = null;

export interface ProviderStatus {
  id: 'deepseek';
  enabled: boolean;
  healthy: boolean | null;
  accounts?: number;
  setup?: 'ready' | 'needs_account' | 'service_unavailable';
  error?: string;
}

export interface DeepSeekAccountInput {
  email?: string;
  mobile?: string;
  areaCode?: string;
  password: string;
}

function baseUrl(): string {
  return (process.env.DEEPSEEK_BASE_URL || 'http://deepseek:22217').trim().replace(/\/$/, '');
}

function adminSecretFile(): string {
  const dataDir = process.env.CONDUIT_DATA_DIR || path.join(process.cwd(), 'data');
  return path.join(dataDir, 'deepseek-admin-secret');
}

function getOrCreateAdminSecret(): string {
  const configured = (process.env.DEEPSEEK_ADMIN_PASSWORD || '').trim();
  if (configured) return configured;
  const file = adminSecretFile();
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const secret = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

function upstreamHeaders(req?: Request): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json', accept: req?.headers.accept || 'application/json', 'user-agent': 'conduit/0.2.1',
  };
  const configuredKey = (process.env.DEEPSEEK_UPSTREAM_API_KEY || '').trim();
  if (configuredKey) headers.authorization = `Bearer ${configuredKey}`;
  const requestId = req?.headers['x-request-id'];
  if (typeof requestId === 'string') headers['x-request-id'] = requestId;
  return headers;
}

export function isDeepSeekRequest(body: Record<string, unknown>): boolean {
  if (body.provider === 'deepseek') return true;
  return typeof body.model === 'string' && body.model.toLowerCase().startsWith('deepseek-');
}

export function deepSeekModels() {
  const configured = (process.env.DEEPSEEK_MODELS || '').split(',').map(value => value.trim()).filter(Boolean);
  return (configured.length ? configured : DEFAULT_MODELS).map(id => ({
    id, object: 'model', created: 1720000000, owned_by: 'deepseek-web',
    description: `DeepSeek web provider model (${id.replace(/^deepseek-/, '')})`,
  }));
}

export async function proxyDeepSeekChat(req: Request, res: Response, next: NextFunction) {
  if (!isDeepSeekRequest(req.body || {})) return next();
  const body = { ...req.body };
  delete body.provider;
  try {
    const streaming = body.stream === true;
    const response = await axios.post(`${baseUrl()}/v1/chat/completions`, body, {
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

async function adminRequest<T>(method: 'get' | 'post' | 'put', route: string, token?: string, data?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await axios.request<T>({ method, url: `${baseUrl()}${route}`, headers, data, timeout: 15_000, validateStatus: () => true });
  if (response.status < 200 || response.status >= 300) {
    const payload = response.data as any;
    const error = new Error(payload?.error || payload?.message || `DeepSeek service returned HTTP ${response.status}.`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return response.data;
}

async function loginOrSetup(): Promise<string> {
  const password = getOrCreateAdminSecret();
  try {
    return (await adminRequest<{ token: string }>('post', '/admin/api/login', undefined, { password })).token;
  } catch (error) {
    if (!/not set|未设置|setup/i.test((error as Error).message)) throw error;
    return (await adminRequest<{ token: string }>('post', '/admin/api/setup', undefined, { password })).token;
  }
}

async function adminToken(force = false): Promise<string> {
  if (!force && cachedAdminToken) return cachedAdminToken;
  if (!adminSessionPromise) {
    adminSessionPromise = loginOrSetup().then(token => (cachedAdminToken = token)).finally(() => { adminSessionPromise = null; });
  }
  return adminSessionPromise;
}

async function withAdmin<T>(operation: (token: string) => Promise<T>): Promise<T> {
  try { return await operation(await adminToken()); }
  catch (error) {
    if ((error as Error & { status?: number }).status !== 401) throw error;
    cachedAdminToken = '';
    return operation(await adminToken(true));
  }
}

export async function getDeepSeekAccounts() {
  return withAdmin(async token => {
    const [status, config] = await Promise.all([
      adminRequest<any>('get', '/admin/api/status', token), adminRequest<any>('get', '/admin/api/config', token),
    ]);
    const states = new Map((status.accounts || []).map((entry: any) => [entry.email || `${entry.area_code || ''}${entry.mobile || ''}`, entry]));
    return (config.ds_core?.accounts || []).map((account: any, index: number) => {
      const key = account.email || `${account.area_code || ''}${account.mobile || ''}`;
      const runtime: any = states.get(key) || {};
      return { index, identity: key, state: runtime.state || 'configured', errorCount: runtime.error_count || 0, lastReleasedMs: runtime.last_released_ms || 0 };
    });
  });
}

export async function addDeepSeekAccount(input: DeepSeekAccountInput) {
  const email = (input.email || '').trim();
  const mobile = (input.mobile || '').trim();
  const areaCode = (input.areaCode || '').trim();
  const password = input.password || '';
  if ((!email && !mobile) || (email && mobile)) throw new Error('Enter either the DeepSeek email address or mobile number.');
  if (!password) throw new Error('Enter the password used to sign in at chat.deepseek.com.');
  return withAdmin(async token => {
    const config = await adminRequest<any>('get', '/admin/api/config', token);
    const accounts = config.ds_core?.accounts || [];
    if (accounts.some((a: any) => email ? a.email === email : a.mobile === mobile && a.area_code === areaCode)) throw new Error('This DeepSeek account is already configured.');
    accounts.push({ email, mobile, area_code: areaCode, password });
    config.ds_core.accounts = accounts;
    return adminRequest<any>('put', '/admin/api/config', token, toWritableConfig(config));
  });
}

export async function removeDeepSeekAccount(index: number) {
  return withAdmin(async token => {
    const config = await adminRequest<any>('get', '/admin/api/config', token);
    const accounts = config.ds_core?.accounts || [];
    if (!Number.isInteger(index) || index < 0 || index >= accounts.length) throw new Error('Invalid DeepSeek account index.');
    accounts.splice(index, 1);
    config.ds_core.accounts = accounts;
    return adminRequest<any>('put', '/admin/api/config', token, toWritableConfig(config));
  });
}

function toWritableConfig(config: any) {
  return {
    server: config.server, ds_core: config.ds_core, proxy: config.proxy,
    admin: { password_hash: '', jwt_secret: '', jwt_issued_at: config.admin?.jwt_issued_at || 0, old_password: '', new_password: '' },
    api_keys: config.api_keys || [],
  };
}

export async function getDeepSeekStatus(): Promise<ProviderStatus> {
  try {
    const response = await axios.get(`${baseUrl()}/health`, { timeout: 3_000, validateStatus: () => true });
    if (response.status < 200 || response.status >= 300) return { id: 'deepseek', enabled: true, healthy: false, setup: 'service_unavailable', error: `HTTP ${response.status}` };
    try {
      const accounts = await getDeepSeekAccounts();
      return { id: 'deepseek', enabled: true, healthy: true, accounts: accounts.length, setup: accounts.length ? 'ready' : 'needs_account' };
    } catch (error) {
      return { id: 'deepseek', enabled: true, healthy: false, setup: 'service_unavailable', error: (error as Error).message };
    }
  } catch (error) {
    return { id: 'deepseek', enabled: true, healthy: false, setup: 'service_unavailable', error: (error as Error).message };
  }
}
