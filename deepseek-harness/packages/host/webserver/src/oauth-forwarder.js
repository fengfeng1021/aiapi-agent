/**
 * Generic OAuth token exchange proxy for DeepSeek Harness WebServer.
 *
 * Facilitates CORS-free server-side token exchanges for OpenAI, Anthropic,
 * Google Antigravity, and xAI Grok browser authorization flows.
 *
 * @module dsh-host-webserver/oauth-forwarder
 */
async function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let raw = '';
        req.on('data', chunk => {
            raw += chunk;
        });
        req.on('end', () => {
            try {
                resolve(raw ? JSON.parse(raw) : {});
            }
            catch (err) {
                reject(err);
            }
        });
        req.on('error', reject);
    });
}
export async function handleOAuthRequest(req, res) {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }
    const url = req.url ?? '';
    if (req.method === 'POST' && (url === '/api/oauth/exchange' || url.startsWith('/api/oauth/exchange'))) {
        try {
            const body = await readJsonBody(req);
            if (!body.tokenUrl) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing tokenUrl parameter' }));
                return;
            }
            const postHeaders = {
                ...(body.headers ?? {}),
            };
            let reqBody = undefined;
            if (body.jsonBody !== undefined) {
                postHeaders['Content-Type'] = 'application/json';
                reqBody = JSON.stringify(body.jsonBody);
            }
            else if (body.params) {
                postHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
                reqBody = new URLSearchParams(body.params).toString();
            }
            const upstreamResp = await fetch(body.tokenUrl, {
                method: 'POST',
                headers: postHeaders,
                ...(reqBody !== undefined ? { body: reqBody } : {}),
            });
            const text = await upstreamResp.text();
            res.writeHead(upstreamResp.status, {
                'Content-Type': upstreamResp.headers.get('content-type') || 'application/json',
            });
            res.end(text);
        }
        catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: `OAuth exchange error: ${err instanceof Error ? err.message : String(err)}`,
            }));
        }
        return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'OAuth route not found' }));
}
//# sourceMappingURL=oauth-forwarder.js.map