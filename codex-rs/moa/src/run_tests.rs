use super::*;
use crate::MoaModelSlot;
use pretty_assertions::assert_eq;

struct StubCaller {
    fail_ref: bool,
    fail_agg: bool,
    empty_ref: bool,
}

impl MoaLlmCaller for StubCaller {
    async fn call_reference(
        &self,
        slot: &MoaModelSlot,
        _system: &str,
        _messages: &[ChatMessage],
        _temperature: f32,
        _max_tokens: Option<u32>,
    ) -> Result<String, String> {
        if self.fail_ref {
            Err("boom".into())
        } else if self.empty_ref {
            Ok("   ".into())
        } else {
            Ok(format!("advice from {}", slot.model))
        }
    }

    async fn call_aggregator(
        &self,
        _slot: &MoaModelSlot,
        _prompt: &str,
        _temperature: f32,
        _max_tokens: Option<u32>,
    ) -> Result<String, String> {
        if self.fail_agg {
            Err("agg down".into())
        } else {
            Ok("do this next".into())
        }
    }
}

fn slots() -> (Vec<MoaModelSlot>, MoaModelSlot) {
    (
        vec![
            MoaModelSlot {
                provider: "openai".into(),
                model: "gpt-5".into(),
            },
            MoaModelSlot {
                provider: "gemini".into(),
                model: "flash".into(),
            },
        ],
        MoaModelSlot {
            provider: "openai".into(),
            model: "codex".into(),
        },
    )
}

#[allow(clippy::too_many_arguments)]
async fn run(
    caller: &StubCaller,
    refs: &[MoaModelSlot],
    agg: &MoaModelSlot,
    events: &mut Vec<MoaEvent>,
) -> (String, Vec<ReferenceOutput>) {
    run_moa_turn(
        caller,
        "fix it",
        &[ChatMessage::user("fix it")],
        refs,
        agg,
        0.6,
        0.4,
        None,
        None,
        |e| events.push(e),
    )
    .await
}

#[tokio::test]
async fn happy_path_returns_guidance_and_events() {
    let caller = StubCaller {
        fail_ref: false,
        fail_agg: false,
        empty_ref: false,
    };
    let (refs, agg) = slots();
    let mut events = vec![];
    let (guidance, outputs) = run(&caller, &refs, &agg, &mut events).await;
    assert_eq!(outputs.len(), 2);
    assert_eq!(outputs[0].slot.model, "gpt-5");
    assert_eq!(outputs[1].slot.model, "flash");
    assert!(guidance.contains("do this next"));
    assert!(guidance.contains("Aggregator: openai:codex"));
    assert_eq!(events.len(), 3);
}

#[tokio::test]
async fn failed_reference_becomes_note_not_abort() {
    let caller = StubCaller {
        fail_ref: true,
        fail_agg: false,
        empty_ref: false,
    };
    let (refs, agg) = slots();
    let mut events = vec![];
    let (guidance, outputs) = run(&caller, &refs, &agg, &mut events).await;
    assert_eq!(outputs.len(), 2);
    assert!(outputs.iter().all(|o| o.text.contains("[failed:")));
    assert!(guidance.contains("do this next"));
}

#[tokio::test]
async fn empty_reference_becomes_empty_marker() {
    let caller = StubCaller {
        fail_ref: false,
        fail_agg: false,
        empty_ref: true,
    };
    let (refs, agg) = slots();
    let mut events = vec![];
    let (_, outputs) = run(&caller, &refs, &agg, &mut events).await;
    assert!(outputs.iter().all(|o| o.text.contains("(empty response)")));
}

#[tokio::test]
async fn failed_aggregator_falls_back_to_references() {
    let caller = StubCaller {
        fail_ref: false,
        fail_agg: true,
        empty_ref: false,
    };
    let (refs, agg) = slots();
    let mut events = vec![];
    let (guidance, _) = run(&caller, &refs, &agg, &mut events).await;
    assert!(guidance.contains("advice from gpt-5"));
    assert!(guidance.contains("advice from flash"));
}
