import axios, { AxiosError } from 'axios';
import { NextFunction, Request, Response } from 'express';

const DEFAULT_MODELS = ['deepseek-default', 'deepseek-expert', 'deepseek-vision'];

export interface ProviderStatus {
  id: 'deepseek';
  enabled: boolean;
  baseUrl: string | null;
  healthy: boolean | null;
  error?: string;
}

function baseUrl(): string | null {
  const value = (process.env.DEEPSEEK_BASE_URL || '').trim().replace(/\/$/, '');
  return value || null;
}

function upstreamHeaders(req: Request): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'accept': req.headers.accept || 'application/json',
    'user-agent': 'conduit/0.1',
  };
  const configuredKey = (process.env.DEEPSEEK_UPSTREAM_API_KEY || '').trim();
  if (configuredKey) headers.authorization = `Bearer ${configuredKey}`;
  const requestId = req.headers['x-request-id'];
  if (typeof requestId === 'string') headers['x-request-id'] = requestId;
  return headers;
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
  const upstream = baseUrl();
  if (!upstream) {
    return res.status(503).json({
      error: {
        message: 'The DeepSeek provider is not configured. Set DEEPSEEK_BASE_URL.',
        type: 'api_error',
        code: 'provider_not_configured',
      },
    });
  }

  const body = { ...req.body };
  delete body.provider;

  try {
    const streaming = body.stream === true;
    const response = await axios.post(`${upstream}/v1/chat/completions`, body, {
      headers: upstreamHeaders(req),
      responseType: streaming ? 'stream' : 'json',
      timeout: Number(process.env.DEEPSEEK_TIMEOUT_MS) || 180_000,
      validateStatus: () => true,
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
    return res.status(502).json({
      error: {
        message: err.message || 'DeepSeek provider request failed.',
        type: 'api_error',
        code: 'provider_unavailable',
      },
    });
  }
}

export async function getDeepSeekStatus(): Promise<ProviderStatus> {
  const upstream = baseUrl();
  if (!upstream) return { id: 'deepseek', enabled: false, baseUrl: null, healthy: null };
  try {
    const response = await axios.get(`${upstream}/health`, {
      timeout: 3_000,
      validateStatus: () => true,
    });
    return {
      id: 'deepseek', enabled: true, baseUrl: upstream,
      healthy: response.status >= 200 && response.status < 300,
      ...(response.status >= 400 ? { error: `HTTP ${response.status}` } : {}),
    };
  } catch (error) {
    return {
      id: 'deepseek', enabled: true, baseUrl: upstream, healthy: false,
      error: (error as Error).message,
    };
  }
}
