import express = require('express');
import { Request, Response } from 'express';
import cors = require('cors');
import crypto = require('crypto');
import axios from 'axios';
import mime = require('mime-types');
import dotenv = require('dotenv');
import path = require('path');
import fs = require('fs');
import zlib = require('zlib');
import {
  InvalidRequestError,
  buildQwenPrompt,
  buildToolRegistry,
  normalizeToolOptions,
  parseToolOutput,
  shouldRequireTool,
  validateConversation,
} from './tool-calling';
import {
  addDeepSeekAccount,
  deepSeekModels,
  getDeepSeekAccounts,
  getDeepSeekConfig,
  getDeepSeekStatus,
  proxyDeepSeekChat,
  removeDeepSeekAccount,
  updateDeepSeekConfig,
} from './providers/deepseek';
import {
  addGeminiAccount,
  geminiModels,
  getGeminiAccounts,
  getGeminiStatus,
  proxyGeminiChat,
  removeGeminiAccount,
} from './providers/gemini';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 8000;

app.use(cors());
app.use(express.json({ limit: '100mb' }));

const BAXIA_VERSION = '2.5.36';
const QWEN_BASE_URL = 'https://chat.qwen.ai';
const QWEN_GUEST_REFERER = `${QWEN_BASE_URL}/c/guest`;
const QWEN_WEB_REFERER = `${QWEN_BASE_URL}/`;
const WEB_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const WEB_ACCEPT_LANGUAGE = 'zh-CN,zh;q=0.9,en;q=0.8';

// ============================================
// Metrics & State Management
// ============================================

interface Account {
  id: string;
  label: string;
  value: string;
  ok: boolean;
  source: 'environment' | 'dashboard';
  createdAt: number;
  lastUsed?: number;
  failures: number;
  cooldownUntil?: number;
}

interface RequestLog {
  timestamp: number;
  method: string;
  url: string;
  status: number;
  latency: number;
}

let accountPool: Account[] = [];
let totalRequests = 0;
let successRequests = 0;
let failedRequests = 0;
let avgLatency = 0;
let latencySum = 0;
let latencyCount = 0;
const startTime = Date.now();
const requestLogs: RequestLog[] = [];

const DATA_DIR = process.env.CONDUIT_DATA_DIR || path.join(process.cwd(), 'data');
const QWEN_ACCOUNTS_FILE = path.join(DATA_DIR, 'qwen-accounts.json');

function credentialKind(value: string): 'cookie' | 'bearer' | 'ticket' {
  if (value.includes('=') || value.includes(';')) return 'cookie';
  if (value.startsWith('ey') || value.length > 100) return 'bearer';
  return 'ticket';
}

