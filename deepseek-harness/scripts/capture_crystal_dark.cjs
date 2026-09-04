const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const targetUrl = 'http://127.0.0.1:3080/?token=Zkj6995c4THDKokRu9Y13tYr89A9DXg20bJ5ogpYFvo';
const outDir = 'C:\\Users\\Administrator\\.gemini\\antigravity\\brain\\100d2274-686e-4303-8665-4e96df51266e';
const tempUserData = 'C:\\Users\\Administrator\\AppData\\Local\\Temp\\edge_cdp_' + Date.now();

const edge = spawn(edgePath, [
  '--headless=new',
  '--disable-gpu',
  '--remote-debugging-port=9229',
  `--user-data-dir=${tempUserData}`,
  '--window-size=1440,900',
  targetUrl
]);

setTimeout(async () => {
  try {
    const listRes = await fetch('http://127.0.0.1:9229/json');
    const tabs = await listRes.json();
    const pageTab = tabs.find(t => t.type === 'page');
    if (!pageTab) {
      console.log('No page tab found');
      edge.kill();
      return;
    }

    const ws = new WebSocket(pageTab.webSocketDebuggerUrl);

    let id = 1;
    function send(method, params = {}) {
      return new Promise((resolve) => {
        const msgId = id++;
        const handler = (event) => {
          const msg = JSON.parse(event.data);
          if (msg.id === msgId) {
            ws.removeEventListener('message', handler);
            resolve(msg.result);
          }
        };
        ws.addEventListener('message', handler);
        ws.send(JSON.stringify({ id: msgId, method, params }));
      });
    }

    ws.addEventListener('open', async () => {
      console.log('CDP connected');
      await send('Runtime.enable');
      await send('DOM.enable');

      await new Promise(r => setTimeout(r, 2000));

      await send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: 'dark' }]
      });

      await send('Runtime.evaluate', {
        expression: `
          document.body.setAttribute('data-ds-dark-theme', '');
          document.documentElement.style.colorScheme = 'dark';
        `
      });

      await new Promise(r => setTimeout(r, 1200));

      const shot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(outDir, 'shot_crystal_dark.png'), Buffer.from(shot.data, 'base64'));
      console.log('Saved shot_crystal_dark.png successfully!');

      ws.close();
      edge.kill();
      process.exit(0);
    });
  } catch (err) {
    console.error('Error:', err);
    edge.kill();
    process.exit(1);
  }
}, 3000);
