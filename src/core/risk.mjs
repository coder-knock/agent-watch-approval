// 风险分级引擎：把一次工具调用判成 L0 / L1 / L2 / L3。
// 设计取舍：宁可对「未知工具」保守到 L1（只记审计不打扰），
// 也不要把无害的读操作推到手表上 —— 打扰预算一旦被消耗完，整个方案就失效了。

export const TIERS = ['L0', 'L1', 'L2', 'L3'];

const tierIndex = (t) => TIERS.indexOf(t);

const READ_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'NotebookRead',
  'TaskList', 'TaskGet', 'TaskOutput', 'BashOutput', 'TodoRead',
]);

const LOCAL_WRITE_TOOLS = new Set([
  'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'TodoWrite',
  'TaskCreate', 'TaskUpdate',
]);

// 只有落在这些前缀下、且不带 --no-preserve-root 之类的 rm -rf，才算「常规清理」
const SAFE_RM_PREFIXES = [
  '/tmp/', '/private/tmp/', '/var/tmp/', '/var/folders/',
  'node_modules', 'dist', 'build', '.next', '.nuxt', '.turbo',
  '.cache', '.parcel-cache', 'coverage', '__pycache__', '.pytest_cache',
  'target/debug', 'target/release', '.venv/', 'venv/',
];

const L3 = [
  { re: /\bgit\s+push\b[^|;&]*(\s-f\b|\s--force\b|\s--force-with-lease\b)/i, why: '强制推送会重写远端历史' },
  { re: /\bgit\s+reset\s+--hard\b/i, why: '丢弃未提交改动，不可恢复' },
  { re: /\bgit\s+clean\s+-[a-z]*[fd]/i, why: '删除未跟踪文件，不可恢复' },
  { re: /\bgit\s+branch\s+-D\b/i, why: '强制删除分支' },
  { re: /\bdd\s+if=/i, why: '裸设备写入' },
  { re: /\bmkfs(\.|\s|$)/i, why: '格式化文件系统' },
  { re: /\bsudo\b/i, why: '提权执行' },
  { re: /\b(shutdown|reboot|halt)\b/i, why: '影响整机可用性' },
  { re: /\bchmod\s+(-[a-zA-Z]+\s+)*777\b/i, why: '开放全部权限' },
  { re: /:\(\)\s*\{.*\}\s*;?\s*:/, why: 'fork 炸弹' },
  { re: /(^|\s)>\s*\/dev\/(sd|disk|rdisk)/i, why: '直接覆盖块设备' },
  { re: /\b(DROP\s+TABLE|TRUNCATE\s+TABLE)\b/i, why: '破坏性数据库操作' },
  { re: /\bDELETE\s+FROM\b(?![^;]*\bWHERE\b)/i, why: '无 WHERE 的全表删除' },
  { re: /\bsecurity\s+(find-generic-password|delete-generic-password|delete-keychain)/i, why: '钥匙串凭据操作' },
  { re: /\b(rm|unlink)\b[^|;&]*\.(pem|key|p12|keystore)\b/i, why: '删除密钥材料' },
  // 安全擦除：比 rm 更彻底（rm 还有恢复工具可救，shred/srm 是刻意让数据不可恢复）。
  // 之前它们不在任何规则里，掉到 `unmatchedBashTier` 默认的 L2 —— 比 `rm -rf ~/Documents`
  // 的 L3 还低，方向是反的。
  { re: /\b(shred|srm)\b/i, why: '安全擦除，数据刻意不可恢复' },
  { re: /\bnpm\s+publish\b/i, why: '发布到公共仓库，无法撤回' },
  { re: /\b(kill|pkill|killall)\s+-9\b/i, why: '强杀进程' },
];