function maskIdentity(value: string): string {
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function persistQwenAccounts() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const dashboardAccounts = accountPool.filter(account => account.source === 'dashboard');
  const temporary = `${QWEN_ACCOUNTS_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(dashboardAccounts, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, QWEN_ACCOUNTS_FILE);
}

function loadQwenAccounts() {
  const initialTokens = process.env.API_TOKENS || process.env.QWEN_TOKENS || '';
  initialTokens.split(',').map(s => s.trim()).filter(Boolean).forEach((value, index) => {
    accountPool.push({ id: `env-${index + 1}`, label: `Environment account ${index + 1}`, value, ok: true, failures: 0, source: 'environment', createdAt: Date.now() });
  });
  try {
    const saved = JSON.parse(fs.readFileSync(QWEN_ACCOUNTS_FILE, 'utf8')) as Partial<Account>[];
    for (const account of saved) {
      if (!account.value || accountPool.some(existing => existing.value === account.value)) continue;
      accountPool.push({
        id: account.id || crypto.randomUUID(), label: account.label || 'Qwen account', value: account.value,
        ok: account.ok !== false, failures: account.failures || 0, source: 'dashboard', createdAt: account.createdAt || Date.now(),
        lastUsed: account.lastUsed, cooldownUntil: account.cooldownUntil,
      });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[Conduit] Failed to load Qwen accounts:', (error as Error).message);
  }
}

loadQwenAccounts();

// Request logging & metrics middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const latency = Date.now() - start;
    const status = res.statusCode;

    // Ignore dashboard polling in logs
    if (req.url.startsWith('/admin/api/')) {
      return;
    }

    totalRequests++;
    if (status >= 400) {
      failedRequests++;
    } else {
      successRequests++;
    }

    latencySum += latency;
    latencyCount++;
    avgLatency = Math.round(latencySum / latencyCount);

    requestLogs.unshift({
      timestamp: Date.now(),
      method: req.method,
      url: req.url,
      status,
      latency,
    });

    if (requestLogs.length > 100) {
      requestLogs.pop();
    }
  });
  next();
});

// Admin Basic Authentication Middleware
app.use((req, res, next) => {
  const adminPassword = process.env.ADMIN_PASSWORD || '';
  if (!adminPassword) {
    return next();
  }

  if (req.url.startsWith('/admin')) {
    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Basic ')) {
      const credentials = Buffer.from(authHeader.substring(6), 'base64').toString('utf8');
      const [username, password] = credentials.split(':');
      if (password === adminPassword) {
        return next();
      }
    }

    res.setHeader('WWW-Authenticate', 'Basic realm="Admin Dashboard"');
    return res.status(401).send('Unauthorized: Invalid credentials.');
  }

  next();
});

// ============================================
// Baxia / SEC Anti-bot Heuristic Spoofing
// ============================================

function randomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  const randomBytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    result += chars[randomBytes[i] % chars.length];
  }
  return result;
}

function generateWebGLFingerprint() {
  const renderers = [
    'ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.6)',
    'ANGLE (NVIDIA, NVIDIA GeForce GTX 1080, OpenGL 4.6)',
    'ANGLE (AMD, AMD Radeon RX 580, OpenGL 4.6)',
  ];
  return { renderer: renderers[Math.floor(Math.random() * renderers.length)], vendor: 'Google Inc. (Intel)' };
}

function collectFingerprintData() {
  const platforms = ['Win32', 'Linux x86_64', 'MacIntel'];
  const languages = ['en-US', 'zh-CN', 'en-GB'];
  
  const canvasHash = crypto.createHash('md5')
    .update(crypto.randomBytes(32))
    .digest('base64')
    .substring(0, 32);

  return {
    p: platforms[Math.floor(Math.random() * platforms.length)],
    l: languages[Math.floor(Math.random() * languages.length)],
    hc: 4 + Math.floor(Math.random() * 12),
    dm: [4, 8, 16, 32][Math.floor(Math.random() * 4)],
    to: [-480, -300, 0, 60, 480][Math.floor(Math.random() * 5)],
    sw: 1920 + Math.floor(Math.random() * 200),
    sh: 1080 + Math.floor(Math.random() * 100),
    cd: 24,
    pr: [1, 1.25, 1.5, 2][Math.floor(Math.random() * 4)],
    wf: generateWebGLFingerprint().renderer.substring(0, 20),
    cf: canvasHash,
    af: (124.04347527516074 + Math.random() * 0.001).toFixed(14),
    ts: Date.now(),
    r: Math.random(),
  };
}

function encodeBaxiaToken(data: any): string {
  const jsonStr = JSON.stringify(data);
  const encoded = Buffer.from(jsonStr).toString('base64');
  return `${BAXIA_VERSION.replace(/\./g, '')}!${encoded}`;
}

async function getBaxiaTokens() {
  const bxUa = encodeBaxiaToken(collectFingerprintData());
  const bxUmidToken = 'T2gA' + randomString(40);
  return { bxUa, bxUmidToken, bxV: BAXIA_VERSION };
}

// Cookie Helper
function generateCookie(ticket: string): string {
  if (ticket.includes('=') && ticket.includes(';')) {
    return ticket;
  }
  if (ticket.startsWith('login_aliyunid_ticket=') || ticket.startsWith('tongyi_sso_ticket=')) {
    return ticket;
  }
  return `login_aliyunid_ticket=${ticket}; tongyi_sso_ticket=${ticket}`;
}

// Upstream Authentication Headers Generator (supporting legacy cookies & newer JWT tokens)
function buildAuthHeaders(ticket: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const looksLikeCookie = ticket.includes(';') || ticket.startsWith('login_aliyunid_ticket=') || ticket.startsWith('tongyi_sso_ticket=');
  if (!looksLikeCookie && (ticket.startsWith('ey') || ticket.length > 100)) {
    // Newer Qwen Web API v2 bearer session.
    headers.Authorization = `Bearer ${ticket}`;
  } else {
    // Complete Cookie headers and legacy Qwen SSO tickets.
    headers.Cookie = generateCookie(ticket);
  }
  return headers;
}

function decompressResponseBody(data: any): string {
  if (!data) return '';
  if (Buffer.isBuffer(data)) {
    try {
      return zlib.brotliDecompressSync(data).toString('utf-8');
    } catch {
      try {
        return zlib.gunzipSync(data).toString('utf-8');
      } catch {
        return data.toString('utf-8');
      }
    }
  }
  return String(data);
}

// Ticket selector utilizing the dynamic account pool & Bearer headers
function selectAccountTicket(authHeader?: string): { ticket: string; accountRef?: Account } {
  // A long bearer value is treated as an explicit Qwen credential. Short bearer
  // values remain available for a future Conduit API-key layer.
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const raw = authHeader.substring(7).trim();
    if (raw && !raw.includes('__REPLACE_ME__') && (raw.length > 40 || raw.includes('=') || raw.startsWith('ey'))) {
      return { ticket: raw };
    }
  }

  const now = Date.now();
  for (const account of accountPool) {
    if (!account.ok && account.cooldownUntil && account.cooldownUntil <= now) {
      account.ok = true;
      account.cooldownUntil = undefined;
    }
  }
  const available = accountPool
    .filter(account => account.ok && (!account.cooldownUntil || account.cooldownUntil <= now))
    .sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
  if (available.length === 0) {
    const retryAt = accountPool.reduce<number | undefined>((earliest, account) => {
      if (!account.cooldownUntil) return earliest;
      return earliest === undefined ? account.cooldownUntil : Math.min(earliest, account.cooldownUntil);
    }, undefined);
    const detail = retryAt ? ` Earliest retry: ${new Date(retryAt).toISOString()}.` : '';
    throw new Error(`No healthy Qwen credentials are available.${detail}`);
  }

  const selected = available[0];
  selected.lastUsed = now;
  return { ticket: selected.value, accountRef: selected };
}

function markAccountSuccess(account?: Account) {
  if (!account) return;
  account.ok = true;
  account.failures = 0;
  account.cooldownUntil = undefined;
}

function markAccountFailure(account?: Account) {
  if (!account) return;
  account.failures += 1;
  const base = Number(process.env.QWEN_ACCOUNT_COOLDOWN_MS) || 30_000;
  const delay = Math.min(base * (2 ** Math.max(0, account.failures - 1)), 15 * 60_000);
  account.ok = false;
  account.cooldownUntil = Date.now() + delay;
}

// ============================================
// File Uploads & OSS Signature (HMAC V4 Aliyun)
// ============================================

interface Attachment {
  source: string;
  filename?: string;
  mimeType?: string;
  explicitType?: string;
}

interface LoadedFile {
  bytes: Buffer;
  mimeType: string;
  filename: string;
  explicitType?: string;
}

function parseDataUrl(dataUrl: string): { mimeType: string; bytes: Buffer } | null {
  const matched = dataUrl.match(/^data:([^;,]+)?;base64,(.+)$/i);
  if (!matched) return null;
  return {
    mimeType: matched[1] || 'application/octet-stream',
    bytes: Buffer.from(matched[2], 'base64'),
  };
}

function inferFileCategory(mimeType: string, explicitType?: string): 'image' | 'audio' | 'video' | 'document' {
  if (explicitType === 'image' || explicitType === 'audio' || explicitType === 'video' || explicitType === 'document') {
    return explicitType;
  }
  const mimeLower = mimeType.toLowerCase();
  if (mimeLower.startsWith('image/')) return 'image';
  if (mimeLower.startsWith('audio/')) return 'audio';
  if (mimeLower.startsWith('video/')) return 'video';
  return 'document';
}

function fileExtensionFromMime(mimeType: string): string {
  const ext = mime.extension(mimeType);
  return ext || 'bin';
}

async function getAttachmentBytes(attachment: Attachment): Promise<LoadedFile> {
  const dataParsed = parseDataUrl(attachment.source);
  if (dataParsed) {
    const mimeType = attachment.mimeType || dataParsed.mimeType;
    return {
      bytes: dataParsed.bytes,
      mimeType,
      filename: attachment.filename || `file-${crypto.randomUUID()}.${fileExtensionFromMime(mimeType)}`,
      explicitType: attachment.explicitType,
    };
  }

  if (/^https?:\/\//i.test(attachment.source)) {
    const resp = await axios.get(attachment.source, { responseType: 'arraybuffer' });
    const contentType = resp.headers['content-type'];
    const mimeType = attachment.mimeType || (typeof contentType === 'string' ? contentType : 'application/octet-stream');
    return {
      bytes: Buffer.from(resp.data),
      mimeType,
      filename: attachment.filename || `file-${crypto.randomUUID()}.${fileExtensionFromMime(mimeType)}`,
      explicitType: attachment.explicitType,
    };
  }

  // Base64 fallback
  const bytes = Buffer.from(attachment.source, 'base64');
  const mimeType = attachment.mimeType || 'application/octet-stream';
  return {
    bytes,
    mimeType,
    filename: attachment.filename || `file-${crypto.randomUUID()}.${fileExtensionFromMime(mimeType)}`,
    explicitType: attachment.explicitType,
  };
}

async function requestUploadToken(file: LoadedFile, ticket: string, baxia: any) {
  const filetype = inferFileCategory(file.mimeType, file.explicitType);
  
  const resp = await axios.post(`${QWEN_BASE_URL}/api/v2/files/getstsToken`, {
    filename: file.filename,
    filesize: file.bytes.length,
    filetype,
  }, {
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'bx-ua': baxia.bxUa,
      'bx-umidtoken': baxia.bxUmidToken,
      'bx-v': baxia.bxV,
      'source': 'web',
      'timezone': new Date().toUTCString(),
      'Referer': QWEN_WEB_REFERER,
      'User-Agent': WEB_USER_AGENT,
      ...buildAuthHeaders(ticket),
      'x-request-id': crypto.randomUUID(),
    }
  });

  if (!resp.data?.success || !resp.data?.data?.file_url) {
    throw new Error(`Failed to obtain upload STS token: ${JSON.stringify(resp.data)}`);
  }

  return {
    tokenData: resp.data.data,
    filetype,
  };
}

function formatOssDate(date = new Date()) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mi = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}T${hh}${mi}${ss}Z`;
}

