//! Google OAuth for Gemini / Antigravity.
//!
//! Mirrors Hermes `agent/google_oauth.py`: Desktop-app OAuth client with PKCE,
//! a localhost callback server, code-for-token exchange, refresh, and storage
//! in `~/.codex/auth.json` under `providers.<id>`.
//!
//! Flow (`run_google_oauth_login`):
//! 1. Build `auth_url` (PKCE S256 + state) and open the browser.
//! 2. Serve `http://localhost:<port>/callback` and capture `code` + `state`.
//! 3. Exchange the code for `access_token` / `refresh_token`.
//! 4. Caller persists via [`save_provider_tokens`]; refresh via
//!    [`refresh_provider_tokens`].

use std::collections::HashMap;
use std::io;
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::auth::default_client::create_client_without_request_logging;
use crate::auth::load_auth_dot_json;
use crate::auth::save_auth;
use crate::pkce::generate_pkce;
use codex_config::types::AuthCredentialsStoreMode;

pub const GOOGLE_OAUTH_CLIENT_ID_ENV: &str = "GOOGLE_OAUTH_CLIENT_ID";
pub const GOOGLE_OAUTH_CLIENT_SECRET_ENV: &str = "GOOGLE_OAUTH_CLIENT_SECRET";
pub const GEMINI_API_KEY_ENV: &str = "GEMINI_API_KEY";
pub const GOOGLE_API_KEY_ENV: &str = "GOOGLE_API_KEY";

/// Provider id used in `auth.json` + `model_provider` config.
pub const GEMINI_OAUTH_PROVIDER_ID: &str = "gemini-oauth";

pub const GOOGLE_OAUTH_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
pub const GOOGLE_OAUTH_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
pub const GOOGLE_OAUTH_SCOPE_GEMINI: &str = "https://www.googleapis.com/auth/generative-language";
pub const GOOGLE_OAUTH_SCOPE_ANTIGRAVITY: &str = "https://www.googleapis.com/auth/cloud-platform";

/// Stored credential for one OAuth provider inside `auth.json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GoogleOAuthTokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: Option<u64>,
    pub token_type: Option<String>,
    pub scope: Option<String>,
}

/// Runtime config for one Google OAuth login attempt.
#[derive(Debug, Clone)]
pub struct GoogleOAuthConfig {
    pub provider_id: String,
    pub client_id: String,
    pub client_secret: String,
    pub scope: String,
    pub port: u16,
}

impl GoogleOAuthConfig {
    /// Build from env (`GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`).
    pub fn from_env(provider_id: &str) -> io::Result<Self> {
        let client_id = std::env::var(GOOGLE_OAUTH_CLIENT_ID_ENV).map_err(|_| {
            io::Error::other(format!(
                "Set {GOOGLE_OAUTH_CLIENT_ID_ENV} from https://console.cloud.google.com/apis/credentials (Desktop App client)"
            ))
        })?;
        let client_secret = std::env::var(GOOGLE_OAUTH_CLIENT_SECRET_ENV).map_err(|_| {
            io::Error::other(format!(
                "Set {GOOGLE_OAUTH_CLIENT_SECRET_ENV} from the same Desktop App client"
            ))
        })?;
        Ok(Self {
            provider_id: provider_id.to_string(),
            client_id,
            client_secret,
            scope: format!("{GOOGLE_OAUTH_SCOPE_GEMINI} {GOOGLE_OAUTH_SCOPE_ANTIGRAVITY}"),
            port: 0,
        })
    }
}

/// Build the Google consent URL (all values percent-encoded).
pub fn build_auth_url(
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    code_challenge: &str,
    scope: &str,
) -> String {
    format!(
        "{}?client_id={}&redirect_uri={}&response_type=code&scope={}&state={}&code_challenge={}&code_challenge_method=S256&access_type=offline&prompt=consent",
        GOOGLE_OAUTH_AUTH_URL,
        urlencoding::encode(client_id),
        urlencoding::encode(redirect_uri),
        urlencoding::encode(scope),
        urlencoding::encode(state),
        urlencoding::encode(code_challenge),
    )
}

