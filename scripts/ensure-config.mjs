import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 每个团队各填各的配置/数据文件，模板统一放在 example/ 下，生成物一律 gitignore。
// 已存在则跳过，绝不覆盖使用者已填的内容。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TEMPLATES = [
  {
    src: 'example/febot.config.json',
    dst: 'febot.config.json',
    hint: '请填入 repoRoot / jenkinsBase / defaults（devBranch + mergeBranch）/ repositories[] / teamwork / nextDevOrigins；首次启动也可在应用设置里填写',
  },
  {
    src: 'example/tasks.md',
    dst: 'tasks.md',
    hint: '需求元信息表，pipeline-feed 会往里追加行',
  },
  {
    src: 'example/file-lock.md',
    dst: 'file-lock.md',
    hint: '并行冲突仲裁表，初始为空表',
  },
    {
    src: 'example/claude-settings.json',
    dst: '.claude/settings.json',
    hint: '含 archive 禁区 deny 规则；如需免确认自行加 permissions.defaultMode',
  },
  {
    src: 'example/swagger-services.conf',
    dst: 'swagger-mcp-server/services.conf',
    hint: 'swagger-multi 服务清单（生成物）：在 febot.config.json 的 repositories[].swagger 里配置，再跑 yarn swagger',
  },
  {
    src: 'example/hindsight.env',
    dst: 'scripts/hindsight.env',
    hint: '请填入你的 Ark Plan Key 和 SiliconFlow Key',
  },
];

for (const { src, dst, hint } of TEMPLATES) {
  const srcPath = path.join(ROOT, src);
  const dstPath = path.join(ROOT, dst);
  if (fs.existsSync(dstPath)) {
    console.log(`[setup] ${dst} 已存在，跳过`);
  } else if (fs.existsSync(srcPath)) {
    fs.mkdirSync(path.dirname(dstPath), { recursive: true });
    fs.copyFileSync(srcPath, dstPath);
    console.log(`[setup] 已从 ${src} 生成 ${dst}，${hint}`);
  } else {
    console.log(`[setup] 警告：${src} 不存在，跳过 ${dst} 生成`);
  }
}