const L2 = [
  { re: /\bgit\s+push\b/i, why: '推送到远端仓库' },
  { re: /\bgit\s+(tag|remote\s+add|remote\s+set-url)\b/i, why: '改动远端配置' },
  { re: /\bgh\s+(pr|issue|release|repo|gist)\s+(create|edit|delete|close|merge|comment|upload)/i, why: '对 GitHub 产生外部副作用' },
  { re: /\bgh\s+api\b[^|;&]*(\s-X\s*(POST|PUT|PATCH|DELETE)|\s-f\b|\s-F\b|\s--field\b|\s--input\b)/i, why: 'GitHub API 写操作' },
  { re: /\b(wrangler|vercel|netlify|flyctl|railway|heroku)\b[^|;&]*\b(deploy|publish|release|destroy)\b/i, why: '发布到线上环境' },
  { re: /\bdocker\s+(push|rm|rmi|system\s+prune)/i, why: '镜像仓库或容器副作用' },
  { re: /\bcurl\b[^|;&]*(\s-X\s*(POST|PUT|PATCH|DELETE)|\s--data\b|\s-d\b|\s--upload-file|\s-T\b)/i, why: '向外部服务写入数据' },
  { re: /\bwget\b[^|;&]*--post/i, why: '向外部服务写入数据' },
  { re: /\b(aws|gcloud|az|aliyun|tccli)\b/i, why: '云平台操作' },
  { re: /\b(ssh|scp|sftp|rsync)\b/i, why: '跨主机操作' },
  { re: /\b(sendmail|mutt|mail\b)/i, why: '发送邮件' },
  { re: /\bnpm\s+(deprecate|unpublish|owner|access)\b/i, why: '影响已发布包' },
];

const L1 = [
  { re: /\bgit\s+(add|commit|checkout|switch|stash|restore|mv|rm|apply|merge|rebase)\b/i, why: '本地仓库可逆变更' },
  { re: /\b(mkdir|touch|cp|mv|ln|install\b)/i, why: '本地文件操作' },
  { re: /\b(npm|pnpm|yarn|bun)\s+(install|i|ci|add|remove|run|test)\b/i, why: '本地依赖或脚本' },
  { re: /\b(pip|pip3|conda|poetry|uv)\s+(install|add|remove|sync)\b/i, why: '本地依赖安装' },
  { re: /\bsed\s+-i\b/i, why: '就地修改文件' },
  // 本机确认网关自己的控制/自检工具。它是本地工具，最坏情况是改自己的白名单或配置，
  // 不该让「跑一次 approval test」就占一次打扰预算 —— 那正是 hook 生效后第一批噪音的来源。
  // 注意：它只能**撤销**放行，不能授予放行，所以放这一档不会变成后门。
  { re: /^\s*approval\b/i, why: '本机确认网关的控制与自检工具（本地）' },
  // 注意排除 -v / --version 这类纯查询，它们应该落到 L0
  { re: /\b(node|python3?|bun|deno|tsx|ruby|go|bash|sh|zsh)\b\s+(?!-)\S+/i, why: '执行本地脚本' },
];