/// Human instructions for `aiapi login --provider gemini`.
pub fn login_instructions() -> &'static str {
    "Gemini login: 1) Create a Desktop App OAuth client at https://console.cloud.google.com/apis/credentials\n\
     2) Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET\n\
     3) Run `aiapi login --provider gemini`\n\
     4) Approve in the browser; the token is stored in ~/.codex/auth.json\n\
     Alternative (API Key): set GEMINI_API_KEY and use model_provider = \"gemini\" without OAuth."
}

/// Bind the localhost callback server, returning it with its actual port.
///
/// Binding first (before the browser opens) closes the TOCTOU window where a
/// probe-then-rebind sequence could let another local process steal the port.
/// `port == 0` picks any free port.
pub fn bind_callback_server(port: u16) -> io::Result<(tiny_http::Server, u16)> {
    let server = tiny_http::Server::http(format!("127.0.0.1:{port}")).map_err(|e| {
        io::Error::other(format!("Cannot bind localhost callback port {port}: {e}"))
    })?;
    let actual = server
        .server_addr()
        .to_ip()
        .ok_or_else(|| io::Error::other("Cannot read callback port: not an IP socket"))?
        .port();
    Ok((server, actual))
}

/// Serve one OAuth redirect on an already-bound callback server.
///
/// Returns the authorization `code` after validating `state`. Times out after
/// `timeout` so headless runs fail loud instead of hanging. Malformed probes
/// get a 400 and the wait continues instead of aborting the login.
pub fn wait_for_callback_code_on(
    server: &tiny_http::Server,
    expected_state: &str,
    timeout: Duration,
) -> io::Result<String> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return Err(io::Error::other(
                "Timed out waiting for Google OAuth callback",
            ));
        }
        let Some(request) = server.recv_timeout(remaining)? else {
            return Err(io::Error::other(
                "Timed out waiting for Google OAuth callback",
            ));
        };
        let url = format!("http://localhost{}", request.url());
        let Ok(parsed) = url::Url::parse(&url) else {
            let _ = request.respond(
                tiny_http::Response::from_string("Bad request.").with_status_code(400),
            );
            continue;
        };
        if parsed.path() != "/callback" {
            let _ = request
                .respond(tiny_http::Response::from_string("Not found").with_status_code(404));
            continue;
        }
        let query: HashMap<String, String> = parsed.query_pairs().into_owned().collect();
        if let Some(error) = query.get("error") {
            let _ = request.respond(
                tiny_http::Response::from_string(format!(
                    "Login failed: {error}. You can close this tab."
                ))
                .with_status_code(400),
            );
            return Err(io::Error::other(format!(
                "Google OAuth denied access: {error}"
            )));
        }
        match (query.get("code"), query.get("state")) {
            (Some(code), Some(state)) if state == expected_state => {
                let _ = request.respond(tiny_http::Response::from_string(
                    "Aiapi Agent is now connected to Google. You can close this tab and return to the terminal.",
                ));
                return Ok(code.clone());
            }
            _ => {
                let _ = request.respond(
                    tiny_http::Response::from_string(
                        "Missing or mismatched login state; retry `aiapi login`.",
                    )
                    .with_status_code(400),
                );
            }
        }
    }
}

/// Wait for the OAuth redirect on `http://127.0.0.1:<port>/callback`.
///
/// Binds, then serves via [`wait_for_callback_code_on`]. Prefer binding with
/// [`bind_callback_server`] before opening the browser when the port must be
/// known up front.
pub fn wait_for_callback_code(
    port: u16,
    expected_state: &str,
    timeout: Duration,
) -> io::Result<String> {
    let (server, _) = bind_callback_server(port)?;
    wait_for_callback_code_on(&server, expected_state, timeout)
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
    token_type: Option<String>,
    scope: Option<String>,
    #[allow(dead_code)]
    error: Option<String>,
    #[allow(dead_code)]
    error_description: Option<String>,
}

/// Per-attempt budget for Google token HTTP calls. The interactive callback
/// wait keeps its own (longer) deadline; token exchange/refresh must not hang
/// the login forever when the network stalls.
const TOKEN_HTTP_TIMEOUT: Duration = Duration::from_secs(60);

