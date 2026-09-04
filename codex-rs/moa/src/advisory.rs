//! Advisory-view logic for Mixture-of-Agents.
//!
//! Ports the pure helpers in Hermes `hermes-agent/agent/moa_loop.py`:
//! tool-result trimming, tool-call rendering, the advisory conversation view
//! for reference models, and the aggregator synthesis prompt.
//!
//! References are advisors, not actors: they never see real `tool_calls`
//! payloads or `tool`-role messages (strict providers reject those), only
//! flattened text. The acting aggregator always receives the full transcript;
//! everything here shapes the disposable advisory copy.

use serde::{Deserialize, Serialize};

use crate::MoaModelSlot;

/// Character budget for one tool result inside the advisory view.
/// Larger results are shown head+tail with an omission marker.
pub const REFERENCE_TOOL_RESULT_BUDGET: usize = 4000;

/// Upper bound on concurrent reference-model calls.
pub const MAX_REFERENCE_WORKERS: usize = 8;

/// System prompt prepended to every reference-model call. Reframes the model
/// as an analyst so it does not refuse for lack of tool access.
pub const REFERENCE_SYSTEM_PROMPT: &str = "You are a reference advisor in a Mixture of Agents (MoA) process. You are NOT the acting agent and you do NOT execute anything: you cannot call tools, run commands, browse, or access files, repositories, or URLs, and you should not try to or apologize for being unable to. A separate aggregator/orchestrator model holds those capabilities and will take the actual actions.\n\nThe conversation below is the current state of a task handled by that acting agent. Your job is to give your most intelligent analysis of that state: understand the goal, reason about the problem, and advise on what to do next. Surface the best approach, concrete next steps and tool-use strategy, likely pitfalls and risks, and anything the acting agent may have missed or gotten wrong. Assume any referenced files, URLs, or systems exist and reason about them from the context given rather than asking for access.\n\nRespond with your advice directly - no preamble, no disclaimers about tools or access. Your response is private guidance handed to the aggregator, not an answer shown to the user.";

/// Advisory instruction appended as a synthetic trailing user turn so the
/// reference view always ends on a `user` message (Anthropic rejects a
/// trailing assistant turn as an unfulfilled prefill).
pub const ADVISORY_INSTRUCTION: &str = "[The conversation above is the current state of the task. Give your most intelligent judgement: what is going on, what should happen next, what risks or mistakes you see, and how the acting agent should proceed.]";

/// Human-readable `provider:model` label for a slot.
pub fn slot_label(slot: &MoaModelSlot) -> String {
    format!("{}:{}", slot.provider.trim(), slot.model.trim())
}

/// Minimal chat message shape used by the advisory view.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    #[serde(default)]
    pub content: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
    /// `true` when this message is a tool result (`tool`-role in OpenAI terms).
    #[serde(default)]
    pub is_tool_result: bool,
}

impl ChatMessage {
    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: "user".into(),
            content: content.into(),
            tool_calls: vec![],
            is_tool_result: false,
        }
    }

    pub fn assistant(content: impl Into<String>) -> Self {
        Self {
            role: "assistant".into(),
            content: content.into(),
            tool_calls: vec![],
            is_tool_result: false,
        }
    }

    pub fn system(content: impl Into<String>) -> Self {
        Self {
            role: "system".into(),
            content: content.into(),
            tool_calls: vec![],
            is_tool_result: false,
        }
    }

    pub fn tool_result(content: impl Into<String>) -> Self {
        Self {
            role: "tool".into(),
            content: content.into(),
            tool_calls: vec![],
            is_tool_result: true,
        }
    }
}

/// One tool call on an assistant turn (subset of the OpenAI shape).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub arguments: String,
}

/// Head+tail preview of a tool result for the advisory view.
pub fn truncate_tool_result(text: &str, budget: usize) -> String {
    if text.chars().count() <= budget {
        return text.to_string();
    }
    let half = budget / 2;
    let head: String = text.chars().take(half).collect();
    let tail: String = text
        .chars()
        .rev()
        .take(half)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    let omitted = text.chars().count() - 2 * half;
    format!("{head}\n[... {omitted} chars omitted ...]\n{tail}")
}

