#!/usr/bin/env node
// 分级探针：问「这条命令会被确认网关判成几级」，不要靠猜。
//
// **为什么需要它**：这个项目的 hook 会把 L2/L3 的命令推到你手表上。于是
// 「随手敲一条命令看看 hook 活着没」这件事本身就有风险 —— 你敲的那条可能
// 真的删东西。更阴的是分类是基于**文本正则**的：一条 `node -e "..."` 里
// 只要**提到**了危险字符串，整条命令就会被判成 L3 推到你手表上（实测踩过一次，
// 结果那次编辑被拒、白等 120 秒）。
//
// 所以：想探测链路时，先用本工具挑一条「判为 L3 但执行效果为零」的探针。
//
// 用法：
//   node scripts/probe-tier.mjs                       # 跑内置安全探针清单
//   node scripts/probe-tier.mjs "rm -rf ~/某目录"       # 问单条命令
//   node scripts/probe-tier.mjs "cmd1" "cmd2" "cmd3"  # 问多条
//
// 退出码：0 = 全都按预期分级；1 = 有命令实际分级与预期不符（仅在跑内置清单时有意义）。
//
// 注意：本文件自身包含危险字符串，但**执行它是安全的** —— `node <文件>` 落 L1，
// hook 不会去读文件内容。

import { classify } from '../src/core/risk.mjs';

// 内置清单：每条都带「期望分级」和「为什么这样是安全的」。
// 挑探针的硬标准 = 判为 L2/L3（会推送）**且**真实执行也无副作用。
const SAFE_PROBES = [
  {
    cmd: 'rm -rf ~/WorkBuddy/agent-approval/.probe-no-such-dir',
    expect: 'L3',
    note: '目标路径不存在 ⇒ 执行也是空操作。判 L3 是「递归删除 + 不在常规清理目录」。**首选探针。**',
  },
  {
    cmd: 'sudo -n true',
    expect: 'L3',
    note: '匹配「提权」。-n 保证不弹密码提示，最坏只是退出码 1。备选探针。',
  },
  {
    cmd: 'git push --force',
    expect: 'L3',
    note: '匹配「强制推送」。在没有 remote 的目录里执行会直接报 not a git repository，无副作用。',
  },
  {
    cmd: 'git push',
    expect: 'L2',
    note: 'L2 探针（只想验证「推送」而不想验证「高危 + 解锁」时用）。同样地，无 remote 时无害。',
  },
];

const argv = process.argv.slice(2).filter((a) => a !== '--');
const cfg = {}; // 用默认配置；config.json 里的自定义规则不参与，保持纯函数可比对

if (!argv.length) {
  console.log('=== 内置安全探针清单（判为 L2/L3，但真实执行无副作用）===\n');
  let bad = 0;
  for (const p of SAFE_PROBES) {
    const r = classify('Bash', { command: p.cmd }, cfg);
    const ok = r.tier === p.expect;
    if (!ok) bad = 1;
    console.log(`${ok ? '✅' : '❌'} ${r.tier.padEnd(3)}（期望 ${p.expect}）  ${r.why}`);
    console.log(`     ${p.cmd}`);
    console.log(`     ↳ ${p.note}`);
    console.log('');
  }
  console.log('想测哪一层，复制对应那条命令去执行即可。');
  console.log('只想知道某条命令会不会打扰你，直接把它当参数传进来。');
  process.exit(bad);
}

let worst = 'L0';
for (const cmd of argv) {
  const r = classify('Bash', { command: cmd }, cfg);
  const willPush = r.tier === 'L2' || r.tier === 'L3';
  console.log(`${r.tier}  ${willPush ? '→ 会推送到手机/手表' : '→ 不推送（静默通过）'}`);
  console.log(`     依据：${r.why}`);
  console.log(`     命令：${cmd}`);
  console.log('');
}