/// Exchange an authorization code for tokens.
///
/// Uses a logging-disabled client so credentials never land in request logs.
pub async fn exchange_code_for_tokens(
    config: &GoogleOAuthConfig,
    code: &str,
    code_verifier: &str,
    redirect_uri: &str,
) -> io::Result<GoogleOAuthTokens> {
    let client = create_client_without_request_logging();
    let body = format!(
        "grant_type=authorization_code&code={}&redirect_uri={}&client_id={}&client_secret={}&code_verifier={}",
        urlencoding::encode(code),
        urlencoding::encode(redirect_uri),
        urlencoding::encode(&config.client_id),
        urlencoding::encode(&config.client_secret),
        urlencoding::encode(code_verifier),
    );
    let resp = client
        .post(GOOGLE_OAUTH_TOKEN_URL)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .timeout(TOKEN_HTTP_TIMEOUT)
        .body(body)
        .send()
        .await
        .map_err(io::Error::other)?;
    if !resp.status().is_success() {
        let status = resp.status();
        let detail = resp.text().await.unwrap_or_default();
        // Never log the request body (it holds the secret); the response
        // carries only Google's error description.
        return Err(io::Error::other(format!(
            "Token exchange failed: HTTP {status}: {}",
            detail.chars().take(300).collect::<String>()
        )));
    }
    let token: TokenResponse = resp.json().await.map_err(io::Error::other)?;
    Ok(GoogleOAuthTokens {
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        expires_in: token.expires_in,
        token_type: token.token_type,
        scope: token.scope,
    })
}

/// Refresh an access token with a stored refresh token.
///
/// Uses a logging-disabled client so credentials never land in request logs.
pub async fn refresh_access_token(
    config: &GoogleOAuthConfig,
    refresh_token: &str,
) -> io::Result<GoogleOAuthTokens> {
    let client = create_client_without_request_logging();
    let body = format!(
        "grant_type=refresh_token&refresh_token={}&client_id={}&client_secret={}",
        urlencoding::encode(refresh_token),
        urlencoding::encode(&config.client_id),
        urlencoding::encode(&config.client_secret),
    );
    let resp = client
        .post(GOOGLE_OAUTH_TOKEN_URL)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .timeout(TOKEN_HTTP_TIMEOUT)
        .body(body)
        .send()
        .await
        .map_err(io::Error::other)?;
    if !resp.status().is_success() {
        let status = resp.status();
        let detail = resp.text().await.unwrap_or_default();
        return Err(io::Error::other(format!(
            "Token refresh failed: HTTP {status}: {}",
            detail.chars().take(300).collect::<String>()
        )));
    }
    let token: TokenResponse = resp.json().await.map_err(io::Error::other)?;
    Ok(GoogleOAuthTokens {
        access_token: token.access_token,
        refresh_token: token
            .refresh_token
            .or_else(|| Some(refresh_token.to_string())),
        expires_in: token.expires_in,
        token_type: token.token_type,
        scope: token.scope,
    })
}

/// Full interactive login: browser -> localhost callback -> token exchange.
///
/// The callback server binds before the browser opens, so the redirect URI
/// always matches a live listener. Uses the `127.0.0.1` literal (not
/// `localhost`) because the server only binds IPv4 loopback.
pub async fn run_google_oauth_login(config: &GoogleOAuthConfig) -> io::Result<GoogleOAuthTokens> {
    let pkce = generate_pkce();
    let state: String = rand::random::<u128>().to_string();
    let (server, port) = bind_callback_server(config.port)?;
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");
    let auth_url = build_auth_url(
        &config.client_id,
        &redirect_uri,
        &state,
        &pkce.code_challenge,
        &config.scope,
    );
    eprintln!(
        "Opening your browser to sign in with Google.\nIf it did not open, visit:\n\n{auth_url}\n"
    );
    let _ = webbrowser::open(&auth_url);
    let code = tokio::task::spawn_blocking(move || {
        wait_for_callback_code_on(&server, &state, Duration::from_secs(5 * 60))
    })
    .await
    .map_err(io::Error::other)??;
    exchange_code_for_tokens(config, &code, &pkce.code_verifier, &redirect_uri).await
}

