/**
 * Generic OAuth token exchange proxy for DeepSeek Harness WebServer.
 *
 * Facilitates CORS-free server-side token exchanges for OpenAI, Anthropic,
 * Google Antigravity, and xAI Grok browser authorization flows.
 *
 * @module dsh-host-webserver/oauth-forwarder
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
export declare function handleOAuthRequest(req: IncomingMessage, res: ServerResponse): Promise<void>;
//# sourceMappingURL=oauth-forwarder.d.ts.map