function formatOssDateScope(date = new Date()) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

async function buildOssSignedHeaders(uploadUrl: string, tokenData: any, file: LoadedFile) {
  const parsedUrl = new URL(uploadUrl);
  const query = parsedUrl.searchParams;
  const credentialFromQuery = decodeURIComponent(query.get('x-oss-credential') || '');
  const credentialParts = credentialFromQuery.split('/');

  const dateScope = credentialParts[1] || formatOssDateScope();
  const region = credentialParts[2] || 'ap-southeast-1';
  const xOssDate = query.get('x-oss-date') || formatOssDate();

  const hostParts = parsedUrl.hostname.split('.');
  const bucket = hostParts.length > 0 ? hostParts[0] : '';
  const objectPath = parsedUrl.pathname || '/';
  const canonicalUri = bucket ? `/${bucket}${objectPath}` : objectPath;
  const xOssUserAgent = 'aliyun-sdk-js/6.23.0';

  const canonicalHeaders = [
    `content-type:${file.mimeType}`,
    'x-oss-content-sha256:UNSIGNED-PAYLOAD',
    `x-oss-date:${xOssDate}`,
    `x-oss-security-token:${tokenData.security_token}`,
    `x-oss-user-agent:${xOssUserAgent}`,
  ].join('\n') + '\n';

  const canonicalRequest = [
    'PUT',
    canonicalUri,
    '',
    canonicalHeaders,
    '',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const credentialScope = `${dateScope}/${region}/oss/aliyun_v4_request`;
  
  const stringToSign = [
    'OSS4-HMAC-SHA256',
    xOssDate,
    credentialScope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');

  const kDate = crypto.createHmac('sha256', `aliyun_v4${tokenData.access_key_secret}`).update(dateScope).digest();
  const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
  const kService = crypto.createHmac('sha256', kRegion).update('oss').digest();
  const kSigning = crypto.createHmac('sha256', kService).update('aliyun_v4_request').digest();
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return {
    'Accept': '*/*',
    'Content-Type': file.mimeType,
    'authorization': `OSS4-HMAC-SHA256 Credential=${tokenData.access_key_id}/${credentialScope},Signature=${signature}`,
    'x-oss-content-sha256': 'UNSIGNED-PAYLOAD',
    'x-oss-date': xOssDate,
    'x-oss-security-token': tokenData.security_token,
    'x-oss-user-agent': xOssUserAgent,
    'Referer': QWEN_WEB_REFERER,
  };
}

async function uploadFileToQwenOss(file: LoadedFile, tokenData: any) {
  const uploadUrl = typeof tokenData.file_url === 'string' ? tokenData.file_url.split('?')[0] : '';
  if (!uploadUrl) {
    throw new Error('Upload failed: missing upload URL');
  }
  const headers = await buildOssSignedHeaders(tokenData.file_url, tokenData, file);
  await axios.put(uploadUrl, file.bytes, { headers });
}

async function ensureUploadStatusForNonVideo(filetype: string, ticket: string, baxia: any) {
  if (filetype === 'video') return;
  const maxAttempts = 6;
  let lastPayload: any = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const resp = await axios.post(`${QWEN_BASE_URL}/api/v2/users/status`, {
      typarms: {
        typarm1: 'web',
        typarm2: '',
        typarm3: 'prod',
        typarm4: 'qwen_chat',
        typarm5: 'product',
        orgid: 'tongyi',
      }
    }, {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'bx-v': baxia.bxV,
        'source': 'web',
        'timezone': new Date().toUTCString(),
        'Referer': QWEN_WEB_REFERER,
        ...buildAuthHeaders(ticket),
        'x-request-id': crypto.randomUUID(),
      }
    });
    lastPayload = resp.data;
    if (resp.data?.data === true) {
      return;
    }
    if (attempt < maxAttempts) {
      await new Promise(r => setTimeout(r, 400));
    }
  }
  throw new Error(`Upload status check failed/timed out: ${JSON.stringify(lastPayload)}`);
}

async function parseDocumentIfNeeded(fileId: string, filetype: string, file: LoadedFile, ticket: string, baxia: any) {
  if (filetype !== 'document') return;
  const resp = await axios.post(`${QWEN_BASE_URL}/api/v2/files/parse`, {
    file_id: fileId
  }, {
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'bx-ua': baxia.bxUa,
      'bx-umidtoken': baxia.bxUmidToken,
      'bx-v': baxia.bxV,
      'source': 'web',
      'timezone': new Date().toUTCString(),
      'Referer': QWEN_WEB_REFERER,
      ...buildAuthHeaders(ticket),
      'x-request-id': crypto.randomUUID(),
    }
  });

  if (!resp.data?.success) {
    throw new Error(`Document parse failed: ${JSON.stringify(resp.data)}`);
  }
}

