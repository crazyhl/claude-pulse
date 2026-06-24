// 简单自测: 跑一次 monitor + claudeActivity,打印结果
const { detectProcesses } = require('../src/monitor');
const { readLatestActivity } = require('../src/claudeActivity');

(async () => {
  console.log('=== monitor ===');
  const procs = await detectProcesses();
  console.log(JSON.stringify({
    claude: procs.claude,
    opencode: procs.opencode,
    trae: procs.trae,
    processCount: procs.processCount,
  }, null, 2));

  console.log('\n=== claude activity ===');
  const activity = await readLatestActivity();
  console.log(JSON.stringify(activity, null, 2));
})();
