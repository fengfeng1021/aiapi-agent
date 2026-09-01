//! Google OAuth for Gemini / Antigravity
//! Mirrors Hermes `agent/google_oauth.py` + `skills/productivity/google-workspace`
//! Provides `codex login --provider gemini` / `aiapi login --provider gemini-oauth`
//!
//! Flow: PKCE -> https://accounts.google.com/o/oauth2/v2/auth -> localhost callback -> https://oauth2.googleapis.com/token
//! Token stored in `~/.codex/auth.json` under `providers.gemini-oauth`

use serde::{Deserialize, Serialize};

pub const GOOGLE_OAUTH_CLIENT_ID_ENV: &str = "GOOGLE_OAUTH_CLIENT_ID";
pub const GOOGLE_OAUTH_CLIENT_SECRET_ENV: &str = "GOOGLE_OAUTH_CLIENT_SECRET";
pub const GEMINI_API_KEY_ENV: &str = "GEMINI_API_KEY";
pub const GOOGLE_API_KEY_ENV: &str = "GOOGLE_API_KEY";

/// Default OAuth client for Gemini - user should configure via Google Cloud Console
/// For Antigravity, reuse the same credentials but point base_url to Antigravity proxy
pub const GOOGLE_OAUTH_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
pub const GOOGLE_OAUTH_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
pub const GOOGLE_OAUTH_SCOPE_GEMINI: &str = "https://www.googleapis.com/auth/generative-language";
pub const GOOGLE_OAUTH_SCOPE_ANTIGRAVITY: &str = "https://www.googleapis.com/auth/cloud-platform";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoogleOAuthTokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: Option<u64>,
    pub token_type: Option<String>,
    pub scope: Option<String>,
}

/// Build authorization URL for Gemini OAuth
pub fn build_auth_url(client_id: &str, redirect_uri: &str, state: &str, code_challenge: &str, scope: &str) -> String {
    // Minimal URL-encoding for MVP - production should use `urlencoding` or `percent-encoding` crate
    format!(
        "{}?client_id={}&redirect_uri={}&response_type=code&scope={}&state={}&code_challenge={}&code_challenge_method=S256&access_type=offline&prompt=consent",
        GOOGLE_OAUTH_AUTH_URL,
        client_id,
        redirect_uri,
        scope,
        state,
        code_challenge
    )
}

/// Human instructions for `aiapi login --provider gemini`
pub fn login_instructions() -> &'static str {
    "Gemini login: 1) Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET from https://console.cloud.google.com/apis/credentials\n\
     2) Run `aiapi login --provider gemini-oauth`\n\
     3) Browser will open to Google OAuth consent screen\n\
     4) After consent, token is stored in ~/.codex/auth.json\n\
     Alternative (API Key): Set GEMINI_API_KEY or GOOGLE_API_KEY and use model_provider = \"gemini\" directly without OAuth."
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn auth_url_contains_pkce() {
        let url = build_auth_url("cid", "http://localhost:8080/callback", "state123", "challengeABC", GOOGLE_OAUTH_SCOPE_GEMINI);
        assert!(url.contains("code_challenge=challengeABC"));
        assert!(url.contains("client_id=cid"));
    }
}
