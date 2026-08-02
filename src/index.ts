import express = require('express');
import { Request, Response } from 'express';
import cors = require('cors');
import crypto = require('crypto');
import axios from 'axios';
import mime = require('mime-types');
import { v4 as uuidv4 } from 'uuid';
import dotenv = require('dotenv');
import path = require('path');
import fs = require('fs');

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
  value: string;
  ok: boolean;
  lastUsed?: number;
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

// Initialize accounts from environment variables
const initialTokens = process.env.API_TOKENS || process.env.QWEN_TOKENS || '';
if (initialTokens) {
  initialTokens.split(',').map(s => s.trim()).filter(Boolean).forEach(token => {
    accountPool.push({ value: token, ok: true });
  });
}

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
  if (ticket.startsWith('ey') || ticket.length > 100) {
    // Newer Qwen Web API v2 token (JWT format)
    headers['Authorization'] = `Bearer ${ticket}`;
  } else {
    // Legacy Qwen Tongyi SSO ticket cookies
    headers['Cookie'] = generateCookie(ticket);
  }
  return headers;
}

// Ticket selector utilizing the dynamic account pool & Bearer headers
function selectAccountTicket(authHeader?: string): { ticket: string; accountRef?: Account } {
  // 1. Check if auth header passes a custom/live ticket directly
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const raw = authHeader.substring(7).trim();
    if (raw && !raw.includes('__REPLACE_ME__') && (raw.length > 40 || raw.includes('=') || raw.startsWith('ey'))) {
      // Direct pass-through
      return { ticket: raw };
    }
  }

  // 2. Otherwise rotate inside our memory account pool
  const healthyAccounts = accountPool.filter(acc => acc.ok);
  if (healthyAccounts.length === 0) {
    // If pool is empty but we have disabled accounts, try them. Else crash.
    if (accountPool.length > 0) {
      const selected = accountPool[Math.floor(Math.random() * accountPool.length)];
      selected.lastUsed = Date.now();
      return { ticket: selected.value, accountRef: selected };
    }
    throw new Error('No Qwen account tokens (tongyi_sso_ticket or login_aliyunid_ticket) configured in pool. Add accounts via the dashboard or provide one in your Authorization Bearer header.');
  }

  const selected = healthyAccounts[Math.floor(Math.random() * healthyAccounts.length)];
  selected.lastUsed = Date.now();
  return { ticket: selected.value, accountRef: selected };
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
      filename: attachment.filename || `file-${uuidv4()}.${fileExtensionFromMime(mimeType)}`,
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
      filename: attachment.filename || `file-${uuidv4()}.${fileExtensionFromMime(mimeType)}`,
      explicitType: attachment.explicitType,
    };
  }

  // Base64 fallback
  const bytes = Buffer.from(attachment.source, 'base64');
  const mimeType = attachment.mimeType || 'application/octet-stream';
  return {
    bytes,
    mimeType,
    filename: attachment.filename || `file-${uuidv4()}.${fileExtensionFromMime(mimeType)}`,
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
      'x-request-id': uuidv4(),
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
        'x-request-id': uuidv4(),
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
      'x-request-id': uuidv4(),
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
  return uuidv4();
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
    itemId: uuidv4(),
    greenNet: 'success',
    size: fileSize,
    file_type: file.mimeType,
    uploadTaskId: uuidv4(),
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

interface OpenAiMessage {
  role: string;
  content: string | any[];
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
}

const TOOL_CALL_START = '<|tool_calls_begin|>';
const TOOL_CALL_END = '<|tool_calls_end|>';

const TOOL_CALL_INSTRUCTION = `**Tool Call Format — Strictly Follow:**

Wrap a JSON array in tool call markers:

${TOOL_CALL_START}[{"name": "TOOL_NAME", "arguments": {"PARAM": "VALUE"}}]${TOOL_CALL_END}

**Rules:**
1. When you decide to call a tool, your response MUST contain ONLY the tool call block itself. No greetings, explanations, summaries, or Markdown code fences.
2. The JSON array must start with \`${TOOL_CALL_START}\` and end with \`${TOOL_CALL_END}\`.
3. All tool calls must be placed in ONE JSON array.
4. Stop immediately after \`${TOOL_CALL_END}\`.
5. String argument values must be properly escaped JSON strings.
6. Use ONLY exact tool names from the available tool list below.`;

function formatToolsPrompt(tools: any[]): string {
  const lines: string[] = [];
  const exactNames: string[] = [];
  for (const tool of tools) {
    if (tool.type !== 'function') continue;
    const fn = tool.function || {};
    const name = fn.name;
    exactNames.push(name);
    const desc = fn.description || '';
    const params = fn.parameters || {};
    const props = params.properties || {};
    const required = params.required || [];
    const paramParts: string[] = [];
    for (const [pname, pinfo] of Object.entries(props) as any[]) {
      const ptype = pinfo.type || 'string';
      const pdesc = pinfo.description || '';
      const req = required.includes(pname) ? ' (required)' : '';
      paramParts.push(`    - ${pname}: ${ptype}${req}${pdesc ? ' — ' + pdesc : ''}`);
    }
    lines.push(`- ${name}: ${desc}`);
    if (paramParts.length > 0) {
      lines.push(...paramParts);
    }
  }
  if (exactNames.length > 0) {
    return `Exact client capability names: ${exactNames.join(', ')}\n${lines.join('\n')}`;
  }
  return lines.join('\n');
}

function formatAssistantToolCalls(toolCalls: any[]): string {
  const lines = ['<tool_calls>'];
  for (const tc of toolCalls) {
    const fn = tc.function || {};
    const name = fn.name || '';
    let args = fn.arguments || {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        args = { arguments: args };
      }
    }
    if (typeof args !== 'object' || args === null) {
      args = { arguments: args };
    }
    lines.push(`  <invoke name="${name}">`);
    for (const [key, value] of Object.entries(args)) {
      const valStr = typeof value === 'string' ? value : JSON.stringify(value);
      const cdataVal = `<![CDATA[${valStr.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
      lines.push(`    <parameter name="${key}">${cdataVal}</parameter>`);
    }
    lines.push('  </invoke>');
  }
  lines.push('</tool_calls>');
  return lines.join('\n');
}

function getAttachmentsFromContent(content: string | any[]): Attachment[] {
  const attachments: Attachment[] = [];
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part) continue;
      if (part.type === 'image_url') {
        attachments.push({
          source: part.image_url.url,
          explicitType: 'image'
        });
      } else if (part.type === 'file') {
        attachments.push({
          source: part.file.file_data,
          filename: part.file.filename,
          explicitType: 'document'
        });
      }
    }
  }
  return attachments;
}

function flattenMessages(messages: OpenAiMessage[], tools?: any[]): { content: string; attachments: Attachment[] } {
  const parts: string[] = [];
  const toolNameById: Record<string, string> = {};

  if (tools && tools.length > 0) {
    const toolDesc = formatToolsPrompt(tools);
    parts.push(`[System]\n${TOOL_CALL_INSTRUCTION}\n\nAvailable tools:\n${toolDesc}`);
  }

  for (const msg of messages) {
    const role = msg.role || 'user';
    let content = '';

    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = msg.content
        .map(part => {
          if (!part) return '';
          if (part.type === 'text') return part.text || '';
          return '';
        })
        .join(' ');
    }

    if (role === 'system') {
      parts.push(`[System]\n${content}`);
    } else if (role === 'assistant') {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          const fn = tc.function || {};
          const callId = tc.id || '?';
          const toolName = fn.name || '?';
          toolNameById[callId] = toolName;
        }
        parts.push(`[Assistant]\nPrevious client capability request already sent:\n${formatAssistantToolCalls(msg.tool_calls)}`);
      } else if (content) {
        parts.push(`[Assistant]\n${content}`);
      }
    } else if (role === 'tool') {
      const toolCallId = msg.tool_call_id || '?';
      const toolName = toolNameById[toolCallId] || msg.name || 'unknown_tool';
      parts.push(`[Tool Result]\nTool name: ${toolName}\nCall ID: ${toolCallId}\nResult:\n${content}\nUse this result to continue. If another action is needed, request exactly one next client capability.`);
    } else {
      parts.push(`[User]\n${content}`);
    }
  }

  // Add a soft format reminder at the end for recency bias
  if (tools && tools.length > 0) {
    const toolNames = tools.map(t => t.function?.name).filter(Boolean);
    const namesStr = toolNames.join(', ');
    const lastMsg = messages[messages.length - 1];
    const lastRole = lastMsg ? lastMsg.role : 'user';

    let reminder = '';
    if (lastRole === 'tool') {
      reminder = `Your available client capabilities: ${namesStr}. You just received a tool result. Use it to answer normally unless another tool is strictly necessary. If another action is needed, emit exactly one XML <tool_calls> block. Never write 'Tool X does not exist' in the final answer.`;
    } else {
      reminder = `Your available client capabilities: ${namesStr}. If the next step requires an action, emit exactly one XML <tool_calls> block. If no action is needed, answer normally.`;
    }
    parts.push(`[System Reminder]\n${reminder}`);
  }

  // Extract attachments from the last user message
  let lastAttachments: Attachment[] = [];
  if (messages.length > 0) {
    const last = messages[messages.length - 1];
    lastAttachments = getAttachmentsFromContent(last.content);
  }

  return {
    content: parts.join('\n\n'),
    attachments: lastAttachments
  };
}

// Normalize confusable Unicode characters from Qwen
function normalizeMarkupChars(text: string): string {
  return text
    .replace(/｜/g, '|')
    .replace(/＜/g, '<')
    .replace(/＞/g, '>');
}

interface ParsedToolResult {
  toolCalls: any[];
  cleanText: string;
}

// Parse XML/DSML/JSON tool calls from Qwen text stream (ds-free-api parity)
function parseToolCalls(text: string): ParsedToolResult | null {
  if (!text) return null;
  const normalized = normalizeMarkupChars(text);

  // Look for any start marker
  const startMatch = normalized.match(/(?:<\|tool_calls_begin\|>|<tool_calls>|<invoke\s+name=)/i);
  if (!startMatch || startMatch.index === undefined) {
    return null;
  }

  const startPos = startMatch.index;

  // Look for end marker starting after startPos
  let endPos = normalized.length;
  const searchSub = normalized.substring(startPos);

  const endMatch = searchSub.match(/(?:<\|tool_calls_end\|>|<\/tool_calls>|<\/invoke>)/i);
  if (endMatch && endMatch.index !== undefined) {
    endPos = startPos + endMatch.index + endMatch[0].length;
  }

  const blockText = normalized.substring(startPos, endPos);
  const prefixText = normalized.substring(0, startPos);
  const suffixText = normalized.substring(endPos);
  
  const rawClean = (prefixText + suffixText)
    .replace(/^Tool\s+[a-zA-Z0-9_-]+\s+does\s+not\s+exist\.?/gmi, '')
    .replace(/<\|tool_calls_begin\|>|<\|tool_calls_end\|>|<tool_calls>|<\/tool_calls>/gi, '')
    .trim();

  const calls: any[] = [];

  // Strategy 1: JSON array inside blockText or normalized
  const jsonArrMatch = blockText.match(/\[\s*\{[\s\S]*?\}\s*\]/);
  if (jsonArrMatch) {
    try {
      const arr = JSON.parse(jsonArrMatch[0]);
      if (Array.isArray(arr) && arr.length > 0) {
        for (const item of arr) {
          if (item && item.name) {
            calls.push({
              id: `call_${uuidv4().replace(/-/g, '').substring(0, 12)}`,
              type: 'function',
              function: {
                name: item.name,
                arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {})
              }
            });
          }
        }
      }
    } catch {}
  }

  if (calls.length > 0) {
    return { toolCalls: calls, cleanText: rawClean };
  }

  // Strategy 2: XML <invoke name="...">...</invoke> tags
  const invokeRegex = /<invoke\s+name="([^"]+)"\b[^>]*>([\s\S]*?)(?:<\/invoke>|$)/gi;
  let m;

  while ((m = invokeRegex.exec(blockText)) !== null) {
    const name = m[1].trim();
    const inner = m[2];
    const args: Record<string, any> = {};

    const paramRegex = /<parameter\s+name="([^"]+)"\b[^>]*>([\s\S]*?)(?:<\/parameter>|$)/gi;
    let pm;
    while ((pm = paramRegex.exec(inner)) !== null) {
      const pname = pm[1].trim();
      let pval = pm[2].trim();
      const cdataMatch = pval.match(/<!\[CDATA\[([\s\S]*?)]]>/i);
      if (cdataMatch) pval = cdataMatch[1];
      args[pname] = pval;
    }

    const directRegex = /<([a-zA-Z0-9_-]+)\b[^>]*>([\s\S]*?)<\/\1>/gi;
    let dm;
    while ((dm = directRegex.exec(inner)) !== null) {
      const tag = dm[1].toLowerCase();
      if (tag === 'parameter' || tag === 'invoke') continue;
      let val = dm[2].trim();
      const cdataMatch = val.match(/<!\[CDATA\[([\s\S]*?)]]>/i);
      if (cdataMatch) val = cdataMatch[1];
      args[dm[1]] = val;
    }

    calls.push({
      id: `call_${uuidv4().replace(/-/g, '').substring(0, 12)}`,
      type: 'function',
      function: {
        name,
        arguments: JSON.stringify(args)
      }
    });
  }

  if (calls.length > 0) {
    return { toolCalls: calls, cleanText: rawClean };
  }

  // Strategy 3: Single JSON object
  const singleJsonMatch = blockText.match(/\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"arguments"\s*:[\s\S]*?\}/);
  if (singleJsonMatch) {
    try {
      const obj = JSON.parse(singleJsonMatch[0]);
      if (obj && obj.name) {
        calls.push({
          id: `call_${uuidv4().replace(/-/g, '').substring(0, 12)}`,
          type: 'function',
          function: {
            name: obj.name,
            arguments: typeof obj.arguments === 'string' ? obj.arguments : JSON.stringify(obj.arguments || {})
          }
        });
        return { toolCalls: calls, cleanText: rawClean };
      }
    } catch {}
  }

  return null;
}

function stripToolCallsMarkup(text: string): string {
  if (!text) return '';
  return text
    .replace(/<tool_calls\b[^>]*>[\s\S]*?(<\/tool_calls>|$)/gi, '')
    .replace(/<invoke\s+name="[^"]+"[\s\S]*?(<\/invoke>|$)/gi, '')
    .replace(/<\|tool_calls_begin\|>[\s\S]*?(<\|tool_calls_end\|>|$)/gi, '')
    .replace(/^Tool\s+[a-zA-Z0-9_-]+\s+does\s+not\s+exist\.?/gmi, '')
    .trim();
}

function getPrefixText(text: string): string {
  if (!text) return '';
  const match = text.match(/(?:<tool_calls\b|<invoke\s+name=|<\|tool_calls_begin\|>)/i);
  if (match && match.index !== undefined) {
    return text.substring(0, match.index).trim();
  }
  return text;
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
  res.send('Qwen-Free-API is up and running. Use POST /v1/chat/completions to call Qwen models, or visit /admin in browser.');
});

// Fetch metrics & stats
app.get('/admin/api/stats', (req: Request, res: Response) => {
  const totalMem = Math.round(process.memoryUsage().rss / 1024 / 1024);
  res.json({
    stats: {
      totalRequests,
      successRequests,
      failedRequests,
      avgLatency,
    },
    accounts: accountPool,
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

// Dynamic Account Insertion
app.post('/admin/api/accounts', (req: Request, res: Response) => {
  try {
    const { tokens } = req.body;
    if (!tokens) {
      return res.status(400).json({ success: false, error: 'tokens are required' });
    }
    const list = String(tokens).split(',').map(s => s.trim()).filter(Boolean);
    list.forEach(t => {
      accountPool.push({ value: t, ok: true });
    });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Remove Account
app.delete('/admin/api/accounts', (req: Request, res: Response) => {
  try {
    const index = Number(req.query.index);
    if (Number.isNaN(index) || index < 0 || index >= accountPool.length) {
      return res.status(400).json({ success: false, error: 'Invalid account index' });
    }
    accountPool.splice(index, 1);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Clear Request Logs
app.delete('/admin/api/logs', (req: Request, res: Response) => {
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
app.get('/v1/models', (req: Request, res: Response) => {
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

  const models: any[] = [];
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
        'x-request-id': uuidv4(),
      }
    });

    if (!createResp.data?.success || !createResp.data?.data?.id) {
      if (accountRef) accountRef.ok = false;
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
        fid: uuidv4(),
        parentId: null,
        childrenIds: [uuidv4()],
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
        'x-request-id': uuidv4(),
      }
    });

    const rawText = imageResp.data;
    const urls = extractImageUrlsFromUpstreamSse(rawText);

    if (urls.length === 0) {
      const errorMsg = extractUpstreamErrorFromSse(rawText);
      return res.status(502).json({ error: { message: errorMsg?.message || 'Upstream returned no image URLs', type: 'api_error' } });
    }

    const created = Math.floor(Date.now() / 1000);
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
    if (accountRef) accountRef.ok = false;
    console.error(`[Qwen API] Upstream error:`, err.response?.data ? JSON.stringify(err.response.data) : err.message);
    res.status(500).json({ error: { message: err.message, type: 'api_error' } });
  }
});

// Chat Completions endpoint
app.post('/v1/chat/completions', async (req: Request, res: Response) => {
  let accountRef: Account | undefined;
  try {
    const authHeader = req.headers.authorization;
    const selection = selectAccountTicket(authHeader);
    const ticket = selection.ticket;
    accountRef = selection.accountRef;
    
    const { model, messages, stream = false } = req.body;
    if (!messages || messages.length === 0) {
       return res.status(400).json({ error: { message: 'messages list is required', type: 'invalid_request_error' } });
    }

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
        'x-request-id': uuidv4(),
      }
    });

    if (!createResp.data?.success || !createResp.data?.data?.id) {
      if (accountRef) accountRef.ok = false;
      console.error(`[Qwen API] Create chat failed. Upstream response:`, JSON.stringify(createResp.data));
      return res.status(500).json({ error: { message: createResp.data?.data?.message || 'Failed to create chat session', type: 'api_error' } });
    }
    const chatId = createResp.data.data.id;

    const tools = req.body.tools;
    const parsed = flattenMessages(messages, tools);
    const uploadedFiles = parsed.attachments.length > 0 
      ? await uploadAttachments(parsed.attachments, ticket, baxia)
      : [];

    const qwenResp = await axios.post(`${QWEN_BASE_URL}/api/v2/chat/completions?chat_id=${chatId}`, {
      stream: true,
      version: '2.1',
      incremental_output: true,
      chat_id: chatId,
      chat_mode: 'normal',
      model: actualModel,
      parent_id: null,
      messages: [{
        fid: uuidv4(),
        parentId: null,
        childrenIds: [uuidv4()],
        role: 'user',
        content: parsed.content,
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
        'x-request-id': uuidv4(),
      },
      responseType: 'text',
    });

    const responseId = `chatcmpl-${uuidv4()}`;
    const createdTime = Math.floor(Date.now() / 1000);
    const sseParsed = parseQwenSsePayload(qwenResp.data);

    const toolResult = parseToolCalls(sseParsed.content);
    const parsedToolCalls = toolResult?.toolCalls || null;
    const cleanContent = toolResult ? toolResult.cleanText : stripToolCallsMarkup(sseParsed.content);

    if (!stream) {
      const prompt_tokens = Math.ceil(parsed.content.length / 4);
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
          delta: { tool_calls: parsedToolCalls },
          finish_reason: 'tool_calls',
        }],
      })}\n\n`);

      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    for (const event of sseParsed.events) {
      if (event.delta && typeof event.delta.content === 'string') {
        event.delta.content = stripToolCallsMarkup(event.delta.content);
        if (!event.delta.content && !event.delta.reasoning_content) {
          continue;
        }
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
    if (accountRef) accountRef.ok = false;
    console.error(`[Qwen API] Upstream error:`, err.response?.data ? JSON.stringify(err.response.data) : err.message);
    res.status(500).json({ error: { message: err.message, type: 'api_error' } });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  try {
    console.log('cwd:', process.cwd());
    console.log('cwd contents:', fs.readdirSync(process.cwd()));
    console.log('__dirname:', __dirname);
    console.log('__dirname contents:', fs.readdirSync(__dirname));
    const targetPath = path.join(process.cwd(), 'public/admin.html');
    console.log(`targetPath (${targetPath}) exists:`, fs.existsSync(targetPath));
  } catch (err: any) {
    console.log('Debug logging failed:', err.message);
  }
});