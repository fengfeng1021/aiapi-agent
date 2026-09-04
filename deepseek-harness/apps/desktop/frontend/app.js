let lastProgress = 1;
let startupFailed = false;
let retryPending = false;
let diagnosticText = '';

const progressPhase = (value) => {
  if (value >= 100) return '准备完成';
  if (value >= 84) return '服务验证';
  if (value >= 72) return '系统适配';
  if (value >= 28) return '运行时配置';
  return '环境检测';
};

const recoveryGuidance = (category) => ({
  security: '安全软件或 Windows 文件保护暂时阻止了运行环境。请先重新尝试；若仍失败，请在安全软件中允许 Aiapi Agent。',
  storage: '磁盘空间不足或文件无法写入。请释放系统盘空间并确认当前账户可写入本地应用目录，然后重试。',
  package: '安装包内的运行环境不完整或已损坏。请重新下载安装包；若仍失败，请复制诊断信息反馈。',
  timeout: '本地服务未在预期时间内响应。应用已停止本次后台服务，请重新尝试；若仍失败，请打开日志目录。',
  general: '请先重新尝试。若仍失败，可复制诊断信息或打开日志目录；反馈时无需提供账号密钥或聊天内容。',
})[category] ?? '请先重新尝试；若仍失败，请复制诊断信息反馈。';

const updateStages = (value) => {
  const stages = [...document.querySelectorAll('.stages li')];
  for (const stage of stages) {
    const threshold = Number(stage.dataset.threshold);
    stage.classList.toggle('complete', value >= threshold);
    stage.classList.remove('active');
  }
  stages.find(stage => !stage.classList.contains('complete'))?.classList.add('active');
};

window.__dshDesktopStartupReset = () => {
  startupFailed = false;
  retryPending = false;
  diagnosticText = '';
  lastProgress = 1;
  document.body.dataset.state = 'starting';
  const progress = document.getElementById('progress');
  progress.classList.remove('failed');
  progress.removeAttribute('aria-invalid');
  progress.value = 1;
  document.getElementById('phase-label').textContent = progressPhase(1);
  document.getElementById('progress-value').textContent = '1%';
  document.getElementById('recovery').hidden = true;
  document.getElementById('technical-details').open = false;
  document.getElementById('details').textContent = '';
  document.getElementById('recovery-feedback').textContent = '';
  document.getElementById('activity-text').textContent = '请保持应用开启，通常只需片刻';
  const retry = document.getElementById('retry-startup');
  retry.classList.remove('pending');
  retry.removeAttribute('aria-disabled');
  retry.textContent = '重新尝试';
  updateStages(1);
};

window.__dshDesktopStartupProgress = ({ value, zh, en }) => {
  if (startupFailed) return;

  const incoming = Number(value);
  const bounded = Number.isFinite(incoming)
    ? Math.max(lastProgress, Math.min(100, Math.round(incoming)))
    : lastProgress;
  lastProgress = bounded;
  document.body.dataset.state = bounded >= 100 ? 'complete' : 'starting';

  document.getElementById('status-zh').textContent = zh;
  document.getElementById('status-en').textContent = en;
  document.getElementById('phase-label').textContent = progressPhase(bounded);
  const progress = document.getElementById('progress');
  progress.setAttribute('aria-valuenow', String(bounded));
  progress.setAttribute('aria-valuetext', `${bounded}%，${zh}`);
  progress.removeAttribute('aria-invalid');
  progress.value = bounded;
  progress.textContent = `${bounded}%`;
  document.getElementById('progress-value').textContent = `${bounded}%`;
  document.getElementById('activity-text').textContent = bounded >= 84
    ? '正在等待本地服务响应，请勿关闭应用'
    : '请保持应用开启，通常只需片刻';
  updateStages(bounded);
};

window.__dshDesktopStartupError = (payload) => {
  startupFailed = true;
  document.body.dataset.state = 'failed';
  const message = typeof payload === 'string' ? payload : payload.message;
  const category = typeof payload === 'string' ? 'general' : payload.category;
  diagnosticText = typeof payload === 'string' ? payload : payload.diagnostics;
  document.getElementById('phase-label').textContent = '需要处理';
  document.getElementById('status-zh').textContent = '启动没有完成';
  document.getElementById('status-en').textContent = 'Aiapi Agent could not finish starting.';
  const progress = document.getElementById('progress');
  progress.classList.add('failed');
  progress.setAttribute('aria-invalid', 'true');
  progress.setAttribute('aria-valuenow', String(lastProgress));
  progress.setAttribute('aria-valuetext', `启动失败，进度冻结在 ${lastProgress}%`);
  document.getElementById('progress-value').textContent = `${lastProgress}%`;
  document.getElementById('details').textContent = message;
  document.getElementById('recovery-guidance').textContent = recoveryGuidance(category);
  document.getElementById('recovery').hidden = false;
  document.getElementById('activity-text').textContent = '本次后台服务已停止，可安全重试';
};

document.getElementById('retry-startup').addEventListener('click', (event) => {
  if (retryPending) {
    event.preventDefault();
    return;
  }
  retryPending = true;
  const retry = event.currentTarget;
  retry.classList.add('pending');
  retry.setAttribute('aria-disabled', 'true');
  retry.textContent = '正在重试…';
});

document.getElementById('copy-diagnostics').addEventListener('click', async () => {
  const feedback = document.getElementById('recovery-feedback');
  try {
    await navigator.clipboard.writeText(diagnosticText);
    feedback.textContent = '诊断信息已复制。';
  } catch {
    feedback.textContent = '无法自动复制；请打开日志目录并发送 startup-latest.txt。';
  }
});
