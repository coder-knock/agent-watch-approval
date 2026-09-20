#!/usr/bin/env node
// 风险分级的回归测试。
//
// 存在的理由：hook 一旦接上，**每一次工具调用**都会走分级。
// 分错档有两个方向，代价完全不同：
//   · 把危险命令判低了 → 安全问题（有 selftest 盯着几条）
//   · 把无害命令判高了 → 每次都推一张卡到你手表上。
//     这个方向没有测试盯，但它才是真正会毁掉这套方案的那个 ——
//     打扰预算一旦被消耗完，你就会开始无脑点「允许」，等于白接。
//
// 实测踩到过：`cd ~`、`export PATH=...`、`bash -n x`、`node --check x`、
// 甚至本机自己的 `approval test`，全部落到 `unmatchedBashTier` 默认的 L2 并推送。
//
//   node test/risk.test.mjs

import { classify, needsApproval } from '../src/core/risk.mjs';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const bash = (cmd) => classify('Bash', { command: cmd });

/** 断言一批命令落在期望档位 */
function tierCases(title, cases) {
  console.log(`\n${title}`);
  for (const [cmd, want] of cases) {
    const got = bash(cmd);
    check(`${want.padEnd(2)}  ${cmd.slice(0, 58)}`, got.tier === want,
      `实际 ${got.tier}（${got.why}）`);
  }
}

// ── 1. 不推送档：L0 / L1 绝不能占打扰预算 ─────────────────────
console.log('\nrisk.mjs — 分级回归\n');

tierCases('[1] 绝不推送（L0 / L1）：日常无害命令', [
  ['cd ~', 'L0'],
  ['cd /path/to/agent-approval', 'L0'],
  ['export PATH="$HOME/.local/bin:$PATH"', 'L0'],
  ['unset HTTP_PROXY', 'L0'],
  ['set -e', 'L0'],
  ['true', 'L0'],
  ['ls -la', 'L0'],
  ['git status', 'L0'],
  ['git log --oneline -5', 'L0'],
  ['cat package.json', 'L0'],
  ['wc -l file', 'L0'],
  ['stat -f %N /tmp/x', 'L0'],
  ['printenv HOME', 'L0'],
  ['lsof -nP -iTCP:7788 -sTCP:LISTEN', 'L0'],
  // 语法校验：改完代码的标准动作，只解析不执行
  ['bash -n /path/script', 'L0'],
  ['sh -n /path/script', 'L0'],
  ['node --check src/core/risk.mjs', 'L0'],
  ['python3 -m py_compile x.py', 'L0'],
  // 本机自己的控制工具：只能撤销放行、不能授予，放 L1 不会变后门
  ['approval test', 'L1'],
  ['approval health', 'L1'],
  ['approval sessions', 'L1'],
  ['approval audit 20', 'L1'],
  // 常规本地写入
  ['mkdir -p /tmp/x', 'L1'],
  ['cp a b', 'L1'],
  ['git commit -m "x"', 'L1'],
  ['npm install', 'L1'],
  // 常规清理
  ['rm -rf node_modules', 'L1'],
  ['rm -rf ./dist', 'L1'],
  ['rm -rf /tmp/build', 'L1'],
]);

// ── 2. 危险档：判低就是安全事故 ─────────────────────────────
tierCases('[2] 危险命令必须拦住（L3）', [
  ['rm -rf ~/Documents', 'L3'],
  ['rm -rf /', 'L3'],
  ['rm -rf ../something', 'L3'],
  ['git push --force origin main', 'L3'],
  ['git push -f origin main', 'L3'],
  ['git reset --hard HEAD~5', 'L3'],
  ['git clean -fd', 'L3'],
  ['git branch -D feature', 'L3'],
  ['sudo rm -f /etc/hosts', 'L3'],
  ['chmod -R 777 /var/www', 'L3'],
  ['shutdown -h now', 'L3'],
  ['npm publish', 'L3'],
  ['kill -9 1234', 'L3'],
  ['dd if=/dev/zero of=/dev/disk2', 'L3'],
  ['shred -u ~/secret.txt', 'L3'],
  ['srm -rf ~/Photos', 'L3'],
]);

// ── 3. 要问但不解锁（L2）─────────────────────────────────────
tierCases('[3] 需要确认（L2）', [
  ['git push origin main', 'L2'],
  ['gh pr create --title x', 'L2'],
  ['wrangler deploy', 'L2'],
  ['ssh host uptime', 'L2'],
  ['curl -X POST https://x.com -d @f', 'L2'],
  ['docker push img', 'L2'],
  // 非递归删除单个文件：该问，但不该到「高危+解锁」那一档
  ['rm -f scripts/example.py', 'L2'],
  ['rm somefile.txt', 'L2'],
]);