const L0 = [
  { re: /^\s*(ls|pwd|cat|head|tail|wc|file|stat|du|df|which|whereis|whoami|id|date|uname|sw_vers|hostname|printenv|echo|printf|true|sleep)\b/i, why: '只读命令' },
  // shell 自身的状态操作：只影响当前这条复合命令的解释环境，不碰文件、不碰网络。
  // 缺了这条，`cd ~ && ...` 这种最常见的写法会掉到「未能识别的命令」默认 L2 并推送。
  { re: /^\s*(cd|export|unset|set|source|pushd|popd|false)\b/i, why: '切换目录 / 设置 shell 变量' },
  // 循环 / 分支的骨架关键字。它们本身不执行任何外部命令 —— 循环体在 splitSegments
  // 里已经是**独立的分段**，会各自参与判定，所以
  // `for f in *; do rm -rf ~/Documents; done` 依然判 L3。
  // 缺了这条，`for f in *; do … done` 这种最常见的写法会掉到「未能识别的命令」默认 L2
  // 并推送到手表 —— 实测确实被这样打扰过一次。
  { re: /^\s*(for|while|until|if|elif|then|else|case|esac|select|fi|done)\b/i, why: 'shell 控制流骨架（本身不执行命令）' },
  // 语法校验：只解析不执行。
  // `node --check x.mjs`、`bash -n script` 这类是改完代码后的标准动作，被当成 L2 推送纯属误伤。
  { re: /^\s*(bash|sh|zsh|dash)\s+-n\b/i, why: '语法校验（只解析不执行）' },
  { re: /^\s*node\s+--check\b/i, why: '语法校验（只解析不执行）' },
  { re: /^\s*python3?\s+-m\s+py_compile\b/i, why: '语法校验（只编译不执行）' },
  { re: /\bgit\s+(status|log|diff|show|branch|remote\s*-?v?|describe|rev-parse|config\s+--get|stash\s+list|blame|ls-files)\b/i, why: 'git 只读子命令' },
  { re: /^\s*(rg|grep|fd|find|sed|awk|jq|sort|uniq|cut|tr|diff|comm|tree|md5|shasum)\b/i, why: '本地检索与文本处理' },
  { re: /\b(curl|wget)\b(?![^|;&]*(\s-X\s*(POST|PUT|PATCH|DELETE)|\s--data\b|\s-d\b|\s--upload-file|\s-T\b|\s--post))/i, why: '仅读取远端内容' },
  { re: /\bgh\s+(api|pr\s+view|pr\s+list|pr\s+diff|issue\s+view|issue\s+list|run\s+(view|list)|auth\s+status|repo\s+view)\b/i, why: 'GitHub 只读查询' },
  { re: /^\s*(node|npm|pnpm|python3?|git)\s+(-v|--version)\s*$/i, why: '查看版本' },
  { re: /^\s*(lsof|ps|top|netstat|ss|vm_stat|ioreg)\b/i, why: '查看进程与系统状态' },
];

