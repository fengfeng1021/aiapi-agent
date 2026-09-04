/**
 * Native Google Antigravity protocol forward adapter for DeepSeek Harness.
 *
 * Implements a local Gemini v1beta-compatible HTTP server endpoint at
 * `/api/antigravity/v1beta` that:
 * 1. Accepts standard Google GenAI requests from @google/genai / pi-ai.
 * 2. Translates standard model IDs to internal Antigravity model IDs.
 * 3. Injects user Antigravity OAuth tokens and project ('aicode-consumers').
 * 4. Forwards to Google internal CloudCode endpoint (daily-cloudcode-pa / cloudcode-pa).
 * 5. Unwraps and streams SSE chunks back to the client as standard GenAI chunks.
 *
 * @module dsh-host-webserver/antigravity-forwarder
 */
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const ANTIGRAVITY_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const ANTIGRAVITY_CLIENT_SECRET = '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';
const UPSTREAM_HOSTS = [
    'https://daily-cloudcode-pa.googleapis.com',
    'https://cloudcode-pa.googleapis.com',
];
export const ANTIGRAVITY_MODEL_MAP = {
    'gemini-3.7-flash': 'gemini-3.7-flash-tiered',
    'gemini-3.7-flash-thinking': 'gemini-3.7-flash-tiered',
    'gemini-3.7-flash-tiered': 'gemini-3.7-flash-tiered',
    'gemini-3.6-flash': 'gemini-3.6-flash-high',
    'gemini-3.6-flash-high': 'gemini-3.6-flash-high',
    'gemini-3.6-flash-medium': 'gemini-3.6-flash-medium',
    'gemini-3.6-flash-low': 'gemini-3.6-flash-low',
    'gemini-2.5-flash': 'gemini-3.6-flash-high',
    'gemini-2.0-flash': 'gemini-3.6-flash-high',
    'gemini-2.5-pro': 'gemini-pro-agent',
    'gemini-3-pro-preview': 'gemini-pro-agent',
    'gemini-pro': 'gemini-pro-agent',
    'gemini-pro-agent': 'gemini-pro-agent',
    'gemini-3.1-pro-low': 'gemini-3.1-pro-low',
    'claude-3-7-sonnet': 'claude-sonnet-4-6',
    'claude-3.7-sonnet': 'claude-sonnet-4-6',
    'claude-sonnet-4-6': 'claude-sonnet-4-6',
    'claude-opus-4-6-thinking': 'claude-opus-4-6-thinking',
    'gpt-oss-120b-medium': 'gpt-oss-120b-medium',
};
export function mapToAntigravityModel(modelId) {
    const clean = modelId.replace(/^models\//, '');
    return ANTIGRAVITY_MODEL_MAP[clean] ?? clean;
}
export const ANTIGRAVITY_AVAILABLE_MODELS = [
    {
        name: 'models/gemini-3.7-flash',
        displayName: 'Gemini 3.7 Flash (Antigravity)',
        supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
    },
    {
        name: 'models/gemini-3.6-flash',
        displayName: 'Gemini 3.6 Flash (Antigravity)',
        supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
    },
    {
        name: 'models/gemini-3.6-flash-high',
        displayName: 'Gemini 3.6 Flash High (Antigravity)',
        supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
    },
    {
        name: 'models/gemini-pro-agent',
        displayName: 'Gemini Pro Agent (Antigravity)',
        supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
    },
    {
        name: 'models/gemini-2.5-pro',
        displayName: 'Gemini 2.5 Pro (Antigravity)',
        supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
    },
    {
        name: 'models/gemini-2.5-flash',
        displayName: 'Gemini 2.5 Flash (Antigravity)',
        supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
    },
    {
        name: 'models/claude-sonnet-4-6',
        displayName: 'Claude 3.7 Sonnet (Antigravity)',
        supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
    },
];
let tokenCache = null;
function getCredentialsFilePath() {
    const home = process.env.DSH_HOME || (process.platform === 'win32'
        ? `${process.env.USERPROFILE || 'C:\\Users\\Administrator'}\\.dsh`
        : `${process.env.HOME || '~'}/.dsh`);
    return `${home}/.credentials.yaml`;
}
async function readTokensFromDisk() {
    try {
        const filePath = getCredentialsFilePath();
        const content = await readFile(filePath, 'utf8');
        const rtMatch = content.match(/ANTIGRAVITY_REFRESH_TOKEN:\s*([^\r\n]+)/);
        const keyMatch = content.match(/GOOGLE_API_KEY:\s*([^\r\n]+)/);
        const geminiKeyMatch = content.match(/GEMINI_API_KEY:\s*([^\r\n]+)/);
        const rt = rtMatch?.[1]?.trim();
        const key = keyMatch?.[1]?.trim() || geminiKeyMatch?.[1]?.trim();
        return {
            ...(rt ? { refreshToken: rt } : {}),
            ...(key?.startsWith('ya29.') ? { accessToken: key } : {}),
        };
    }
    catch {
        return {};
    }
}
async function refreshAccessToken(refreshToken) {
    try {
        const resp = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: ANTIGRAVITY_CLIENT_ID,
                client_secret: ANTIGRAVITY_CLIENT_SECRET,
                refresh_token: refreshToken,
                grant_type: 'refresh_token',
            }),
        });
        if (!resp.ok)
            return undefined;
        const data = (await resp.json());
        if (data.access_token) {
            const ttl = (data.expires_in ?? 3600) * 1000;
            tokenCache = {
                accessToken: data.access_token,
                expiresAt: Date.now() + ttl - 60000,
            };
            return data.access_token;
        }
    }
    catch {
        // ignore
    }
    return undefined;
}
export async function resolveAntigravityAccessToken(reqToken) {
    if (reqToken && reqToken.startsWith('ya29.')) {
        return reqToken;
    }
    if (tokenCache && tokenCache.expiresAt > Date.now()) {
        return tokenCache.accessToken;
    }
    const fromDisk = await readTokensFromDisk();
    if (fromDisk.refreshToken) {
        const refreshed = await refreshAccessToken(fromDisk.refreshToken);
        if (refreshed)
            return refreshed;
    }
    if (fromDisk.accessToken) {
        return fromDisk.accessToken;
    }
    if (reqToken) {
        return reqToken;
    }
    throw new Error('未找到有效的 Antigravity 訪問令牌，請先在設定中完成 Google 授權');
}
async function readJsonBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const bodyText = Buffer.concat(chunks).toString('utf8');
    if (!bodyText.trim())
        return {};
    return JSON.parse(bodyText);
}
/**
 * Handles all requests under `/api/antigravity` prefix.
 */
