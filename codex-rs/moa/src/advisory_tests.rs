use super::*;
use crate::MoaModelSlot;
use pretty_assertions::assert_eq;

fn slot(provider: &str, model: &str) -> MoaModelSlot {
    MoaModelSlot {
        provider: provider.into(),
        model: model.into(),
    }
}

#[test]
fn truncates_long_tool_results_head_tail() {
    let text = "a".repeat(5000);
    let out = truncate_tool_result(&text, 4000);
    assert!(out.starts_with(&"a".repeat(2000)));
    assert!(out.ends_with(&"a".repeat(2000)));
    assert!(out.contains("chars omitted"));
}

#[test]
fn keeps_short_tool_results_verbatim() {
    assert_eq!(truncate_tool_result("small", 4000), "small");
}

#[test]
fn renders_tool_calls_as_text_lines() {
    let calls = vec![
        ToolCall {
            name: "bash".into(),
            arguments: "{\"cmd\":\"ls\"}".into(),
        },
        ToolCall {
            name: "".into(),
            arguments: "".into(),
        },
    ];
    let out = render_tool_calls(&calls);
    assert!(out.contains("[called tool: bash("));
    assert!(out.contains("[called tool: tool]"));
}

#[test]
fn advisory_view_drops_system_and_flattens_tools() {
    let messages = vec![
        ChatMessage::system("8k of boilerplate"),
        ChatMessage::user("fix the bug"),
        ChatMessage {
            role: "assistant".into(),
            content: "let me check".into(),
            tool_calls: vec![ToolCall {
                name: "read".into(),
                arguments: "a.rs".into(),
            }],
            is_tool_result: false,
        },
        ChatMessage::tool_result("file contents here"),
    ];
    let view = build_reference_messages(&messages);
    assert!(view.iter().all(|m| m.role != "system" && m.role != "tool"));
    assert!(view
        .iter()
        .any(|m| m.content.contains("[called tool: read(a.rs)]")));
    assert!(view.iter().any(|m| m.content.contains("[tool result:")));
    assert_eq!(view.last().unwrap().role, "user");
}

#[test]
fn synthesis_prompt_names_every_reference() {
    let refs = vec![
        (slot("openai", "gpt-5"), "advice A".into()),
        (slot("gemini", "flash"), "advice B".into()),
    ];
    let prompt = build_synthesis_prompt("do X", &refs, &slot("openai", "codex"));
    assert!(prompt.contains("advice A"));
    assert!(prompt.contains("advice B"));
    assert!(prompt.contains("openai:gpt-5"));
}

#[test]
fn guidance_wraps_synthesis_with_labels() {
    let out = build_guidance(
        "next: run tests",
        &slot("openai", "codex"),
        &[slot("gemini", "flash")],
    );
    assert!(out.contains("Aggregator: openai:codex"));
    assert!(out.contains("gemini:flash"));
    assert!(out.contains("next: run tests"));
}
