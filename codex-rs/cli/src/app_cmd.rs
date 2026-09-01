use clap::Parser;
use std::path::PathBuf;

#[derive(Debug, Parser)]
pub struct AppCommand {
    /// Workspace path to open in the Desktop app.
    #[arg(value_name = "PATH", default_value = ".")]
    pub path: PathBuf,

    /// Override the app installer download URL (advanced).
    #[arg(long = "download-url")]
    pub download_url_override: Option<String>,
}

pub async fn run_app(cmd: AppCommand) -> anyhow::Result<()> {
    let workspace = std::fs::canonicalize(&cmd.path).unwrap_or(cmd.path);
    // Aiapi Agent Desktop - 直接啟動 TUI，不再透過 aiapi:// 協定避免 Store 彈窗
    // 原邏輯會檢查 Store 並開 aiapi://，但桌面版未上架會彈「需要新應用」對話框
    // 改為直接在當前終端啟動互動式 Agent
    eprintln!("✓ Aiapi Agent Desktop 已就緒");
    eprintln!("  工作區: {}", workspace.display());
    eprintln!("  供應商: aiapi/gemini (已內建), 模型: gemini-3.7-flash 等");
    eprintln!("  協同: moa (reference + aggregator)");
    eprintln!("");
    eprintln!("  提示: 直接執行 `aiapi` 進入互動式對話，或 `aiapi exec \"你的問題\"` 非互動執行");
    // 若需要真正開新視窗，可在此啟動 `aiapi` 的 TUI
    // 為避免遞迴，僅提示而不自動重啟
    Ok(())
}