/// Render an assistant turn's tool calls as readable text lines.
pub fn render_tool_calls(tool_calls: &[ToolCall]) -> String {
    tool_calls
        .iter()
        .map(|tc| {
            let name = if tc.name.trim().is_empty() {
                "tool"
            } else {
                tc.name.trim()
            };
            if tc.arguments.trim().is_empty() {
                format!("[called tool: {name}]")
            } else {
                format!("[called tool: {name}({})]", tc.arguments.trim())
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Build the advisory view of a conversation for reference models.
///
/// - `system` turns are dropped (agent boilerplate, not advisory signal).
/// - Assistant `tool_calls` are rendered inline as text.
/// - Tool results are folded (head+tail preview) into the preceding assistant
///   turn as `[tool result: ...]` blocks.
/// - Emits only plain user/assistant text turns and always ends on `user`.
pub fn build_reference_messages(messages: &[ChatMessage]) -> Vec<ChatMessage> {
    let mut rendered: Vec<ChatMessage> = vec![];
    for msg in messages {
        match msg.role.as_str() {
            "system" => continue,
            "user" => {
                // Kept even when empty (Hermes parity): dropping turns would
                // blind the reference to the conversation shape.
                rendered.push(ChatMessage::user(msg.content.clone()));
            }
            "assistant" => {
                let mut parts = vec![];
                if !msg.content.trim().is_empty() {
                    parts.push(msg.content.trim().to_string());
                }
                let calls_text = render_tool_calls(&msg.tool_calls);
                if !calls_text.is_empty() {
                    parts.push(calls_text);
                }
                if !parts.is_empty() {
                    rendered.push(ChatMessage::assistant(parts.join("\n")));
                }
            }
            _ if msg.is_tool_result || msg.role == "tool" => {
                let preview =
                    truncate_tool_result(msg.content.trim(), REFERENCE_TOOL_RESULT_BUDGET);
                let block = format!("[tool result: {preview}]");
                let append_to_last = rendered.last().is_some_and(|m| m.role == "assistant");
                if append_to_last {
                    if let Some(last) = rendered.last_mut() {
                        last.content.push('\n');
                        last.content.push_str(&block);
                    }
                } else {
                    rendered.push(ChatMessage::assistant(block));
                }
            }
            _ => continue,
        }
    }
    if rendered.last().is_none_or(|m| m.role != "user") {
        rendered.push(ChatMessage::user(ADVISORY_INSTRUCTION));
    }
    rendered
}

/// Build the aggregator synthesis prompt from reference outputs.
///
/// Mirrors Hermes `aggregate_moa_context`: the aggregator produces private
/// guidance for the main agent loop, not a direct user-facing answer.
pub fn build_synthesis_prompt(
    user_prompt: &str,
    references: &[(MoaModelSlot, String)],
    aggregator: &MoaModelSlot,
) -> String {
    let joined = references
        .iter()
        .enumerate()
        .map(|(idx, (slot, text))| format!("Reference {} - {}:\n{text}", idx + 1, slot_label(slot)))
        .collect::<Vec<_>>()
        .join("\n\n");
    let _ = aggregator;
    format!(
        "You are the aggregator in a Mixture of Agents process. Synthesize the reference responses into concise, actionable guidance for the main agent. Focus on next steps, tool-use strategy, risks, and any disagreements. Do not answer the user directly unless that is all that is needed; produce context the main agent should use in its normal loop.\n\nOriginal user prompt:\n{user_prompt}\n\nReference responses:\n{joined}"
    )
}

/// Wrap the aggregator synthesis (or the joined references on failure) as
/// private guidance for the main agent loop.
pub fn build_guidance(
    synthesis: &str,
    aggregator: &MoaModelSlot,
    reference_models: &[MoaModelSlot],
) -> String {
    let refs = reference_models
        .iter()
        .map(slot_label)
        .collect::<Vec<_>>()
        .join(", ");
    let body = if synthesis.trim().is_empty() {
        "(no aggregator synthesis; see reference outputs below)"
    } else {
        synthesis.trim()
    };
    format!(
        "[Mixture of Agents context - use this as private guidance for the normal agent loop. You may call tools, continue reasoning, or finish normally.]\nAggregator: {}\nReferences: {refs}\n\n{body}",
        slot_label(aggregator)
    )
}

/// Legacy one-shot prompt builder (direct-answer style).
///
/// Prefer [`build_synthesis_prompt`] + [`build_guidance`] for the Hermes loop
/// semantics; kept for backward compatibility.
pub fn build_aggregator_prompt(user_prompt: &str, references: &[(MoaModelSlot, String)]) -> String {
    let mut out = String::new();
    out.push_str("You are the aggregator for a Mixture-of-Agents system. Synthesize the following reference answers into a single high-quality response.\n\n");
    out.push_str("Original user prompt:\n");
    out.push_str(user_prompt);
    out.push_str("\n\nReference answers:\n");
    for (idx, (slot, text)) in references.iter().enumerate() {
        out.push_str(&format!(
            "\n--- Reference {} ({}:{}) ---\n{}\n",
            idx + 1,
            slot.provider,
            slot.model,
            text
        ));
    }
    out.push_str("\nProvide the final aggregated answer. Be concise, accurate, and actionable. Do not reveal you are an aggregator.");
    out
}

#[cfg(test)]
#[path = "advisory_tests.rs"]
mod tests;