function extractUploadedFileId(fileUrl: string): string {
  try {
    const pathname = decodeURIComponent(new URL(fileUrl).pathname);
    const filename = pathname.split('/').pop() || '';
    if (filename.includes('_')) {
      return filename.split('_')[0];
    }
  } catch {}
  return crypto.randomUUID();
}

function buildQwenFilePayload(file: LoadedFile, tokenData: any, filetype: string) {
  const now = Date.now();
  const id = tokenData?.file_id || extractUploadedFileId(tokenData.file_url);
  const isDocument = filetype === 'document';
  const showType = isDocument ? 'file' : filetype;
  const fileClass = isDocument ? 'document' : (filetype === 'image' ? 'vision' : filetype);
  const fileSize = file.bytes.length;

  return {
    type: showType,
    file: {
      created_at: now,
      data: {},
      filename: file.filename,
      hash: null,
      id,
      meta: {
        name: file.filename,
        size: fileSize,
        content_type: file.mimeType,
      },
      update_at: now,
    },
    id,
    url: tokenData.file_url,
    name: file.filename,
    collection_name: '',
    progress: 0,
    status: 'uploaded',
    is_uploading: false,
    error: '',
    showType,
    file_class: fileClass,
    itemId: crypto.randomUUID(),
    greenNet: 'success',
    size: fileSize,
    file_type: file.mimeType,
    uploadTaskId: crypto.randomUUID(),
  };
}

async function uploadAttachments(attachments: Attachment[], ticket: string, baxia: any) {
  const files = [];
  for (const rawAttachment of attachments) {
    const loaded = await getAttachmentBytes(rawAttachment);
    const { tokenData, filetype } = await requestUploadToken(loaded, ticket, baxia);
    await uploadFileToQwenOss(loaded, tokenData);
    const qwenFile = buildQwenFilePayload(loaded, tokenData, filetype);
    
    await ensureUploadStatusForNonVideo(filetype, ticket, baxia);
    if (filetype === 'document') {
      await parseDocumentIfNeeded(qwenFile.id, filetype, loaded, ticket, baxia);
      await ensureUploadStatusForNonVideo(filetype, ticket, baxia);
    }
    files.push(qwenFile);
  }
  return files;
}

// ============================================
// Message & Request Converters (Tool calling & flattening)
// ============================================

function getAttachmentsFromContent(content: string | any[]): Attachment[] {
  const attachments: Attachment[] = [];
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part) continue;
      if (part.type === 'image_url' && part.image_url?.url) {
        attachments.push({ source: part.image_url.url, explicitType: 'image' });
      } else if (part.type === 'file' && part.file?.file_data) {
        attachments.push({
          source: part.file.file_data,
          filename: part.file.filename,
          explicitType: 'document',
        });
      }
    }
  }
  return attachments;
}

// Size Mapping for Images
function mapOpenAiImageSizeToQwenRatio(size?: string): string {
  if (!size) return '1:1';
  const sizeLower = size.toLowerCase().trim();
  if (['1:1', '16:9', '9:16', '4:3', '3:4'].includes(sizeLower)) {
    return sizeLower;
  }
  const match = sizeLower.match(/^(\d{2,5})\s*x\s*(\d{2,5})$/);
  if (!match) return '1:1';
  const width = Number(match[1]);
  const height = Number(match[2]);
  const ratio = width / height;

  const candidates = [
    { key: '1:1', val: 1.0 },
    { key: '16:9', val: 16 / 9 },
    { key: '9:16', val: 9 / 16 },
    { key: '4:3', val: 4 / 3 },
    { key: '3:4', val: 3 / 4 },
  ];

  let best = candidates[0];
  let bestDiff = Infinity;
  for (const c of candidates) {
    const diff = Math.abs(ratio - c.val);
    if (diff < bestDiff) {
      best = c;
      bestDiff = diff;
    }
  }
  return best.key;
}

// Helper to extract image URLs from Qwen SSE output
function extractImageUrlsFromUpstreamSse(rawPayload: string): string[] {
  const urls: string[] = [];
  for (const line of rawPayload.split('\n')) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('data:')) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const parsed = JSON.parse(data);
      const delta = parsed?.choices?.[0]?.delta;
      if (delta?.phase === 'image_gen' && typeof delta.content === 'string') {
        const url = delta.content.trim();
        if (url && /^https?:\/\//i.test(url)) {
          urls.push(url);
        }
      }
    } catch {}
  }
  return Array.from(new Set(urls));
}

// Helper to extract error block from Qwen SSE output
function extractUpstreamErrorFromSse(rawPayload: string) {
  for (const line of rawPayload.split('\n')) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('data:')) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const parsed = JSON.parse(data);
      if (parsed?.error) {
        return parsed.error;
      }
    } catch {}
  }
  return null;
}

// Parse standard streaming payload
function parseQwenSsePayload(rawPayload: string) {
  const events: any[] = [];
  let content = '';
  let reasoning = '';
  let usage = null;

  for (const line of rawPayload.split('\n')) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('data:')) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const parsed = JSON.parse(data);
      if (parsed?.usage) {
        usage = parsed.usage;
      }
      const delta = parsed?.choices?.[0]?.delta;
      if (!delta) continue;
      
      const chunkDelta: any = {};
      if (delta.role === 'assistant') chunkDelta.role = 'assistant';
      if (typeof delta.content === 'string') {
        chunkDelta.content = delta.content;
        content += delta.content;
      }
      
      // Parse thought summary / reasoning
      let reasoningContent = delta.reasoning_content || delta.reasoning || '';
      if (!reasoningContent && delta.phase === 'thinking_summary') {
        const summaryThought = delta?.extra?.summary_thought?.content;
        if (typeof summaryThought === 'string') {
          reasoningContent = summaryThought;
        } else if (Array.isArray(summaryThought)) {
          reasoningContent = summaryThought.map((s: any) => typeof s === 'string' ? s : (s?.text || s?.content || '')).join('\n');
        }
      }
      if (reasoningContent) {
        chunkDelta.reasoning_content = reasoningContent;
        reasoning += reasoningContent;
      }

      const finish_reason = parsed?.choices?.[0]?.finish_reason || null;
      events.push({ delta: chunkDelta, finish_reason });
    } catch {}
  }

  return { events, content, reasoning, usage };
}

