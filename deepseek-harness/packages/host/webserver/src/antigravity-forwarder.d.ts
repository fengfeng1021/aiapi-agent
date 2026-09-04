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
import type { IncomingMessage, ServerResponse } from 'node:http';
export declare const ANTIGRAVITY_MODEL_MAP: Record<string, string>;
export declare function mapToAntigravityModel(modelId: string): string;
export declare const ANTIGRAVITY_AVAILABLE_MODELS: {
    name: string;
    displayName: string;
    supportedGenerationMethods: string[];
}[];
export declare function resolveAntigravityAccessToken(reqToken?: string): Promise<string>;
/**
 * Handles all requests under `/api/antigravity` prefix.
 */
export declare function handleAntigravityRequest(req: IncomingMessage, res: ServerResponse): Promise<void>;
//# sourceMappingURL=antigravity-forwarder.d.ts.map