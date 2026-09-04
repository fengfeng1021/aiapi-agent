//! MoA turn execution: parallel references + aggregator synthesis.
//!
//! Ports `aggregate_moa_context` / `MoAChatCompletions` from Hermes
//! `hermes-agent/agent/moa_loop.py`.
//!
//! The actual model I/O stays behind [`MoaLlmCaller`] so `codex-core` can plug
//! in its model client; this crate owns the orchestration semantics:
//! - references run concurrently (capped at [`MAX_REFERENCE_WORKERS`], each
//!   bounded by [`REFERENCE_CALL_TIMEOUT`]);
//! - a failed/timed-out/empty reference becomes a `[failed: ...]` note,
//!   never an aborted turn;
//! - an empty/failed aggregator falls back to the joined references;
//! - the result is private guidance for the main agent loop.
//!
//! Display events are emitted in batch after all references settle (not
//! streaming): frontends render the labelled blocks before aggregation.

use std::time::Duration;

use futures::stream::{self, StreamExt};

use crate::MoaModelSlot;
use crate::advisory::{
    ChatMessage, MAX_REFERENCE_WORKERS, REFERENCE_SYSTEM_PROMPT, build_guidance,
    build_reference_messages, build_synthesis_prompt, slot_label,
};

/// Per-reference call budget. A hung reference degrades to a failure note
/// instead of stalling the turn.
pub const REFERENCE_CALL_TIMEOUT: Duration = Duration::from_secs(120);

/// One reference-model output, including failures-as-notes.
#[derive(Debug, Clone)]
pub struct ReferenceOutput {
    pub slot: MoaModelSlot,
    pub text: String,
}

/// Display events mirrored from Hermes `MoAChatCompletions.reference_callback`.
#[derive(Debug, Clone)]
pub enum MoaEvent {
    Reference {
        index: usize,
        count: usize,
        label: String,
        text: String,
    },
    Aggregating {
        aggregator: String,
        ref_count: usize,
    },
}

/// Model I/O backing a MoA turn. Implemented by `codex-core` with its real
/// model client; tests use a stub.
///
/// Callbacks must be non-blocking: they run inline on the awaiting task.
pub trait MoaLlmCaller: Send + Sync {
    fn call_reference(
        &self,
        slot: &MoaModelSlot,
        system: &str,
        messages: &[ChatMessage],
        temperature: f32,
        max_tokens: Option<u32>,
    ) -> impl std::future::Future<Output = Result<String, String>> + Send;

    fn call_aggregator(
        &self,
        slot: &MoaModelSlot,
        prompt: &str,
        temperature: f32,
        max_tokens: Option<u32>,
    ) -> impl std::future::Future<Output = Result<String, String>> + Send;
}

/// Full MoA turn: gather reference advice in parallel, then synthesize.
///
/// Returns `(guidance, references)` where `guidance` is injected into the
/// main agent loop and `references` carries every reference text for display.
#[allow(clippy::too_many_arguments)]
pub async fn run_moa_turn<C, F>(
    caller: &C,
    user_prompt: &str,
    api_messages: &[ChatMessage],
    reference_models: &[MoaModelSlot],
    aggregator: &MoaModelSlot,
    reference_temperature: f32,
    aggregator_temperature: f32,
    max_tokens: Option<u32>,
    reference_max_tokens: Option<u32>,
    mut on_event: F,
) -> (String, Vec<ReferenceOutput>)
where
    C: MoaLlmCaller,
    F: FnMut(MoaEvent),
{
    let ref_messages = std::sync::Arc::new(build_reference_messages(api_messages));
    let mut indexed: Vec<(usize, ReferenceOutput)> =
        stream::iter(reference_models.iter().cloned().enumerate())
            .map(|(index, slot)| {
                let messages = std::sync::Arc::clone(&ref_messages);
                async move {
                    let call = caller.call_reference(
                        &slot,
                        REFERENCE_SYSTEM_PROMPT,
                        &messages,
                        reference_temperature,
                        reference_max_tokens.or(max_tokens),
                    );
                    let result = tokio::time::timeout(REFERENCE_CALL_TIMEOUT, call).await;
                    let text = match result {
                        Ok(Ok(text)) if !text.trim().is_empty() => text,
                        Ok(Ok(_)) => format!("[failed: {}: (empty response)]", slot_label(&slot)),
                        Ok(Err(err)) => format!("[failed: {}: {err}]", slot_label(&slot)),
                        Err(_) => format!(
                            "[failed: {}: timed out after {}s]",
                            slot_label(&slot),
                            REFERENCE_CALL_TIMEOUT.as_secs()
                        ),
                    };
                    (index, ReferenceOutput { slot, text })
                }
            })
            .buffer_unordered(MAX_REFERENCE_WORKERS)
            .collect()
            .await;
    indexed.sort_by_key(|(index, _)| *index);
    let references: Vec<ReferenceOutput> =
        indexed.into_iter().map(|(_, output)| output).collect();
    for (idx, output) in references.iter().enumerate() {
        on_event(MoaEvent::Reference {
            index: idx + 1,
            count: references.len(),
            label: slot_label(&output.slot),
            text: output.text.clone(),
        });
    }
    on_event(MoaEvent::Aggregating {
        aggregator: slot_label(aggregator),
        ref_count: references.len(),
    });

    let pairs: Vec<(MoaModelSlot, String)> =
        references.iter().map(|o| (o.slot.clone(), o.text.clone())).collect();
    let synth_prompt = build_synthesis_prompt(user_prompt, &pairs, aggregator);
    let synthesis = caller
        .call_aggregator(aggregator, &synth_prompt, aggregator_temperature, max_tokens)
        .await
        .unwrap_or_else(|err| {
            tracing::warn!("MoA aggregator {} failed: {err}; falling back to references", slot_label(aggregator));
            String::new()
        });
    let synthesis = if synthesis.trim().is_empty() {
        pairs
            .iter()
            .enumerate()
            .map(|(idx, (slot, text))| {
                format!("Reference {} - {}:\n{text}", idx + 1, slot_label(slot))
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    } else {
        synthesis
    };
    let guidance = build_guidance(&synthesis, aggregator, reference_models);
    (guidance, references)
}

#[cfg(test)]
#[path = "run_tests.rs"]
mod tests;
