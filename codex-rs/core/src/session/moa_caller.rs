//! MoA (Mixture-of-Agents) wiring for normal turns.
//!
//! [`MoaCaller`] implements [`codex_moa::MoaLlmCaller`] with the session's
//! [`ModelClient`], forking one sibling client per reference/aggregator slot
//! so slot calls never share the main turn's sticky-routing token or
//! incremental-request state. [`maybe_run_moa_guidance`] is the single entry
//! turn.rs calls once per turn; it returns a user-role [`ResponseItem`]
//! carrying private guidance for the main agent loop, or `None` when MoA is
//! off, misconfigured, cancelled, or entirely failed.
//!
//! v1 limits (documented, not silent): reference/aggregator temperatures are
//! accepted but not sent (Responses API has no temperature field on this
//! path); MoA runs once per turn rather than per tool-loop iteration to bound
//! cost; guidance is recorded into history so stream retries keep it.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use codex_moa::{ChatMessage, MoaLlmCaller, MoaModelSlot, ToolCall, run_moa_turn};
use codex_model_provider_info::ModelProviderInfo;
use codex_models_manager::model_info::model_info_from_slug;
use codex_protocol::models::{BaseInstructions, ContentItem, ResponseItem};
use futures::StreamExt;

use super::session::Session;
use super::turn_context::TurnContext;
use crate::client::ModelClient;
use crate::client_common::{Prompt, ResponseEvent};
use crate::responses_metadata::CodexResponsesMetadata;

/// Upper bound for a whole MoA guidance pass. Turn cancellation also aborts
/// it early via `select!` at the call site.
const MOA_TURN_TIMEOUT: Duration = Duration::from_secs(300);

/// [`MoaLlmCaller`] backed by forked [`ModelClient`]s.
pub(crate) struct MoaCaller {
    base_client: ModelClient,
    providers: HashMap<String, ModelProviderInfo>,
    session_telemetry: codex_otel::SessionTelemetry,
    responses_metadata: CodexResponsesMetadata,
    inference_trace: codex_rollout_trace::InferenceTraceContext,
    reasoning_summary: codex_protocol::config_types::ReasoningSummary,
    service_tier: Option<String>,
}

impl MoaCaller {
    fn client_for_slot(&self, slot: &MoaModelSlot) -> Result<ModelClient, String> {
        let info = self.providers.get(&slot.provider).cloned().ok_or_else(|| {
            format!(
                "unknown MoA provider '{}' (configure [model_providers.{}])",
                slot.provider, slot.provider
            )
        })?;
        Ok(self.base_client.fork_for_provider(info))
    }

    async fn call_slot(
        &self,
        slot: &MoaModelSlot,
        system: Option<&str>,
        input: Vec<ResponseItem>,
    ) -> Result<String, String> {
        let client = self.client_for_slot(slot)?;
        let mut session = client.new_session();
        let model_info = model_info_from_slug(&slot.model);
        let prompt = Prompt {
            input,
            base_instructions: BaseInstructions {
                text: system.unwrap_or_default().to_string(),
                provenance: None,
            },
            ..Default::default()
        };
        let mut stream = session
            .stream(
                &prompt,
                &model_info,
                &self.session_telemetry,
                None,
                self.reasoning_summary,
                self.service_tier.clone(),
                &self.responses_metadata,
                &self.inference_trace,
            )
            .await
            .map_err(|err| err.to_string())?;
        let mut text = String::new();
        while let Some(event) = stream.next().await {
            let event = event.map_err(|err| err.to_string())?;
            if let ResponseEvent::OutputItemDone(ResponseItem::Message { content, .. }) = event {
                for item in &content {
                    if let ContentItem::OutputText { text: chunk } = item {
                        text.push_str(chunk);
                    }
                }
            }
        }
        Ok(text)
    }
}

impl MoaLlmCaller for MoaCaller {
    async fn call_reference(
        &self,
        slot: &MoaModelSlot,
        system: &str,
        messages: &[ChatMessage],
        _temperature: f32,
        max_tokens: Option<u32>,
    ) -> Result<String, String> {
        let _ = max_tokens;
        self.call_slot(slot, Some(system), chat_messages_to_response_items(messages))
            .await
    }

    async fn call_aggregator(
        &self,
        slot: &MoaModelSlot,
        prompt: &str,
        _temperature: f32,
        max_tokens: Option<u32>,
    ) -> Result<String, String> {
        let _ = max_tokens;
        self.call_slot(slot, None, vec![user_text_item(prompt)]).await
    }
}

