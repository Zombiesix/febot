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
    hint: '请填入 repoRoot / repos / branches / jenkins / teamwork / nextDevOrigins',
  },
  {
    src: 'example/tasks.md',
    dst: 'tasks.md',
    hint: '需求元信息表，pipeline-feed 会往里追加行',
  },
  {
    src: 'example/project-map.md',
    dst: 'project-map.md',
    hint: '平台产品 → 仓库映射，喂食时查它',
  },
  {
    src: 'example/file-lock.md',
    dst: 'file-lock.md',
    hint: '并行冲突仲裁表，初始为空表',
  },
  {
    src: 'example/om-data.json',
    dst: 'om/data.json',
    hint: '发版看板数据，可先留空',
  },
  {
    src: 'example/claude-settings.json',
    dst: '.claude/settings.json',
    hint: '含 archive 禁区 deny 规则；如需免确认自行加 permissions.defaultMode',
  },
  {
    src: 'example/teamwork-auth.txt',
    dst: '.teamwork/auth.txt',
    hint: '请填入你的 loginName / password / host',
  },
  {
    src: 'example/swagger-services.conf',
    dst: 'swagger-mcp-server/services.conf',
    hint: 'swagger-multi 服务清单（一行一条 服务名=地址），填完跑 update_global_mcp.sh',
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