// ============================================
// Dashboard Admin APIs
// ============================================

// Serve static admin index
app.get('/admin', (req: Request, res: Response) => {
  const adminHtmlPath = path.join(__dirname, '../public/admin.html');
  if (fs.existsSync(adminHtmlPath)) {
    res.sendFile(adminHtmlPath);
  } else {
    res.sendFile(path.join(__dirname, 'public/admin.html'));
  }
});

// Redirect root to admin if visited via standard browser HTML request
app.get('/', (req: Request, res: Response) => {
  const acceptHeader = req.headers.accept || '';
  if (acceptHeader.includes('text/html')) {
    return res.redirect('/admin');
  }
  res.send('Conduit is running with Qwen, DeepSeek, and Gemini providers. Use POST /v1/chat/completions or visit /admin.');
});

// Process liveness is intentionally independent of provider availability.
// Conduit remains useful when only one provider is configured or healthy.
app.get('/health/live', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'conduit', uptimeSeconds: Math.floor(process.uptime()) });
});

app.get('/health/ready', async (_req: Request, res: Response) => {
  const [deepseek, gemini] = await Promise.all([getDeepSeekStatus(), getGeminiStatus()]);
  const qwen = { id: 'qwen', healthy: accountPool.some(account => account.ok), accounts: accountPool.length };
  const providers = [qwen, deepseek, gemini];
  const ready = providers.some(provider => provider.healthy === true);
  res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'degraded', ready, providers });
});

// Fetch metrics & stats
app.get('/admin/api/providers', async (_req: Request, res: Response) => {
  const [deepseek, gemini] = await Promise.all([getDeepSeekStatus(), getGeminiStatus()]);
  res.json({
    object: 'list',
    data: [
      { id: 'qwen', name: 'Qwen', mode: 'native', enabled: accountPool.length > 0, healthy: accountPool.some(a => a.ok), accounts: accountPool.length },
      { ...deepseek, name: 'DeepSeek', mode: 'managed-service' },
      { ...gemini, name: 'Gemini', mode: 'managed-service' },
    ],
  });
});

app.get('/admin/api/stats', (req: Request, res: Response) => {
  const totalMem = Math.round(process.memoryUsage().rss / 1024 / 1024);
  res.json({
    stats: {
      totalRequests,
      successRequests,
      failedRequests,
      avgLatency,
    },
    accounts: accountPool.map(({ value, ...account }) => ({
      ...account,
      provider: 'qwen', credential: maskIdentity(value), credentialKind: credentialKind(value),
    })),
    sys: {
      node: process.version,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      memory: `${totalMem} MB`,
    },
    config: {
      enableSearch: process.env.ENABLE_SEARCH === 'true',
      port: PORT,
      nodeEnv: process.env.NODE_ENV || 'development',
    },
    logs: requestLogs,
  });
});