/// Convert advisory-view messages into Responses input items.
fn chat_messages_to_response_items(messages: &[ChatMessage]) -> Vec<ResponseItem> {
    messages
        .iter()
        .filter(|m| m.role == "user" || m.role == "assistant")
        .map(|m| ResponseItem::Message {
            id: None,
            role: m.role.clone(),
            content: vec![ContentItem::InputText {
                text: m.content.clone(),
            }],
            phase: None,
            internal_chat_message_metadata_passthrough: None,
        })
        .collect()
}

fn user_text_item(text: &str) -> ResponseItem {
    ResponseItem::Message {
        id: None,
        role: "user".to_string(),
        content: vec![ContentItem::InputText {
            text: text.to_string(),
        }],
        phase: None,
        internal_chat_message_metadata_passthrough: None,
    }
}

/// Convert live history into advisory-view messages for reference models.
fn history_to_chat_messages(history: &[ResponseItem]) -> Vec<ChatMessage> {
    let mut out = vec![];
    for item in history {
        match item {
            ResponseItem::Message { role, content, .. } => {
                let text = content
                    .iter()
                    .filter_map(|c| match c {
                        ContentItem::InputText { text } | ContentItem::OutputText { text } => {
                            Some(text.as_str())
                        }
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("");
                match role.as_str() {
                    "system" => out.push(ChatMessage::system(text)),
                    "assistant" => out.push(ChatMessage::assistant(text)),
                    "developer" | "user" => out.push(ChatMessage::user(text)),
                    _ => {}
                }
            }
            ResponseItem::FunctionCall { name, arguments, .. } => out.push(ChatMessage {
                role: "assistant".to_string(),
                content: String::new(),
                tool_calls: vec![ToolCall {
                    name: name.clone(),
                    arguments: arguments.clone(),
                }],
                is_tool_result: false,
            }),
            ResponseItem::FunctionCallOutput { output, .. }
            | ResponseItem::CustomToolCallOutput { output, .. } => {
                out.push(ChatMessage::tool_result(output.to_string()));
            }
            _ => {}
        }
    }
    out
}

/// Run one MoA guidance pass for the current turn, if configured.
///
/// Returns the guidance as a user-role item to record into history, or `None`
/// when MoA is disabled/unconfigured/cancelled. Never errors: a total failure
/// just means the turn proceeds without guidance.
pub(crate) async fn maybe_run_moa_guidance(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    history: &[ResponseItem],
    user_prompt: &str,
    responses_metadata: &CodexResponsesMetadata,
    cancellation_token: tokio_util::sync::CancellationToken,
) -> Option<ResponseItem> {
    let moa = &turn_context.config.moa;
    let preset_name = moa
        .active_preset
        .as_deref()
        .filter(|name| !name.trim().is_empty())
        .or(moa.default_preset.as_deref());
    let preset = moa.resolve_preset(preset_name)?;
    if !preset.enabled || preset.reference_models.is_empty() {
        return None;
    }
    let caller = MoaCaller {
        base_client: sess.services.model_client.clone(),
        providers: turn_context.config.model_providers.clone(),
        session_telemetry: turn_context.session_telemetry.clone(),
        responses_metadata: responses_metadata.clone(),
        inference_trace: sess.services.rollout_thread_trace.inference_trace_context(
            turn_context.sub_id.as_str(),
            &preset.aggregator.model,
            &preset.aggregator.provider,
        ),
        reasoning_summary: codex_protocol::config_types::ReasoningSummary::default(),
        service_tier: turn_context.config.service_tier.clone(),
    };
    let api_messages = history_to_chat_messages(history);
    let guidance = tokio::select! {
        _ = cancellation_token.cancelled() => return None,
        result = tokio::time::timeout(
            MOA_TURN_TIMEOUT,
            run_moa_turn(
                &caller,
                user_prompt,
                &api_messages,
                &preset.reference_models,
                &preset.aggregator,
                preset.reference_temperature,
                preset.aggregator_temperature,
                Some(preset.max_tokens),
                preset.reference_max_tokens,
                |event| tracing::info!("moa event: {event:?}"),
            ),
        ) => match result {
            Ok((guidance, _)) => guidance,
            Err(_) => {
                tracing::warn!("MoA guidance pass timed out after {}s", MOA_TURN_TIMEOUT.as_secs());
                return None;
            }
        },
    };
    if guidance.trim().is_empty() {
        return None;
    }
    Some(user_text_item(&guidance))
}
