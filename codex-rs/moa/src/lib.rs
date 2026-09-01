//! Mixture-of-Agents (MoA) virtual provider for Aiapi Agent.
//! Ports Hermes `D:\Hermes\hermes-agent\agent\moa_loop.py` + `hermes_cli/moa_config.py`
//! into Rust so Codex can run Hermes-style multi-model collaboration.
//!
//! Config shape mirrors `D:\Hermes\config.yaml:116`:
//! ```yaml
//! moa:
//!   presets: { default: { reference_models: [...], aggregator: {...} } }
//! ```

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const DEFAULT_MOA_PRESET_NAME: &str = "default";
pub const MOA_PROVIDER_ID: &str = "moa";

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct MoaModelSlot {
    pub provider: String,
    pub model: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct MoaPreset {
    #[serde(default = "default_reference_models")]
    pub reference_models: Vec<MoaModelSlot>,
    #[serde(default = "default_aggregator")]
    pub aggregator: MoaModelSlot,
    #[serde(default = "default_ref_temp")]
    pub reference_temperature: f32,
    #[serde(default = "default_agg_temp")]
    pub aggregator_temperature: f32,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
    pub reference_max_tokens: Option<u32>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_reference_models() -> Vec<MoaModelSlot> {
    vec![
        MoaModelSlot { provider: "openai".into(), model: "gpt-5.4".into() },
        MoaModelSlot { provider: "gemini".into(), model: "gemini-3.7-flash".into() },
    ]
}
fn default_aggregator() -> MoaModelSlot {
    MoaModelSlot { provider: "openai".into(), model: "gpt-5.1-codex".into() }
}
fn default_ref_temp() -> f32 { 0.6 }
fn default_agg_temp() -> f32 { 0.4 }
fn default_max_tokens() -> u32 { 4096 }
fn default_true() -> bool { true }

impl Default for MoaPreset {
    fn default() -> Self {
        Self {
            reference_models: default_reference_models(),
            aggregator: default_aggregator(),
            reference_temperature: 0.6,
            aggregator_temperature: 0.4,
            max_tokens: 4096,
            reference_max_tokens: None,
            enabled: true,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, JsonSchema, Default)]
#[schemars(deny_unknown_fields)]
pub struct MoaConfig {
    #[serde(default)]
    pub default_preset: Option<String>,
    #[serde(default)]
    pub active_preset: Option<String>,
    #[serde(default)]
    pub presets: std::collections::HashMap<String, MoaPreset>,
}

impl MoaConfig {
    pub fn normalized(&self) -> NormalizedMoaConfig {
        let mut presets = self.presets.clone();
        if presets.is_empty() {
            presets.insert(DEFAULT_MOA_PRESET_NAME.into(), MoaPreset::default());
        }
        let default_name = self.default_preset.clone().unwrap_or_else(|| DEFAULT_MOA_PRESET_NAME.into());
        let default_name = if presets.contains_key(&default_name) { default_name } else { presets.keys().next().unwrap().clone() };
        let active = presets.get(&default_name).cloned().unwrap_or_default();
        NormalizedMoaConfig {
            default_preset: default_name,
            active_preset: self.active_preset.clone().unwrap_or_default(),
            presets: presets.clone(),
            reference_models: active.reference_models.clone(),
            aggregator: active.aggregator.clone(),
            reference_temperature: active.reference_temperature,
            aggregator_temperature: active.aggregator_temperature,
            max_tokens: active.max_tokens,
            reference_max_tokens: active.reference_max_tokens,
            enabled: active.enabled,
        }
    }
    pub fn resolve_preset(&self, name: Option<&str>) -> Option<MoaPreset> {
        let n = self.normalized();
        let key = name.unwrap_or(&n.default_preset);
        n.presets.get(key).cloned()
    }
}

#[derive(Debug, Clone)]
pub struct NormalizedMoaConfig {
    pub default_preset: String,
    pub active_preset: String,
    pub presets: std::collections::HashMap<String, MoaPreset>,
    pub reference_models: Vec<MoaModelSlot>,
    pub aggregator: MoaModelSlot,
    pub reference_temperature: f32,
    pub aggregator_temperature: f32,
    pub max_tokens: u32,
    pub reference_max_tokens: Option<u32>,
    pub enabled: bool,
}

/// Build aggregator prompt from user prompt + reference outputs.
/// Mirrors `agent/moa_loop.py` in Hermes.
pub fn build_aggregator_prompt(user_prompt: &str, references: &[(MoaModelSlot, String)]) -> String {
    let mut out = String::new();
    out.push_str("You are the aggregator for a Mixture-of-Agents system. Synthesize the following reference answers into a single high-quality response.\n\n");
    out.push_str("Original user prompt:\n");
    out.push_str(user_prompt);
    out.push_str("\n\nReference answers:\n");
    for (idx, (slot, text)) in references.iter().enumerate() {
        out.push_str(&format!("\n--- Reference {} ({}:{}) ---\n{}\n", idx+1, slot.provider, slot.model, text));
    }
    out.push_str("\nProvide the final aggregated answer. Be concise, accurate, and actionable. Do not reveal you are an aggregator.");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn default_config_normalizes() {
        let cfg = MoaConfig::default();
        let n = cfg.normalized();
        assert!(!n.reference_models.is_empty());
        assert_eq!(n.aggregator.provider, "openai");
    }
    #[test]
    fn aggregator_prompt_contains_all() {
        let p = build_aggregator_prompt("hello", &[
            (MoaModelSlot{provider:"openai".into(), model:"gpt-5".into()}, "answer A".into()),
            (MoaModelSlot{provider:"gemini".into(), model:"gemini-3".into()}, "answer B".into()),
        ]);
        assert!(p.contains("answer A"));
        assert!(p.contains("answer B"));
    }
}