// Qwen account-session management. Alibaba/Qwen login is browser-based and may
// require CAPTCHA, OTP, SSO, or federated approval, so Conduit imports the
// resulting browser session instead of storing an Alibaba password.
app.post('/admin/api/providers/qwen/accounts', (req: Request, res: Response) => {
  try {
    const label = String(req.body?.label || '').trim() || `Qwen account ${accountPool.length + 1}`;
    const session = String(req.body?.session || req.body?.tokens || '').trim();
    if (!session) return res.status(400).json({ success: false, error: 'A Qwen browser session is required.' });
    if (accountPool.some(account => account.value === session)) return res.status(409).json({ success: false, error: 'This Qwen session is already configured.' });
    accountPool.push({ id: crypto.randomUUID(), label, value: session, ok: true, failures: 0, source: 'dashboard', createdAt: Date.now() });
    persistQwenAccounts();
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/admin/api/providers/qwen/accounts/:id', (req: Request, res: Response) => {
  try {
    const index = accountPool.findIndex(account => account.id === req.params.id);
    if (index < 0) return res.status(404).json({ success: false, error: 'Qwen account not found.' });
    if (accountPool[index].source === 'environment') return res.status(409).json({ success: false, error: 'Environment accounts must be removed from QWEN_TOKENS.' });
    accountPool.splice(index, 1);
    persistQwenAccounts();
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Legacy aliases retained for existing dashboard/API clients.
app.post('/admin/api/accounts', (req: Request, res: Response) => {
  req.body = { label: req.body?.label, session: req.body?.tokens || req.body?.session };
  const session = String(req.body.session || '').trim();
  if (!session) return res.status(400).json({ success: false, error: 'A Qwen browser session is required.' });
  if (accountPool.some(account => account.value === session)) return res.status(409).json({ success: false, error: 'This Qwen session is already configured.' });
  accountPool.push({ id: crypto.randomUUID(), label: String(req.body.label || `Qwen account ${accountPool.length + 1}`), value: session, ok: true, failures: 0, source: 'dashboard', createdAt: Date.now() });
  persistQwenAccounts();
  res.json({ success: true });
});

app.get('/admin/api/providers/deepseek/accounts', async (_req: Request, res: Response) => {
  try { res.json({ success: true, accounts: await getDeepSeekAccounts() }); }
  catch (err: any) { res.status(502).json({ success: false, error: err.message }); }
});

app.post('/admin/api/providers/deepseek/accounts', async (req: Request, res: Response) => {
  try { await addDeepSeekAccount(req.body || {}); res.json({ success: true }); }
  catch (err: any) { res.status(400).json({ success: false, error: err.message }); }
});

app.get('/admin/api/providers/deepseek/config', async (_req: Request, res: Response) => {
  try { res.json({ success: true, config: await getDeepSeekConfig() }); }
  catch (err: any) { res.status(502).json({ success: false, error: err.message }); }
});

app.put('/admin/api/providers/deepseek/config', async (req: Request, res: Response) => {
  try { res.json({ success: true, result: await updateDeepSeekConfig(req.body || {}) }); }
  catch (err: any) { res.status(400).json({ success: false, error: err.message }); }
});

app.delete('/admin/api/providers/deepseek/accounts/:index', async (req: Request, res: Response) => {
  try { await removeDeepSeekAccount(Number(req.params.index)); res.json({ success: true }); }
  catch (err: any) { res.status(400).json({ success: false, error: err.message }); }
});

app.get('/admin/api/providers/gemini/accounts', async (_req: Request, res: Response) => {
  try { res.json({ success: true, accounts: await getGeminiAccounts() }); }
  catch (err: any) { res.status(502).json({ success: false, error: err.message }); }
});

app.post('/admin/api/providers/gemini/accounts', async (req: Request, res: Response) => {
  try { res.json({ success: true, account: await addGeminiAccount(req.body || {}) }); }
  catch (err: any) { res.status(400).json({ success: false, error: err.message }); }
});

app.delete('/admin/api/providers/gemini/accounts/:id', async (req: Request, res: Response) => {
  try { await removeGeminiAccount(req.params.id); res.json({ success: true }); }
  catch (err: any) { res.status(400).json({ success: false, error: err.message }); }
});

// Clear Request Logs
app.get('/admin/api/logs', (_req: Request, res: Response) => {
  res.json({ success: true, logs: requestLogs });
});

app.delete('/admin/api/logs', (_req: Request, res: Response) => {
  requestLogs.length = 0;
  res.json({ success: true });
});

// ============================================
// Original OpenAI Compatibility Routes
// ============================================

interface ResolvedModel {
  actualModel: string;
  thinkingEnabled: boolean;
  autoThinking?: boolean;
}

function resolveModelName(model?: string): ResolvedModel {
  if (!model) {
    return { actualModel: 'qwen3.7-max', thinkingEnabled: true, autoThinking: true };
  }
  let m = model.toLowerCase().trim();
  let thinkingEnabled = true;
  let autoThinking = true;

  if (m.endsWith('-thinking')) {
    m = m.replace('-thinking', '');
    thinkingEnabled = true;
    autoThinking = false;
  } else if (m.endsWith('-fast')) {
    m = m.replace('-fast', '');
    thinkingEnabled = false;
  }

  let actualModel = 'qwen3.7-max';
  if (m === 'qwen3.7-max' || m === 'qwen-max' || m.includes('3.7-max') || m.includes('max-latest') || m === 'qwen-max-latest') {
    actualModel = 'qwen3.7-max';
  } else if (m === 'qwen3.7-plus' || m === 'qwen-plus' || m.includes('3.7-plus') || m.includes('plus-latest')) {
    actualModel = 'qwen3.7-plus';
  } else if (m === 'qwen3.6-plus' || m.includes('3.6-plus')) {
    actualModel = 'qwen3.6-plus';
  } else if (m === 'qwen3.6-max' || m.includes('3.6-max')) {
    actualModel = 'qwen3.6-max-preview';
  } else if (m === 'qwen3.6-27b') {
    actualModel = 'qwen3.6-27b';
  } else if (m === 'qwen3-coder-plus' || m === 'qwen-coder') {
    actualModel = 'qwen3-coder-plus';
  } else if (m === 'qwen3-vl-plus' || m === 'qwen-vl') {
    actualModel = 'qwen3-vl-plus';
  } else if (m === 'qwen3-max') {
    actualModel = 'qwen3-max-2026-01-23';
  } else if (m === 'qwen3.5-plus') {
    actualModel = 'qwen3.5-plus';
  } else if (m === 'qwen3.5-flash') {
    actualModel = 'qwen3.5-flash';
  } else {
    // Default fallback to flagship model
    actualModel = 'qwen3.7-max';
  }

  return { actualModel, thinkingEnabled, autoThinking };
}

// Model List endpoint
app.get('/v1/models', async (_req: Request, res: Response) => {
  const baseModels = [
    { id: 'qwen3.7-max', description: 'Flagship reasoning and intelligence model' },
    { id: 'qwen3.7-plus', description: 'Next-gen flagship multimodal model' },
    { id: 'qwen3.6-plus', description: 'Reasoning-enabled multimodal model' },
    { id: 'qwen3.6-max', description: 'Prior generation flagship preview' },
    { id: 'qwen3.6-27b', description: 'Compact and high-speed Qwen3.6 engine' },
    { id: 'qwen3-coder-plus', description: 'Strong coding and tool-use model' },
    { id: 'qwen3-vl-plus', description: 'Alibaba vision-language flagship' },
    { id: 'qwen3-max', description: 'First generation Qwen3 flagship' },
    { id: 'qwen3.5-plus', description: 'Legacy Qwen3.5 standard model' },
    { id: 'qwen3.5-flash', description: 'Legacy Qwen3.5 high-speed model' },
    { id: 'qwen-max', description: 'Alias for qwen3.7-max' },
    { id: 'qwen-plus', description: 'Alias for qwen3.7-plus' },
    { id: 'qwen-coder', description: 'Alias for qwen3-coder-plus' }
  ];

  const models: any[] = [...deepSeekModels(), ...(await geminiModels())];
  for (const base of baseModels) {
    models.push({ id: base.id, object: 'model', created: 1720000000, owned_by: 'qwen-free-api', description: base.description });
    models.push({ id: `${base.id}-thinking`, object: 'model', created: 1720000000, owned_by: 'qwen-free-api', description: `${base.description} (Force thinking)` });
    models.push({ id: `${base.id}-fast`, object: 'model', created: 1720000000, owned_by: 'qwen-free-api', description: `${base.description} (Fast mode, no thinking)` });
  }

  res.json({
    object: 'list',
    data: models
  });
});

// Image Generations endpoint
app.post('/v1/images/generations', async (req: Request, res: Response) => {
  let accountRef: Account | undefined;
  try {
    const authHeader = req.headers.authorization;
    const selection = selectAccountTicket(authHeader);
    const ticket = selection.ticket;
    accountRef = selection.accountRef;
    
    const { prompt, model, n = 1, size, response_format = 'url' } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: { message: 'prompt is required', type: 'invalid_request_error' } });
    }

    const { actualModel } = resolveModelName(model);
    const qwenRatio = mapOpenAiImageSizeToQwenRatio(size);
    const baxia = await getBaxiaTokens();

    const createResp = await axios.post(`${QWEN_BASE_URL}/api/v2/chats/new`, {
      title: '新建对话',
      models: [actualModel],
      chat_mode: 'normal',
      chat_type: 't2i',
      timestamp: Date.now(),
      project_id: '',
    }, {
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'bx-ua': baxia.bxUa,
        'bx-umidtoken': baxia.bxUmidToken,
        'bx-v': baxia.bxV,
        'Referer': QWEN_GUEST_REFERER,
        'source': 'web',
        'User-Agent': WEB_USER_AGENT,
        ...buildAuthHeaders(ticket),
        'x-request-id': crypto.randomUUID(),
      }
    });

    if (!createResp.data?.success || !createResp.data?.data?.id) {
      markAccountFailure(accountRef);
      console.error(`[Qwen API] Create chat failed. Upstream response:`, JSON.stringify(createResp.data));
      return res.status(500).json({ error: { message: createResp.data?.data?.message || 'Failed to create image generation session', type: 'api_error' } });
    }
    const chatId = createResp.data.data.id;

    const finalPrompt = n === 1 ? prompt : `${prompt}\n\n(Generate ${n} images.)`;
    const imageResp = await axios.post(`${QWEN_BASE_URL}/api/v2/chat/completions?chat_id=${chatId}`, {
      stream: true,
      version: '2.1',
      incremental_output: true,
      chat_id: chatId,
      chat_mode: 'normal',
      model: actualModel,
      parent_id: null,
      messages: [{
        fid: crypto.randomUUID(),
        parentId: null,
        childrenIds: [crypto.randomUUID()],
        role: 'user',
        content: finalPrompt,
        user_action: 'chat',
        files: [],
        timestamp: Date.now(),
        models: [actualModel],
        chat_type: 't2i',
        feature_config: {
          thinking_enabled: true,
          output_schema: 'phase',
          research_mode: 'normal',
          auto_thinking: true,
          thinking_mode: 'Auto',
          thinking_format: 'summary',
          auto_search: true,
        },
        extra: { meta: { subChatType: 't2i' } },
        sub_chat_type: 't2i',
        parent_id: null,
      }],
      timestamp: Date.now(),
      size: qwenRatio,
    }, {
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'bx-ua': baxia.bxUa,
        'bx-umidtoken': baxia.bxUmidToken,
        'bx-v': baxia.bxV,
        'source': 'web',
        'version': '0.2.9',
        'Referer': QWEN_GUEST_REFERER,
        'User-Agent': WEB_USER_AGENT,
        ...buildAuthHeaders(ticket),
        'x-request-id': crypto.randomUUID(),
      }
    });

    const rawText = imageResp.data;
    const urls = extractImageUrlsFromUpstreamSse(rawText);

    if (urls.length === 0) {
      const errorMsg = extractUpstreamErrorFromSse(rawText);
      return res.status(502).json({ error: { message: errorMsg?.message || 'Upstream returned no image URLs', type: 'api_error' } });
    }

    const created = Math.floor(Date.now() / 1000);
    markAccountSuccess(accountRef);
    res.setHeader('x-conduit-provider', 'qwen');
    if (response_format === 'url') {
      return res.json({
        created,
        data: urls.slice(0, n).map(u => ({ url: u })),
      });
    }

    const b64DataList = await Promise.all(urls.slice(0, n).map(async (u) => {
      const imageBytes = await axios.get(u, { responseType: 'arraybuffer' });
      return { b64_json: Buffer.from(imageBytes.data).toString('base64') };
    }));

    return res.json({ created, data: b64DataList });
  } catch (err: any) {
    markAccountFailure(accountRef);
    console.error(`[Qwen API] Upstream error:`, err.response?.data ? JSON.stringify(err.response.data) : err.message);
    res.status(500).json({ error: { message: err.message, type: 'api_error' } });
  }
});