function extractRmTargets(cmd) {
  const m = cmd.match(/\brm\b\s+((?:-[a-zA-Z-]+\s+)*)(.+)$/i);
  if (!m) return { targets: [], recursive: false, force: false };
  const flags = m[1] || '';
  const rest = m[2] || '';
  const targets = rest
    .split(/\s+/)
    .map((s) => s.replace(/^['"]|['"]$/g, ''))
    .filter((s) => s && !s.startsWith('-') && !s.startsWith('$'));
  return { targets, recursive: /r/i.test(flags), force: /f/i.test(flags) };
}

// rm 是否属于「常规清理」：全部目标都在安全前缀下，且没有 HOME / 根目录 / 变量展开
function isRoutineRm(cmd) {
  const { targets } = extractRmTargets(cmd);
  if (!targets.length) return false;
  return targets.every((t) => {
    if (/^(\/|~|\.\.|\*)$/.test(t)) return false;
    if (t.includes('$')) return false;
    const norm = t.replace(/^\.\//, '');
    return SAFE_RM_PREFIXES.some((p) => norm.startsWith(p) || norm.includes('/' + p));
  });
}

// 剥掉循环 / 分支的起始关键字，让「循环体」按它自己的命令参与判定。
// 不剥的话 `for f in *; do rm -rf ~/Documents; done` 里的 `do rm -rf …`
// 会带着 `do ` 前缀去比对规则 —— 目前仍能命中，但那是靠 `\brm\b` 恰好不锚行首。
// 先把脚手架拿掉，规则以后怎么改都不会漏。
const SCAFFOLD_LEAD = /^(?:do|then|else)\s+/i;

function splitSegments(cmd) {
  return cmd
    .split(/\s*(?:&&|\|\||;|\||\n)\s*/)
    .map((s) => s.trim())
    .map((s) => s.replace(SCAFFOLD_LEAD, '').trim())
    .filter(Boolean);
}

function matchRules(segments, rules) {
  for (const seg of segments) {
    for (const r of rules) {
      if (r.re.test(seg)) return r.why;
    }
  }
  return null;
}

function compileExtra(patterns) {
  return (patterns || []).map((p) => ({
    re: new RegExp(typeof p === 'string' ? p : p.re, typeof p === 'string' ? 'i' : p.flags || 'i'),
    why: typeof p === 'string' ? '自定义规则命中' : p.why || '自定义规则命中',
  }));
}

/**
 * @param {string} toolName
 * @param {object} toolInput
 * @param {object} cfg  config.risk
 * @returns {{tier: string, why: string}}
 */
export function classify(toolName, toolInput, cfg = {}) {
  const forced = cfg.forceTierByTool || {};
  if (forced[toolName] && TIERS.includes(forced[toolName])) {
    return { tier: forced[toolName], why: '按配置强制指定' };
  }

  if (toolName === 'Bash' || toolName === 'BashOutput') {
    const cmd = String((toolInput && (toolInput.command || toolInput.cmd)) || '');
    if (!cmd.trim()) return { tier: 'L2', why: '无法解析命令内容' };

    const segments = splitSegments(cmd);
    const l3 = [...L3, ...compileExtra(cfg.extraL3Patterns)];
    const l2 = [...L2, ...compileExtra(cfg.extraL2Patterns)];
    const l1 = L1;
    const l0 = [...L0, ...compileExtra(cfg.extraL0Patterns)];

    const hit3 = matchRules(segments, l3);
    if (hit3) return { tier: 'L3', why: hit3 };

    const rmSegments = segments.filter((s) => /\brm\b/i.test(s));
    if (rmSegments.length) {
      const allRoutine = rmSegments.every(isRoutineRm);
      if (!allRoutine) {
        // 递归删除一次性误伤一大片，且不可恢复 → L3
        const recursive = rmSegments.some((s) => extractRmTargets(s).recursive);
        if (recursive) {
          return { tier: 'L3', why: '递归删除，且目标不在常规清理目录内' };
        }
        // 非递归删除单个文件：该问，但不该到「高危 + 要解锁」那一档。
        // （这里原先不看 recursive 标志，于是 `rm -f 单个文件` 也报「递归删除」，
        //   提示语和实际规则对不上；agent 清理一个临时文件就会触发 L3。）
        return { tier: 'L2', why: '删除文件，且目标不在常规清理目录内' };
      }
      const hit2 = matchRules(segments.filter((s) => !/\brm\b/i.test(s)), l2);
      if (hit2) return { tier: 'L2', why: hit2 };
      return { tier: 'L1', why: '常规清理（构建产物 / 缓存目录）' };
    }

    const hit2 = matchRules(segments, l2);
    if (hit2) return { tier: 'L2', why: hit2 };

    const hit1 = matchRules(segments, l1);
    if (hit1) return { tier: 'L1', why: hit1 };

    const hit0 = matchRules(segments, l0);
    if (hit0) return { tier: 'L0', why: hit0 };

    return { tier: cfg.unmatchedBashTier || 'L2', why: '未能识别的命令' };
  }

  if (READ_TOOLS.has(toolName)) return { tier: 'L0', why: '只读工具' };
  if (LOCAL_WRITE_TOOLS.has(toolName)) return { tier: 'L1', why: '本地可逆写入' };

  if (/(send|post|upload|deploy|publish|push|create|delete|destroy|remove|update|write|execute|exec|run|merge|close|pay|purchase|transfer)/i.test(toolName)) {
    return { tier: 'L2', why: '工具名含外部副作用语义' };
  }

  return { tier: cfg.unknownToolTier || 'L1', why: '未知工具，按配置处理' };
}

export function needsApproval(tier) {
  return tierIndex(tier) >= tierIndex('L2');
}

export function defaultTtl(tier, ttlCfg) {
  return (ttlCfg && ttlCfg[tier]) || 300;
}