export async function handleAntigravityRequest(req, res) {
    const parsedUrl = new URL(req.url ?? '/', 'http://localhost');
    const pathname = parsedUrl.pathname;
    const searchParams = parsedUrl.searchParams;
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-goog-api-key');
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }
    // 1. Models listing: GET /api/antigravity/v1beta/models
    if (req.method === 'GET' && (pathname.endsWith('/models') || pathname.endsWith('/models/'))) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: ANTIGRAVITY_AVAILABLE_MODELS }));
        return;
    }
    // Extract model ID from URL: e.g. /models/gemini-2.5-flash:streamGenerateContent
    const streamMatch = pathname.match(/\/models\/([^/:]+):streamGenerateContent/);
    const normalMatch = pathname.match(/\/models\/([^/:]+):generateContent/);
    if (req.method === 'POST' && (streamMatch || normalMatch)) {
        const rawModel = (streamMatch ? streamMatch[1] : normalMatch?.[1]) ?? 'gemini-3.6-flash-high';
        const targetModel = mapToAntigravityModel(rawModel);
        const isStream = Boolean(streamMatch) || searchParams.get('alt') === 'sse';
        // Extract authorization token from header or query param
        const authHeader = req.headers['authorization'] || '';
        const keyHeader = req.headers['x-goog-api-key'] || searchParams.get('key') || undefined;
        let bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : undefined;
        if (!bearerToken && keyHeader?.startsWith('ya29.')) {
            bearerToken = keyHeader;
        }
        let accessToken;
        try {
            accessToken = await resolveAntigravityAccessToken(bearerToken);
        }
        catch (err) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    code: 401,
                    message: err instanceof Error ? err.message : String(err),
                    status: 'UNAUTHENTICATED',
                },
            }));
            return;
        }
        let requestBody;
        try {
            requestBody = await readJsonBody(req);
        }
        catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    code: 400,
                    message: `無法解析 JSON 請求體: ${err instanceof Error ? err.message : String(err)}`,
                    status: 'INVALID_ARGUMENT',
                },
            }));
            return;
        }
        // Sanitize requestBody for Antigravity compatibility:
        // Antigravity rejects thinkingLevel: "MINIMAL" with "Thinking level MINIMAL is not supported for this model".
        // Map "MINIMAL" to "LOW" which is fully supported.
        if (requestBody && typeof requestBody === 'object') {
            const genConfig = requestBody.generationConfig;
            if (genConfig && typeof genConfig === 'object') {
                const thinking = genConfig.thinkingConfig;
                if (thinking && typeof thinking === 'object') {
                    const tLevel = thinking.thinkingLevel;
                    if (typeof tLevel === 'string' && tLevel.toUpperCase() === 'MINIMAL') {
                        thinking.thinkingLevel = 'LOW';
                    }
                }
            }
        }
        const antigravityPayload = {
            project: 'aicode-consumers',
            requestId: `agent-${randomUUID()}`,
            userAgent: 'antigravity',
            model: targetModel,
            request: requestBody,
        };
        const action = isStream ? 'streamGenerateContent' : 'generateContent';
        // Try upstream hosts with automatic token refresh and transparent error handling
        let upstreamRes = undefined;
        let lastErrorText = undefined;
        for (const host of UPSTREAM_HOSTS) {
            const url = `${host}/v1internal:${action}${isStream ? '?alt=sse' : ''}`;
            try {
                const resp = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${accessToken}`,
                        'User-Agent': 'antigravity',
                    },
                    body: JSON.stringify(antigravityPayload),
                });
                // If 401 Unauthorized, token may be expired; try one refresh
                if (resp.status === 401) {
                    const fromDisk = await readTokensFromDisk();
                    if (fromDisk.refreshToken) {
                        const fresh = await refreshAccessToken(fromDisk.refreshToken);
                        if (fresh) {
                            accessToken = fresh;
                            const retryResp = await fetch(url, {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'Authorization': `Bearer ${accessToken}`,
                                    'User-Agent': 'antigravity',
                                },
                                body: JSON.stringify(antigravityPayload),
                            });
                            if (retryResp.ok) {
                                upstreamRes = retryResp;
                                break;
                            }
                        }
                    }
                }
                if (resp.ok) {
                    upstreamRes = resp;
                    break;
                }
                else {
                    lastErrorText = await resp.text();
                    upstreamRes = resp;
                    break;
                }
            }
            catch (err) {
                lastErrorText = err instanceof Error ? err.message : String(err);
            }
        }
        if (!upstreamRes) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    code: 502,
                    message: `連線 Google Antigravity 內部伺服器失敗: ${lastErrorText || '無伺服器回應'}`,
                    status: 'BAD_GATEWAY',
                },
            }));
            return;
        }
        if (!upstreamRes.ok) {
            res.writeHead(upstreamRes.status, { 'Content-Type': 'application/json' });
            res.end(lastErrorText || JSON.stringify({
                error: {
                    code: upstreamRes.status,
                    message: `Google Antigravity 伺服器錯誤 (${upstreamRes.status})`,
                    status: upstreamRes.statusText,
                },
            }));
            return;
        }
        // Handle Streaming Response
        if (isStream && upstreamRes.body) {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
            });
            const decoder = new TextDecoder();
            let buffer = '';
            try {
                for await (const chunk of upstreamRes.body) {
                    buffer += decoder.decode(chunk, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() ?? '';
                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (trimmed.startsWith('data:')) {
                            const payloadStr = trimmed.slice(5).trim();
                            if (!payloadStr || payloadStr === '[DONE]') {
                                res.write('data: [DONE]\n\n');
                                continue;
                            }
                            try {
                                const parsed = JSON.parse(payloadStr);
                                // Antigravity wraps result in `response`, unwrap it for standard GenAI compatibility!
                                if (parsed.response) {
                                    res.write(`data: ${JSON.stringify(parsed.response)}\n\n`);
                                }
                                else {
                                    res.write(`${line}\n`);
                                }
                            }
                            catch {
                                res.write(`${line}\n`);
                            }
                        }
                        else {
                            res.write(`${line}\n`);
                        }
                    }
                }
            }
            finally {
                res.end();
            }
            return;
        }
        // Non-streaming response
        const json = (await upstreamRes.json());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(json.response ?? json));
        return;
    }
    // Fallback for unhandled paths under /api/antigravity
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 404, message: `未找到路徑: ${pathname}`, status: 'NOT_FOUND' } }));
}
//# sourceMappingURL=antigravity-forwarder.js.map