// Specialized provider services evolve independently behind Conduit's routing contract.
app.post('/v1/chat/completions', proxyDeepSeekChat);
app.post('/v1/chat/completions', proxyGeminiChat);

// Qwen Chat Completions provider
app.post('/v1/chat/completions', async (req: Request, res: Response) => {
  let accountRef: Account | undefined;
  try {
    const { model, messages, stream = false } = req.body;
    const toolRegistry = buildToolRegistry(req.body.tools);
    const toolOptions = normalizeToolOptions(req.body, toolRegistry);
    validateConversation(messages, toolRegistry);

    const authHeader = req.headers.authorization;
    const selection = selectAccountTicket(authHeader);
    const ticket = selection.ticket;
    accountRef = selection.accountRef;

    const { actualModel, thinkingEnabled, autoThinking } = resolveModelName(model);
    const baxia = await getBaxiaTokens();
    const enableSearch = process.env.ENABLE_SEARCH === 'true';
    const chatType = enableSearch ? 'search' : 't2t';

    const createResp = await axios.post(`${QWEN_BASE_URL}/api/v2/chats/new`, {
      title: '新建对话',
      models: [actualModel],
      chat_mode: 'normal',
      chat_type: chatType,
      timestamp: Date.now(),
      project_id: '',
    }, {
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'bx-ua': baxia.bxUa,
        'bx-umidtoken': baxia.bxUmidToken,
        'bx-v': baxia.bxV,
        'Referer': QWEN_GUEST_REFERER,
        'source': 'web',
        'User-Agent': WEB_USER_AGENT,
        ...buildAuthHeaders(ticket),
        'x-request-id': crypto.randomUUID(),
      }
    });

    if (!createResp.data?.success || !createResp.data?.data?.id) {
      markAccountFailure(accountRef);
      console.error(`[Qwen API] Create chat failed. Upstream response:`, JSON.stringify(createResp.data));
      return res.status(500).json({ error: { message: createResp.data?.data?.message || 'Failed to create chat session', type: 'api_error' } });
    }
    const chatId = createResp.data.data.id;

    const promptContent = buildQwenPrompt(messages, toolRegistry, toolOptions);
    const lastMessage = messages[messages.length - 1];
    const attachments = lastMessage?.role === 'user' && lastMessage.content
      ? getAttachmentsFromContent(lastMessage.content)
      : [];
    const uploadedFiles = attachments.length > 0
      ? await uploadAttachments(attachments, ticket, baxia)
      : [];

    const requestQwenCompletion = async (content: string) => axios.post(
      `${QWEN_BASE_URL}/api/v2/chat/completions?chat_id=${chatId}`,
      {
        stream: true,
        version: '2.1',
        incremental_output: true,
        chat_id: chatId,
        chat_mode: 'normal',
        model: actualModel,
        parent_id: null,
        messages: [{
          fid: crypto.randomUUID(),
          parentId: null,
          childrenIds: [crypto.randomUUID()],
          role: 'user',
          content,
          user_action: 'chat',
          files: uploadedFiles,
          timestamp: Date.now(),
          models: [actualModel],
          chat_type: chatType,
          feature_config: {
            thinking_enabled: thinkingEnabled,
            output_schema: 'phase',
            research_mode: 'normal',
            auto_thinking: autoThinking,
            thinking_format: 'summary',
            auto_search: enableSearch,
          },
          extra: { meta: { subChatType: chatType } },
          sub_chat_type: chatType,
          parent_id: null,
        }],
        timestamp: Date.now(),
      },
      {
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'bx-ua': baxia.bxUa,
          'bx-umidtoken': baxia.bxUmidToken,
          'bx-v': baxia.bxV,
          'source': 'web',
          'version': '0.2.9',
          'Referer': QWEN_GUEST_REFERER,
          'User-Agent': WEB_USER_AGENT,
          ...buildAuthHeaders(ticket),
          'x-request-id': crypto.randomUUID(),
        },
        responseType: 'arraybuffer',
      },
    );

    const responseId = `chatcmpl-${crypto.randomUUID()}`;
    const createdTime = Math.floor(Date.now() / 1000);

    let qwenResp = await requestQwenCompletion(promptContent);
    let decompressedBody = decompressResponseBody(qwenResp.data);
    console.log(`[Qwen Decompressed SSE Response length]: ${decompressedBody.length}`);
    let sseParsed = parseQwenSsePayload(decompressedBody);
    let toolResult = toolRegistry.tools.length > 0 && toolOptions.toolChoice !== 'none'
      ? parseToolOutput(sseParsed.content, toolRegistry, toolOptions)
      : { kind: 'none' as const, toolCalls: [], cleanText: sseParsed.content };

    const firstFailure = toolResult.kind === 'malformed'
      ? toolResult.error
      : toolResult.kind === 'none' && shouldRequireTool(toolOptions)
        ? 'The response omitted the tool call required by tool_choice.'
        : null;

    // One bounded repair attempt improves reliability without creating an autonomous loop.
    if (firstFailure) {
      const repairPrompt = `${promptContent}

# Protocol repair
Your previous response was rejected: ${firstFailure}
Generate the assistant response again. Follow the tool protocol exactly. Do not discuss this repair instruction.`;
      qwenResp = await requestQwenCompletion(repairPrompt);
      decompressedBody = decompressResponseBody(qwenResp.data);
      console.log(`[Qwen Protocol Repair SSE Response length]: ${decompressedBody.length}`);
      sseParsed = parseQwenSsePayload(decompressedBody);
      toolResult = parseToolOutput(sseParsed.content, toolRegistry, toolOptions);
    }

    if (toolResult.kind === 'malformed') {
      console.error(`[Tool Protocol] Rejected malformed model output: ${toolResult.error}`);
      return res.status(502).json({
        error: {
          message: `The upstream model produced an invalid tool call after one repair attempt: ${toolResult.error}`,
          type: 'api_error',
          code: 'invalid_tool_call',
        }
      });
    }
    if (toolResult.kind === 'none' && shouldRequireTool(toolOptions)) {
      return res.status(502).json({
        error: {
          message: 'The upstream model did not produce the tool call required by tool_choice after one repair attempt.',
          type: 'api_error',
          code: 'tool_choice_not_followed',
        }
      });
    }
    const parsedToolCalls = toolResult.kind === 'tool_calls' ? toolResult.toolCalls : null;
    const cleanContent = toolResult.cleanText;
    markAccountSuccess(accountRef);
    res.setHeader('x-conduit-provider', 'qwen');

    if (!stream) {
      const prompt_tokens = Math.ceil(promptContent.length / 4);
      const completion_tokens = Math.ceil(sseParsed.content.length / 4);

      return res.json({
        id: responseId,
        object: 'chat.completion',
        created: createdTime,
        model: actualModel,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: parsedToolCalls ? (cleanContent || null) : sseParsed.content,
            ...(sseParsed.reasoning ? { reasoning_content: sseParsed.reasoning } : {}),
            ...(parsedToolCalls ? { tool_calls: parsedToolCalls } : {})
          },
          finish_reason: parsedToolCalls ? 'tool_calls' : 'stop',
        }],
        usage: {
          prompt_tokens,
          completion_tokens,
          total_tokens: prompt_tokens + completion_tokens,
        }
      });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    if (parsedToolCalls) {
      if (cleanContent) {
        res.write(`data: ${JSON.stringify({
          id: responseId,
          object: 'chat.completion.chunk',
          created: createdTime,
          model: actualModel,
          choices: [{
            index: 0,
            delta: { role: 'assistant', content: cleanContent },
            finish_reason: null,
          }],
        })}\n\n`);
      }

      res.write(`data: ${JSON.stringify({
        id: responseId,
        object: 'chat.completion.chunk',
        created: createdTime,
        model: actualModel,
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: parsedToolCalls.map((call, index) => ({
              index,
              id: call.id,
              type: call.type,
              function: call.function,
            })),
          },
          finish_reason: null,
        }],
      })}\n\n`);

      res.write(`data: ${JSON.stringify({
        id: responseId,
        object: 'chat.completion.chunk',
        created: createdTime,
        model: actualModel,
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    for (const event of sseParsed.events) {
      if (event.delta && !event.delta.content && !event.delta.reasoning_content && !event.delta.role) {
        continue;
      }
      const dataStr = JSON.stringify({
        id: responseId,
        object: 'chat.completion.chunk',
        created: createdTime,
        model: actualModel,
        choices: [{
          index: 0,
          delta: event.delta,
          finish_reason: event.finish_reason || null,
        }],
      });
      res.write(`data: ${dataStr}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();

  } catch (err: any) {
    if (err instanceof InvalidRequestError) {
      return res.status(400).json({
        error: {
          message: err.message,
          type: 'invalid_request_error',
          ...(err.param ? { param: err.param } : {}),
        }
      });
    }
    markAccountFailure(accountRef);
    console.error(`[Qwen API] Upstream error:`, err.response?.data ? JSON.stringify(err.response.data) : err.message);
    return res.status(500).json({ error: { message: err.message, type: 'api_error' } });
  }
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Conduit] Listening on port ${PORT}.`);
  console.log(`[Conduit] Provider URLs: DeepSeek=${process.env.DEEPSEEK_BASE_URL || 'http://127.0.0.1:22217'}, Gemini=${process.env.GEMINI_BASE_URL || 'http://127.0.0.1:18000'}`);
});

let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Conduit] ${signal} received; draining HTTP connections.`);
  server.close(error => {
    if (error) {
      console.error('[Conduit] Graceful shutdown failed:', error);
      process.exitCode = 1;
    }
    process.exit();
  });
  setTimeout(() => {
    console.error('[Conduit] Shutdown deadline exceeded; forcing exit.');
    process.exit(1);
  }, 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));