// ── 4. 复合命令：危险段不能被无害段「稀释」─────────────────
console.log('\n[4] 复合命令的整体档位取最危险的那一段');
{
  const cases = [
    ['cd ~ && rm -rf ~/Documents', 'L3'],
    ['cd ~ && git push --force origin main', 'L3'],
    ['export X=1; sudo rm -f /etc/hosts', 'L3'],
    ['cd ~ && git push origin main', 'L2'],
    ['cd ~ && npm install', 'L1'],
    ['ls && cd /tmp', 'L0'],
  ];
  for (const [cmd, want] of cases) {
    const got = bash(cmd);
    check(`${want.padEnd(2)}  ${cmd.slice(0, 58)}`, got.tier === want,
      `实际 ${got.tier}（${got.why}）`);
  }
  // 管道里带个只读命令，不得把前面的危险命令降级
  check('`rm -rf ~/Documents` 与 `git push --force` 拼管道后仍为 L3',
    bash('git push --force origin main | tee /tmp/log').tier === 'L3',
    bash('git push --force origin main | tee /tmp/log').tier);
}

// ── 5. 只有 L2 / L3 才推送 ──────────────────────────────────
console.log('\n[5] needsApproval 的门槛');
for (const [cmd, shouldPush] of [
  ['ls', false], ['cd ~', false], ['approval test', false],
  ['rm -rf node_modules', false],
  ['git push origin main', true], ['rm -rf ~/Documents', true],
]) {
  const t = bash(cmd).tier;
  check(`${t.padEnd(2)} 推送=${shouldPush}  ${cmd}`, needsApproval(t) === shouldPush);
}

// ── 6. shell 控制流骨架：本身不推送，但循环体照常判定 ────────
// 实测踩到过：`for f in …; do …; done` 整体掉到「未能识别的命令」默认 L2 并推送。
// 循环 / 分支骨架是**最常见**的写法之一，这条不修，打扰预算会被持续消耗。
// 但修它有个必须钉死的边界：骨架绝不能把循环体里的危险命令洗白。
tierCases('[6] 循环 / 分支骨架本身不推送，循环体照常判定', [
  // 骨架 → 不推送
  ['for f in *; do echo "$f"; done', 'L0'],
  ['for f in /Users/x/*/settings.json; do echo "$f"; done', 'L0'],
  ['while read l; do echo "$l"; done', 'L0'],
  ['if [ -f x ]; then echo yes; fi', 'L0'],
  ['case $x in a) echo a;; esac', 'L0'],
  // 循环体里的危险命令 —— 必须仍然是 L3
  ['for f in *; do rm -rf ~/Documents; done', 'L3'],
  ['if [ -f x ]; then rm -rf /; fi', 'L3'],
  ['while true; do git push --force; done', 'L3'],
  ['for f in a; do shred -u ~/x; done', 'L3'],
  ['for f in a; do sudo true; done', 'L3'],
  // 循环体里的外部副作用 —— 必须仍然是 L2
  ['for f in *; do git push; done', 'L2'],
  ['for f in *; do ssh host uptime; done', 'L2'],
]);

// ── 7. 已知取舍：骨架 / 前缀会让「未被识别的命令」落到 L0 ──────
// 档位是「看哪一段命中了最高档的规则」，所以一条**完全没被任何规则认识**的命令，
// 只要前面有一段命中 L0 的骨架或前缀，整条就会落 L0。这个性质在
// `cd ~ && <未识别命令>` 上本来就存在，循环骨架只是把它延伸过去。
// 这里钉住它，是为了让后来的人知道这是**有意的取舍**（噪音优先），而不是漏判。
// 真要收紧，这两处必须一起改，否则就是拆东墙补西墙。
console.log('\n[7] 已知取舍：骨架 / 前缀会让「未被识别的命令」落到 L0');
for (const cmd of [
  'cd ~ && frobnicate "$f"',
  'for f in *; do frobnicate "$f"; done',
]) {
  const got = bash(cmd);
  check(`${got.tier}  ${cmd.slice(0, 50)}（L0 = 静默放过，见注释）`, got.tier === 'L0',
    `实际 ${got.tier}（${got.why}）`);
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}: ${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(fail ? 1 : 0);
