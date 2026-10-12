import { spawn } from 'node:child_process';

const children = [
  ['om 发版看板', 'node', ['om/server.js']],
  ['xiaoqian-manager 小千管理', 'yarn', ['--cwd', 'xiaoqian-manager', 'dev']],
];

console.log('om 发版看板:        http://localhost:3000');
console.log('xiaoqian-manager:   http://localhost:3010');
console.log('');

const procs = children.map(([name, cmd, args]) => {
  const p = spawn(cmd, args, { shell: true, stdio: 'inherit' });
  p.on('exit', (code) => {
    if (code && !shuttingDown) {
      console.error(`[${name}] exited with code ${code}`);
      shutdown(code);
    }
  });
  return p;
});

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const p of procs) p.kill();
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