/// Persist provider tokens into `auth.json` (`providers.<id>`).
pub fn save_provider_tokens(
    codex_home: &Path,
    provider_id: &str,
    tokens: &GoogleOAuthTokens,
    store_mode: AuthCredentialsStoreMode,
    keyring_kind: crate::auth::AuthKeyringBackendKind,
) -> io::Result<()> {
    let mut auth = load_auth_dot_json(codex_home, store_mode, keyring_kind)?.unwrap_or_default();
    auth.providers
        .get_or_insert_with(HashMap::new)
        .insert(provider_id.to_string(), tokens.clone());
    save_auth(codex_home, &auth, store_mode, keyring_kind)
}

/// Load stored tokens for one provider, if present.
pub fn load_provider_tokens(
    codex_home: &Path,
    provider_id: &str,
    store_mode: AuthCredentialsStoreMode,
    keyring_kind: crate::auth::AuthKeyringBackendKind,
) -> io::Result<Option<GoogleOAuthTokens>> {
    Ok(load_auth_dot_json(codex_home, store_mode, keyring_kind)?
        .and_then(|auth| auth.providers)
        .and_then(|mut providers| providers.remove(provider_id)))
}

/// Refresh stored tokens in place and return the fresh access token.
pub async fn refresh_provider_tokens(
    codex_home: &Path,
    provider_id: &str,
    config: &GoogleOAuthConfig,
    store_mode: AuthCredentialsStoreMode,
    keyring_kind: crate::auth::AuthKeyringBackendKind,
) -> io::Result<String> {
    let stored = load_provider_tokens(codex_home, provider_id, store_mode, keyring_kind)?
        .ok_or_else(|| {
            io::Error::other(format!(
                "Not logged in for {provider_id}; run `aiapi login --provider {provider_id}`"
            ))
        })?;
    let refresh_token = stored.refresh_token.clone().ok_or_else(|| {
        io::Error::other(format!(
            "Stored {provider_id} credentials have no refresh token; log in again"
        ))
    })?;
    let fresh = refresh_access_token(config, &refresh_token).await?;
    save_provider_tokens(codex_home, provider_id, &fresh, store_mode, keyring_kind)?;
    Ok(fresh.access_token)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn auth_url_contains_pkce_and_encodes_scope() {
        let url = build_auth_url(
            "cid",
            "http://localhost:8080/callback",
            "state123",
            "challengeABC",
            GOOGLE_OAUTH_SCOPE_GEMINI,
        );
        assert!(url.contains("code_challenge=challengeABC"));
        assert!(url.contains("client_id=cid"));
        assert!(url.contains("https%3A%2F%2Fwww.googleapis.com"));
    }

    #[test]
    fn callback_rejects_wrong_state_then_accepts() {
        let probe = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);
        let handle = std::thread::spawn(move || {
            wait_for_callback_code(port, "good", Duration::from_secs(15))
        });
        std::thread::sleep(Duration::from_millis(300));
        // Wrong state first: server stays alive and answers 400.
        let bad = reqwest_like_get(&format!(
            "http://localhost:{port}/callback?code=x&state=bad"
        ));
        assert!(bad.contains("400") || bad.contains("Missing"));
        let ok = reqwest_like_get(&format!(
            "http://localhost:{port}/callback?code=abc&state=good"
        ));
        assert!(ok.contains("200") || ok.contains("connected"));
        assert_eq!(handle.join().unwrap().unwrap(), "abc");
    }

    fn reqwest_like_get(url: &str) -> String {
        // Minimal blocking GET without extra deps: status line + body marker.
        use std::io::{Read, Write};
        let parsed = url::Url::parse(url).unwrap();
        let host = parsed.host_str().unwrap().to_string();
        let port = parsed.port().unwrap_or(80);
        let path = format!("{}?{}", parsed.path(), parsed.query().unwrap_or(""));
        let mut stream = std::net::TcpStream::connect((host.as_str(), port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        write!(
            stream,
            "GET {path} HTTP/1.0\r\nHost: {host}\r\nConnection: close\r\n\r\n"
        )
        .unwrap();
        let mut buf = String::new();
        stream.read_to_string(&mut buf).unwrap();
        buf
    }
}
