// src/services/githubService.ts
//
// GitHub 备份仓库接入（架构 v3.0 §9）：只负责「怎么打到 GitHub 上去」。
// 签名里只出现字符串与字节数组，不碰数据库（§9.1 / §9.8）——settings
// 读取、backupLogs 写入、清脏全部归 backupService。本模块的调用形态：
//   - pushBackupZip()：§9.3 完整推送序列（查仓库 → 建仓 → 查同名文件 →
//     分片上传），§9.4 冲突重试（ref 更新冲突三次 / 文件名 -2~-9 八次额度）。
//   - AJ-A Q1：推送从 Contents API 单文件整包 PUT 改为 Git Data API 流程
//     （分片建 blob → 组 tree(base_tree) → 建 commit → PATCH ref），每片
//     ≤10MB，从根上消除 38MB 级大包单请求（该形态曾被 GitHub 边缘统一回
//     401 Bad credentials，2026-10-09 用户日志实锤：同令牌小请求全过）。
//   - 八类错误分支（§9.5）每类落到 GithubServiceError：中文用户文案 +
//     可重试语义 + 日志文案（「HTTP 状态码 + 一句人话」，不塞响应体）。
//   - listRemoteBackups / downloadBackupZip：恢复侧。分片组（.partNNN）按
//     序拼接还原，旧单文件 zip 格式继续兼容（AJ-A Q1 恢复侧改造）。
// 网络层抽象为可注入 fetch（FetchLike），自测用 mock 覆盖各分支，服务层
// 本身不做任何真实网络调用（真实联调在下游任务）。
//
// PAT 只经参数透传给 Authorization 头，绝不进日志、不进错误对象。

/** 可注入的网络层：默认用全局 fetch（浏览器 / Node 皆可），自测注入 mock。 */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** 睡眠注入：建仓轮询的 1s 间隔。自测注入空实现避免真实等待。 */
export type SleepLike = (ms: number) => Promise<void>;

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// §9.2 常量
const API_BASE = 'https://api.github.com';
const API_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
} as const;

/** §9.5：本工程备份包单包上限 80 MB（PRD 唯一口径）。 */
export const MAX_BACKUP_ZIP_BYTES = 80 * 1024 * 1024;

/**
 * AJ-A Q1：Git Data API 分片推送的单片体积上限（10 MB）。
 * 根因收敛：Contents API 单文件整包 PUT 在 38 MB 级别稳定 401（同令牌小请求
 * 全过、仅大包 PUT 被拒，2026-10-09 11:16/11:17 用户日志实锤），官方对
 * >1MB 文件本就建议走 Git Data API。改造后每片 ≤10MB（base64 后约 13.7MB
 * 请求体），从根上消除大包单请求。
 */
export const GH_SHARD_BYTES = 10 * 1024 * 1024;

/**
 * AJ-A Q1：把 zip 字节按 shardSize 切片（末片为余量）。
 * 空包 → 单个空片（保证至少一片，commit 结构恒定）。
 * 80MB 上限下最多 8 片（part001 … part008），三位序号余量充足。
 */
export function shardZipBytes(bytes: Uint8Array, shardSize: number = GH_SHARD_BYTES): Uint8Array[] {
  if (bytes.byteLength === 0) return [new Uint8Array(0)];
  const shards: Uint8Array[] = [];
  for (let i = 0; i < bytes.byteLength; i += shardSize) {
    shards.push(bytes.subarray(i, Math.min(i + shardSize, bytes.byteLength)));
  }
  return shards;
}

/** AJ-A Q1：分片文件在仓库内的落点（backups/<filename>.partNNN，NNN 三位零填充）。 */
export function shardPartPath(filename: string, partNo: number): string {
  return `backups/${filename}.part${String(partNo).padStart(3, '0')}`;
}

/** 建仓后仓库就绪的轮询参数（§9.3 ②）。 */
const REPO_READY_POLL_MAX = 5;
const REPO_READY_POLL_INTERVAL_MS = 1000;

/** §9.4：409 并发冲突的完整重试（③→④）次数上限。 */
const CONFLICT_RETRY_MAX = 3;

/** §9.4：同名文件 -2 ~ -9 的总额度（8 次追加机会）。 */
const FILENAME_SUFFIX_MAX = 9;

/** 第 ①–③ 步的默认超时；第 ④ 步上传单独用 120 秒（§9.5）。 */
export const GH_TIMEOUT_MS = 30000;
export const GH_UPLOAD_TIMEOUT_MS = 120000;

// ============================ 错误模型（§9.5） ============================

/**
 * 八类错误分支的统一载体。`message` 是用户可见中文文案；`retryable`
 * 是可重试语义（UI 决定是否给「重试」按钮）；`logMessage` 是写进
 * backupLogs 的文案，形态「Github 推送失败（401）：令牌无效或已过期」
 * ——HTTP 状态码 + 一句人话，绝不包含响应体与令牌。
 *
 * AI-A Q3 诊断字段（均可选，由错误来源填充）：
 * - `status`：HTTP 状态码（网络层失败 / 未发请求时缺失）。
 * - `detail`：GitHub 返回的 message 原文摘要（≤80 字符；无响应体时缺失）。
 * - `diagnostic`：pushBackupZip 收尾统一拼装的可定位诊断串（时间 / HTTP
 *   状态 / GitHub 返回摘要 / 令牌前 4 位标识 / 包大小 / 同序列前步证据），
 *   追加在 message 与 logMessage 尾部——用户把完整提示发回来即可定位。
 *   令牌只允许出现前 4 位标识，完整令牌绝不进任何字段（沿用 §9.1 口径）。
 */
export class GithubServiceError extends Error {
  readonly retryable: boolean;
  readonly logMessage: string;
  readonly status?: number;
  readonly detail?: string;
  readonly diagnostic?: string;

  constructor(
    userMessage: string,
    retryable: boolean,
    logMessage: string,
    extra?: { status?: number; detail?: string; diagnostic?: string },
  ) {
    super(userMessage);
    this.name = 'GithubServiceError';
    this.retryable = retryable;
    this.logMessage = logMessage;
    if (extra?.status !== undefined) this.status = extra.status;
    if (extra?.detail !== undefined) this.detail = extra.detail;
    if (extra?.diagnostic !== undefined) this.diagnostic = extra.diagnostic;
  }
}

// ============================ §9.3 基础工具 ============================

/**
 * `content` 必须是 base64。对几十万字节的数组直接
 * `btoa(String.fromCharCode(...bytes))` 会栈溢出，分块转换（§9.3 细节 3）。
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** 超时包装（§9.5）：AbortController，到期 abort。 */
async function ghFetch(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** §9.3 细节 4：commit message 用本地时区，格式 `backup: YYYY-MM-DD HH:mm`（DM §5.9 六）。 */
export function formatCommitMessage(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const y = String(now.getFullYear());
  const mo = pad(now.getMonth() + 1);
  const d = pad(now.getDate());
  const h = pad(now.getHours());
  const mi = pad(now.getMinutes());
  return `backup: ${y}-${mo}-${d} ${h}:${mi}`;
}

// ============================ §9.5 错误分类 ============================

interface GithubErrorBody {
  message?: unknown;
  errors?: Array<{ field?: unknown; message?: unknown }>;
}

async function readErrorBody(res: Response): Promise<GithubErrorBody> {
  try {
    const body: unknown = await res.json();
    if (body !== null && typeof body === 'object') return body as GithubErrorBody;
  } catch {
    // 响应体不是 JSON（如网关 HTML 错误页）——按空体处理，不影响状态码分类。
  }
  return {};
}

function firstErrorMessage(body: GithubErrorBody): string {
  const e = body.errors?.[0];
  if (e !== undefined && typeof e.message === 'string' && e.message.length > 0) return e.message;
  if (typeof body.message === 'string' && body.message.length > 0) return body.message;
  return '';
}

/**
 * §9.5 通用状态码分支（网络层异常由调用处 catch 后转 classifyNetworkError）。
 * - opaque 响应（res.type === 'opaque'，status 恒 0）：归入「网络中断」分支
 *   （S6-fix P2-3：不透明响应不是 GitHub 的业务答复，落入通用状态码分支
 *   会产出误导性的「请求失败（0）」日志）
 * - 401：令牌无效或已过期（不可重试）
 * - 403：限流（x-ratelimit-remaining === '0'，可重试）/ 权限不足（不可重试）
 * - 其余未显式分类的状态：可重试，文案带状态码
 *
 * verb 区分推送 / 拉取两条序列的日志前缀（用户文案不变）。
 */
async function classifyStatusError(
  res: Response,
  context: string,
  verb: '推送' | '拉取' = '推送',
): Promise<GithubServiceError> {
  // P2-3：opaque 响应（no-cors 等场景）status 为 0，显式归入网络中断分支。
  if (res.type === 'opaque') {
    return new GithubServiceError(
      '网络连接中断，请检查网络后重试',
      true,
      `Github ${verb}失败（网络中断）：网络连接中断（不透明响应）`,
    );
  }
  const body = await readErrorBody(res);
  if (res.status === 401) {
    const detail = firstErrorMessage(body);
    return new GithubServiceError(
      'GitHub 令牌无效或已过期，请到设置页重新填写',
      false,
      `Github ${verb}失败（401）：令牌无效或已过期（${context}）`,
      { status: 401, detail: detail.slice(0, 80) || undefined },
    );
  }
  if (res.status === 403) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining === '0') {
      return new GithubServiceError(
        'GitHub 请求过于频繁，请稍后再试',
        true,
        `Github ${verb}失败（403）：请求过于频繁（限流剩余 0，${context}）`,
        { status: 403 },
      );
    }
    // AH-A Q7：403 权限不足文案细化——同时覆盖 classic PAT 与 fine-grained PAT
    // 两种令牌类型的权限要求（与测试连接共用 TOKEN_FORBIDDEN_HINT）。
    return new GithubServiceError(
      TOKEN_FORBIDDEN_HINT,
      false,
      `Github ${verb}失败（403）：令牌权限不足（限流剩余 ${remaining ?? '未知'}，${context}）`,
      { status: 403 },
    );
  }
  const detail = firstErrorMessage(body);
  const suffix = detail.length > 0 ? `：${detail.slice(0, 80)}` : '';
  return new GithubServiceError(
    `GitHub 请求失败（${res.status}），请稍后重试`,
    true,
    `Github ${verb}失败（${res.status}）${suffix}`,
    { status: res.status, detail: detail.slice(0, 80) || undefined },
  );
}

/**
 * §9.5 #7 / #8：网络中断（TypeError / opaque）与超时（AbortError）。
 * W-A 设置2：补 verb 参数——拉取序列的网络失败日志此前误标「推送」，
 * 用户文案不变，仅日志前缀按序列区分（口径变更 #2）。
 */
export function classifyNetworkError(err: unknown, verb: '推送' | '拉取' = '推送'): GithubServiceError {
  if (err instanceof Error && err.name === 'AbortError') {
    return new GithubServiceError(
      '请求超时，网络较慢时请稍后重试',
      true,
      `Github ${verb}失败（超时）：请求超时`,
    );
  }
  return new GithubServiceError(
    '网络连接中断，请检查网络后重试',
    true,
    `Github ${verb}失败（网络中断）：网络连接中断`,
  );
}

// ============================ 响应体读取的归类包装（W-A 设置2） ============================
//
// 复现结论（wa-repro，基线代码）：Safari 弱网下响应体读取（res.json() /
// res.arrayBuffer()）抛出的 TypeError("Load failed") 不经过 ghFetch 的
// .catch(classifyNetworkError)，会以原生英文文案直出到 UI toast（用户
// 2026-09-28 报障的「Load failed」即此路径，最典型是 zip 下载中途断流）。
// 以下两个包装把所有响应体读取失败统一归入 §9.5 分类，原生文案不再外抛。

/**
 * 读 JSON 响应体：网络层断流（TypeError，Safari "Load failed" / Chrome
 * "Failed to fetch"）与超时（AbortError）归网络中断/超时；其余（如网关
 * 返回非 JSON 体的 SyntaxError）归「响应无法解析」——都不外抛原生文案。
 */
async function readJsonSafe<T>(res: Response, context: string, verb: '推送' | '拉取'): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof TypeError || (err instanceof Error && err.name === 'AbortError')) {
      throw classifyNetworkError(err, verb);
    }
    throw new GithubServiceError(
      'GitHub 返回了无法解析的响应，请稍后重试',
      true,
      `Github ${verb}失败（响应）：响应体无法解析（${context}）`,
    );
  }
}

/** 读二进制响应体：唯一失败形态是网络层断流/超时，统一归 classifyNetworkError。 */
async function readArrayBufferSafe(res: Response, verb: '推送' | '拉取'): Promise<ArrayBuffer> {
  try {
    return await res.arrayBuffer();
  } catch (err) {
    throw classifyNetworkError(err, verb);
  }
}

/** §9.5 #6：422 的两个子分支（too_large / already exists）。 */
async function classifyUnprocessableEntity(res: Response, context: string): Promise<GithubServiceError> {
  const body = await readErrorBody(res);
  const raw = firstErrorMessage(body);
  const field = body.errors?.[0]?.field;
  const isTooLarge =
    (typeof field === 'string' && field === 'content') ||
    raw.includes('too_large') ||
    raw.includes('too large');
  if (isTooLarge) {
    return new GithubServiceError(
      '备份包过大，超过 80 MB 上限，请减少图片或分批备份',
      false,
      `Github 推送失败（422）：备份包过大${raw.length > 0 ? `（${raw.slice(0, 80)}）` : ''}（${context}）`,
      { status: 422, detail: raw.slice(0, 80) || undefined },
    );
  }
  if (raw.includes('already exists')) {
    return new GithubServiceError(
      '仓库名已被占用，请换一个名字',
      false,
      `Github 推送失败（422）：仓库名已被占用${raw.length > 0 ? `（${raw.slice(0, 80)}）` : ''}（${context}）`,
      { status: 422, detail: raw.slice(0, 80) || undefined },
    );
  }
  return new GithubServiceError(
    'GitHub 拒绝了这次请求（422），请检查备份内容',
    false,
    `Github 推送失败（422）${raw.length > 0 ? `：${raw.slice(0, 80)}` : ''}（${context}）`,
  );
}

// ============================ §9.3 推送序列 ============================

export interface GithubPushArgs {
  /** PAT。只进 Authorization 头，绝不进日志 / 错误对象 / 返回值。 */
  token: string;
  owner: string;
  repo: string;
  /** 基础文件名（无 -n 后缀），形如 `sewing-space-backup-20250407-0930.zip`。 */
  filename: string;
  zipBytes: Uint8Array;
  /** 注入网络层；缺省用全局 fetch。 */
  fetchImpl?: FetchLike;
  /** 注入睡眠；缺省真实 setTimeout。 */
  sleepImpl?: SleepLike;
  /** commit message 的本地时刻；缺省 new Date()。 */
  now?: () => Date;
}

export interface GithubPushResult {
  /** 实际推送目标分支（读 GET repo 的 default_branch，不硬编码 main）。 */
  branch: string;
  /** 新 commit 的完整 sha。 */
  commitSha: string;
  /** 实际写入的文件名（带 -n 后缀时为追加后的名字）。 */
  filename: string;
  /** AJ-A Q1：实际推送的分片数（≥1；每片 ≤10MB，见 GH_SHARD_BYTES）。 */
  parts: number;
}

interface RepoJson {
  default_branch?: unknown;
}

interface BlobJson {
  sha?: unknown;
}

interface RefJson {
  object?: { sha?: unknown };
}

interface GitCommitJson {
  sha?: unknown;
  tree?: { sha?: unknown };
}

interface TreeCreateJson {
  sha?: unknown;
}

/**
 * §9.3 完整推送序列。任一步失败抛 GithubServiceError（§9.5 分类）。
 * 本函数不写库、不写日志——收尾（日志 + 清脏 + backup_last_success）
 * 归 backupService.pushToGithub。
 */
export async function pushBackupZip(args: GithubPushArgs): Promise<GithubPushResult> {
  const doFetch: FetchLike = args.fetchImpl ?? ((url, init) => fetch(url, init));
  const sleep: SleepLike = args.sleepImpl ?? defaultSleep;
  const now = args.now ?? (() => new Date());

  if (args.token === '' || args.owner === '' || args.repo === '') {
    throw new GithubServiceError(
      'GitHub 备份未配置完整，请到设置页填写令牌、用户名与仓库名',
      false,
      'Github 推送失败（配置）：令牌、用户名或仓库名为空',
    );
  }

  // §9.5 前置检查：体积超限直接报错，不发请求。
  if (args.zipBytes.byteLength > MAX_BACKUP_ZIP_BYTES) {
    throw new GithubServiceError(
      '备份包过大，超过 80 MB 上限，请减少图片或分批备份',
      false,
      `Github 推送失败（422）：备份包过大（本地前置检查，${args.zipBytes.byteLength} 字节）`,
    );
  }

  const authHeaders = {
    ...API_HEADERS,
    Authorization: `Bearer ${args.token}`,
  };

  // AI-A Q3：同序列「已用当前令牌成功过的步骤」清单——401 出现在这些步骤
  // 之后时，令牌本身在数秒前刚被 GitHub 接受过，文案不应断言「令牌无效」
  // （用户备份日志实锤：10-05 推送成功、10-07/10-08 多次 401 均落在
  // 「上传备份文件」PUT 这步，而同序列前置 GET（查仓库/查同名文件）全过）。
  const authOkSteps: string[] = [];

  // AI-A Q3：诊断拼装（时间 / HTTP 状态 / GitHub 返回摘要 / 令牌前 4 位
  // 标识 / 包大小）。令牌只允许前 4 位进诊断串，完整令牌绝不进任何字段。
  const buildDiagnostic = (err: GithubServiceError): string => {
    const d = now();
    const hhmmss = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    const sizeMb = (args.zipBytes.byteLength / (1024 * 1024)).toFixed(1);
    const tokenHint = args.token.length > 0 ? `${args.token.slice(0, 4)}…` : '（空）';
    const parts = [
      `诊断 ${hhmmss}`,
      `HTTP ${err.status ?? '—'}`,
      `GitHub 返回：${err.detail ?? '（无响应体）'}`,
      `令牌标识 ${tokenHint}`,
      `包 ${sizeMb}MB`,
    ];
    if (err.status === 401 && authOkSteps.length > 0) {
      parts.push(`同序列已用该令牌成功：${authOkSteps.join('、')}`);
    }
    return `【${parts.join(' · ')}】`;
  };

  const runPushSequence = async (): Promise<GithubPushResult> => {

  const getRepo = async (): Promise<Response> =>
    ghFetch(doFetch, `${API_BASE}/repos/${args.owner}/${args.repo}`, {
      method: 'GET',
      headers: authHeaders,
    }, GH_TIMEOUT_MS);

  const readDefaultBranch = async (res: Response): Promise<string> => {
    // W-A 设置2：响应体读取走归类包装，断流（Safari "Load failed"）不再直出。
    const body = await readJsonSafe<RepoJson>(res, '查询仓库', '推送');
    return typeof body.default_branch === 'string' && body.default_branch.length > 0
      ? body.default_branch
      : 'main';
  };

  // ---------- ① 查仓库（404 → ② 建仓） ----------
  let branch: string;
  const firstRepo = await getRepo().catch((err: unknown) => {
    throw classifyNetworkError(err);
  });
  if (firstRepo.status === 200) {
    authOkSteps.push('查仓库'); // AI-A Q3：同序列令牌有效证据
    branch = await readDefaultBranch(firstRepo);
  } else if (firstRepo.status === 404) {
    // ② 建仓：public + auto_init（§9.3）
    const createRes = await ghFetch(doFetch, `${API_BASE}/user/repos`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: args.repo,
        private: false,
        description: '缝纫空间备份仓库（自动创建）',
        auto_init: true,
      }),
    }, GH_TIMEOUT_MS).catch((err: unknown) => {
      throw classifyNetworkError(err);
    });
    if (createRes.status === 201) {
      // 建仓是异步的：轮询 ① 最多 5 次、每次间隔 1s（§9.3 ②）。
      let ready: Response | undefined;
      for (let i = 0; i < REPO_READY_POLL_MAX; i++) {
        await sleep(REPO_READY_POLL_INTERVAL_MS);
        const poll = await getRepo().catch((err: unknown) => {
          throw classifyNetworkError(err);
        });
        if (poll.status === 200) {
          ready = poll;
          break;
        }
        if (poll.status !== 404) {
          throw await classifyStatusError(poll, '建仓后就绪轮询');
        }
      }
      if (ready === undefined) {
        throw new GithubServiceError(
          '仓库创建后未就绪，请稍后重试',
          true,
          `Github 推送失败（404）：仓库创建后未就绪（已轮询 ${REPO_READY_POLL_MAX} 次）`,
        );
      }
      branch = await readDefaultBranch(ready);
    } else if (createRes.status === 422) {
      throw await classifyUnprocessableEntity(createRes, '创建仓库');
    } else {
      throw await classifyStatusError(createRes, '创建仓库');
    }
  } else {
    throw await classifyStatusError(firstRepo, '查询仓库');
  }

  // ---------- ③ 同名冲突检查（§9.4 文件名 -2 ~ -9 额度，一次完成） ----------
  // AJ-A Q1：推送改为分片格式（backups/<filename>.partNNN），同名判定同时查
  // 新分片格式的 part001 与旧单文件格式的同名 zip——两者任一存在都算占用，
  // 避免仓库里出现「旧单文件 zip 与新分片组同名并列」的歧义（恢复列表按名
  // 取最新，同名并列无法分辨）。
  const commitMessage = formatCommitMessage(now());
  let filename = args.filename;
  {
    let nameAvailable = false;
    for (let suffix = 1; suffix <= FILENAME_SUFFIX_MAX; suffix++) {
      let occupied = false;
      for (const checkPath of [`backups/${filename}`, shardPartPath(filename, 1)]) {
        const check = await ghFetch(
          doFetch,
          `${API_BASE}/repos/${args.owner}/${args.repo}/contents/${checkPath}`,
          { method: 'GET', headers: authHeaders },
          GH_TIMEOUT_MS,
        ).catch((err: unknown) => {
          throw classifyNetworkError(err);
        });
        if (check.status === 404) continue;
        if (check.status === 200) {
          occupied = true;
          authOkSteps.push('查同名文件'); // AI-A Q3：同序列令牌有效证据
          continue;
        }
        throw await classifyStatusError(check, '查询同名文件');
      }
      if (!occupied) {
        nameAvailable = true;
        break;
      }
      if (suffix === FILENAME_SUFFIX_MAX) {
        throw new GithubServiceError(
          '同名备份文件过多，请稍后重试',
          true,
          `Github 推送失败（同名冲突）：同名备份文件过多（已试到 -${FILENAME_SUFFIX_MAX}）`,
        );
      }
      const base = args.filename.replace(/\.zip$/, '');
      filename = `${base}-${suffix + 1}.zip`;
    }
    if (!nameAvailable) {
      // 防御性兜底：上面循环要么 break 要么 throw，理论不可达。
      throw new GithubServiceError(
        '同名备份文件过多，请稍后重试',
        true,
        `Github 推送失败（同名冲突）：同名备份文件过多（已试到 -${FILENAME_SUFFIX_MAX}）`,
      );
    }
  }

  // ---------- ④ 分片上传 blob（Git Data API，每片 ≤10MB 单请求） ----------
  // blob 按 sha 寻址、内容寻址幂等：同一片重传返回同一 sha，冲突重试（⑤）
  // 不需要重传 blob。每片单独 POST，请求体 ≤10MB×1.37（base64 膨胀），
  // 彻底消除 38MB 级大包单请求（AJ-A Q1 根因）。
  const shards = shardZipBytes(args.zipBytes);
  const blobShas: string[] = [];
  for (let i = 0; i < shards.length; i++) {
    const shard = shards[i] as Uint8Array;
    const blobRes = await ghFetch(
      doFetch,
      `${API_BASE}/repos/${args.owner}/${args.repo}/git/blobs`,
      {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ content: bytesToBase64(shard), encoding: 'base64' }),
      },
      GH_UPLOAD_TIMEOUT_MS,
    ).catch((err: unknown) => {
      throw classifyNetworkError(err);
    });
    if (blobRes.status === 422) {
      // 422 细分（§9.5 #6）：too_large（分片超限，理论不该出现——单片
      // ≤10MB 远低于 GitHub 上限，出现即配额类问题）/ 其余 422 统一拒绝。
      throw await classifyUnprocessableEntity(blobRes, `上传备份分片（第 ${i + 1} 片）`);
    }
    if (blobRes.status !== 201) {
      throw await classifyStatusError(blobRes, `上传备份分片（第 ${i + 1} 片）`);
    }
    const blobBody = await readJsonSafe<BlobJson>(blobRes, `上传备份分片（第 ${i + 1} 片）`, '推送');
    const blobSha = blobBody.sha;
    if (typeof blobSha !== 'string' || blobSha.length === 0) {
      throw new GithubServiceError(
        '推送已提交分片，但 GitHub 未返回分片标识，请重试',
        true,
        `Github 推送失败（响应）：blob 响应里缺少 sha（第 ${i + 1} 片）`,
      );
    }
    blobShas.push(blobSha);
    authOkSteps.push('上传分片'); // AJ-A Q1：同序列令牌有效证据（分片级）
  }

  // ---------- ⑤ 组 tree → commit → 更新 ref（§9.4 冲突完整重试，最多 3 次） ----------
  // 并发推送冲突的形态从 Contents PUT 409 变为 PATCH ref 422（non-fast-forward）：
  // 有并发提交把 ref 推进了，重读 ref 重建 tree/commit 再更新即可（blob 不必重传）。
  const treeEntries = blobShas.map((sha, i) => ({
    path: shardPartPath(filename, i + 1),
    mode: '100644',
    type: 'blob',
    sha,
  }));

  for (let round = 1; round <= CONFLICT_RETRY_MAX; round++) {
    // ⑤-1 读分支引用 → 基线 commit sha。
    const refRes = await ghFetch(
      doFetch,
      `${API_BASE}/repos/${args.owner}/${args.repo}/git/ref/heads/${encodeURIComponent(branch)}`,
      { method: 'GET', headers: authHeaders },
      GH_TIMEOUT_MS,
    ).catch((err: unknown) => {
      throw classifyNetworkError(err);
    });
    if (refRes.status === 404) {
      throw new GithubServiceError(
        '备份仓库的分支不存在，请到设置页重新连接',
        true,
        'Github 推送失败（404）：分支不存在',
      );
    }
    if (refRes.status !== 200) {
      throw await classifyStatusError(refRes, '读取分支引用');
    }
    const refBody = await readJsonSafe<RefJson>(refRes, '读取分支引用', '推送');
    const baseCommitSha = refBody.object?.sha;
    if (typeof baseCommitSha !== 'string' || baseCommitSha.length === 0) {
      throw new GithubServiceError(
        'GitHub 未返回分支指向的提交号，请稍后重试',
        true,
        'Github 推送失败（响应）：ref 响应里缺少 object.sha',
      );
    }
    authOkSteps.push('读分支引用'); // AJ-A Q1：同序列令牌有效证据

    // ⑤-2 读基线 commit 的 tree sha（base_tree：不指定会整树替换、丢掉仓库里
    // 其余文件，必须显式带上）。
    const baseCommitRes = await ghFetch(
      doFetch,
      `${API_BASE}/repos/${args.owner}/${args.repo}/git/commits/${baseCommitSha}`,
      { method: 'GET', headers: authHeaders },
      GH_TIMEOUT_MS,
    ).catch((err: unknown) => {
      throw classifyNetworkError(err);
    });
    if (baseCommitRes.status !== 200) {
      throw await classifyStatusError(baseCommitRes, '读取基线提交');
    }
    const baseCommitBody = await readJsonSafe<GitCommitJson>(baseCommitRes, '读取基线提交', '推送');
    const baseTreeSha = baseCommitBody.tree?.sha;
    if (typeof baseTreeSha !== 'string' || baseTreeSha.length === 0) {
      throw new GithubServiceError(
        'GitHub 未返回基线文件树，请稍后重试',
        true,
        'Github 推送失败（响应）：commit 响应里缺少 tree.sha',
      );
    }

    // ⑤-3 组 tree：base_tree = 基线树（保留仓库既有文件），新分片按序覆盖写入。
    const treeRes = await ghFetch(
      doFetch,
      `${API_BASE}/repos/${args.owner}/${args.repo}/git/trees`,
      {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries }),
      },
      GH_TIMEOUT_MS,
    ).catch((err: unknown) => {
      throw classifyNetworkError(err);
    });
    if (treeRes.status !== 201) {
      throw await classifyStatusError(treeRes, '创建文件树');
    }
    const treeBody = await readJsonSafe<TreeCreateJson>(treeRes, '创建文件树', '推送');
    const newTreeSha = treeBody.sha;
    if (typeof newTreeSha !== 'string' || newTreeSha.length === 0) {
      throw new GithubServiceError(
        'GitHub 未返回新文件树标识，请稍后重试',
        true,
        'Github 推送失败（响应）：tree 响应里缺少 sha',
      );
    }

    // ⑤-4 建 commit：parent = 基线 commit（快进链不断）。
    const commitRes = await ghFetch(
      doFetch,
      `${API_BASE}/repos/${args.owner}/${args.repo}/git/commits`,
      {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          message: commitMessage,
          tree: newTreeSha,
          parents: [baseCommitSha],
        }),
      },
      GH_TIMEOUT_MS,
    ).catch((err: unknown) => {
      throw classifyNetworkError(err);
    });
    if (commitRes.status !== 201) {
      throw await classifyStatusError(commitRes, '创建提交');
    }
    const commitBody = await readJsonSafe<GitCommitJson>(commitRes, '创建提交', '推送');
    const commitShaRaw = commitBody.sha;
    if (typeof commitShaRaw !== 'string' || commitShaRaw.length === 0) {
      throw new GithubServiceError(
        '推送已提交，但 GitHub 未返回提交号，请到仓库确认',
        true,
        'Github 推送失败（响应）：响应里缺少 commit.sha',
      );
    }
    // ⑤-5 更新 ref：422（non-fast-forward）→ 并发冲突，重试 ⑤ 整段。
    const patchRes = await ghFetch(
      doFetch,
      `${API_BASE}/repos/${args.owner}/${args.repo}/git/refs/heads/${encodeURIComponent(branch)}`,
      {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({ sha: commitShaRaw }),
      },
      GH_TIMEOUT_MS,
    ).catch((err: unknown) => {
      throw classifyNetworkError(err);
    });
    if (patchRes.status === 200) {
      authOkSteps.push('更新分支引用');
      return { branch, commitSha: commitShaRaw, filename, parts: shards.length };
    }
    if (patchRes.status === 422 || patchRes.status === 409) {
      // non-fast-forward（并发推送冲突）→ 重读 ref 重建整段（blob 已就位）。
      if (round === CONFLICT_RETRY_MAX) {
        throw new GithubServiceError(
          '推送冲突，请稍后重试',
          true,
          `Github 推送失败（409）：推送冲突（已重试 ${CONFLICT_RETRY_MAX} 次）`,
        );
      }
      continue;
    }
    if (patchRes.status === 404) {
      throw new GithubServiceError(
        '备份仓库的分支不存在，请到设置页重新连接',
        true,
        'Github 推送失败（404）：分支不存在',
      );
    }
    throw await classifyStatusError(patchRes, '更新分支引用');
  }

  // 循环正常走完仍未 return：只有冲突用尽配额才会到这里（上面 round===MAX 时已
  // throw，此行为防御性兜底，语义与冲突用尽一致）。
  throw new GithubServiceError(
    '推送冲突，请稍后重试',
    true,
    `Github 推送失败（409）：推送冲突（已重试 ${CONFLICT_RETRY_MAX} 次）`,
  );
  };

  // AI-A Q3：推送序列的统一收尾——任何 GithubServiceError 都拼上可定位诊断
  // （时间 / HTTP 状态 / GitHub 返回原文摘要 / 令牌前 4 位标识 / 包大小 /
  // 同序列令牌有效证据）后再上抛。用户下次失败把完整提示发回来即可定位，
  // 无需再靠猜。诊断串绝不包含完整令牌（仅前 4 位标识）。
  try {
    return await runPushSequence();
  } catch (e) {
    if (!(e instanceof GithubServiceError)) throw e;
    const diag = buildDiagnostic(e);
    // 证据改写：401 落在「上传备份文件」等后段步骤、而同序列前段 GET 已用
    // 同一令牌成功时，断言「令牌无效或已过期」与现场证据矛盾（真无效的令牌
    // 在第一步查仓库就会 401）。这形态更符合 GitHub 边缘节点 / 网络中间层对
    // 大包 PUT 的偶发拒绝——改口径为「疑似偶发拒绝，先重试」，避免用户被
    // 误导去反复重新生成令牌。
    let userMessage = e.message;
    let retryable = e.retryable;
    if (e.status === 401 && authOkSteps.length > 0) {
      userMessage = '本次推送被 GitHub 拒绝（401），但同一推送的前几步刚用该令牌成功过，'
        + '令牌大概率仍有效——疑似大包上传的偶发拒绝，请直接重试；'
        + '反复失败时请换个网络（如切 Wi-Fi / 流量）再推，或到设置页重新测试连接确认令牌';
      retryable = true;
    }
    throw new GithubServiceError(
      `${userMessage}（${diag}）`,
      retryable,
      `${e.logMessage}｜${diag}`,
      { status: e.status, detail: e.detail, diagnostic: diag },
    );
  }
}

// ============================ §9.6 拉取序列（S6-fix P0-1） ============================

/** §9.8：远端备份文件的元数据（只含 name / path / size / sha，不含内容）。 */
export interface RemoteFile {
  name: string;
  path: string;
  size: number;
  sha: string;
  /**
   * AJ-A Q1：分片数。新格式推送（Git Data API）在仓库里落成
   * `backups/<name>.part001 … .partNNN`，列表把它们聚合成一条（name 为组名
   * `<name>`，size 为各片之和，sha 取 part001）；旧单文件 zip 不带该字段。
   * downloadBackupZip 据此决定「按序下载 N 片拼接」还是「单文件整包」。
   */
  parts?: number;
}

/** AJ-A Q1：分片文件名的形态 `backups/<组名>.partNNN`（NNN 三位零填充）。 */
const SHARD_PART_NAME_RE = /^(.+\.zip)\.part(\d{3})$/;

/** §9.6 列表展示的最大条数（按 name 降序取前 20）。 */
export const REMOTE_BACKUPS_LIMIT = 20;

export interface GithubListArgs {
  /** PAT。只进 Authorization 头，绝不进日志 / 错误对象 / 返回值。 */
  token: string;
  owner: string;
  repo: string;
  /** 注入网络层；缺省用全局 fetch。 */
  fetchImpl?: FetchLike;
}

interface ContentsEntryJson {
  name?: unknown;
  path?: unknown;
  size?: unknown;
  sha?: unknown;
  type?: unknown;
}

/**
 * §9.6 第 ① 步：列出备份仓库 backups/ 目录下的备份文件。
 * 返回按 name 降序（文件名含 UTC 时间戳，字典序 = 时间序）的前 20 条，
 * 每条只含 {name, path, size, sha}。
 * - 先 GET /repos/{owner}/{repo} 读 default_branch（分支不硬编码，§12.3）
 * - 200 → 过滤出文件条目（type === 'file'）后排序截断
 * - 404（仓库或目录不存在）→「仓库里还没有备份文件」（§9.6 ① 的 404 分支：
 *   两种可能共用一句文案，文档原文如此）
 * - 其他 → §9.5 分支（verb 用「拉取」）
 * 本函数不写库、不写日志——收尾归 backupService。
 */
export async function listRemoteBackups(args: GithubListArgs): Promise<RemoteFile[]> {
  const doFetch: FetchLike = args.fetchImpl ?? ((url, init) => fetch(url, init));

  if (args.token === '' || args.owner === '' || args.repo === '') {
    throw new GithubServiceError(
      'GitHub 备份未配置完整，请到设置页填写令牌、用户名与仓库名',
      false,
      'Github 拉取失败（配置）：令牌、用户名或仓库名为空',
    );
  }

  const authHeaders = {
    ...API_HEADERS,
    Authorization: `Bearer ${args.token}`,
  };

  // 读 default_branch（与推送同一来源，不硬编码 main）。
  const repoRes = await ghFetch(
    doFetch,
    `${API_BASE}/repos/${args.owner}/${args.repo}`,
    { method: 'GET', headers: authHeaders },
    GH_TIMEOUT_MS,
  ).catch((err: unknown) => {
    throw classifyNetworkError(err, '拉取');
  });
  if (repoRes.status !== 200) {
    // 仓库不存在 / 仓库里还没有备份文件：§9.6 ① 404 分支的同一句文案。
    if (repoRes.status === 404) {
      throw new GithubServiceError(
        '仓库里还没有备份文件',
        false,
        'Github 拉取失败（404）：仓库里还没有备份文件',
      );
    }
    throw await classifyStatusError(repoRes, '查询仓库（拉取）', '拉取');
  }
  const branch = await readDefaultBranchOf(repoRes);

  const listRes = await ghFetch(
    doFetch,
    `${API_BASE}/repos/${args.owner}/${args.repo}/contents/backups?ref=${encodeURIComponent(branch)}`,
    { method: 'GET', headers: authHeaders },
    GH_TIMEOUT_MS,
  ).catch((err: unknown) => {
    throw classifyNetworkError(err, '拉取');
  });
  if (listRes.status === 404) {
    throw new GithubServiceError(
      '仓库里还没有备份文件',
      false,
      'Github 拉取失败（404）：仓库里还没有备份文件',
    );
  }
  if (listRes.status !== 200) {
    throw await classifyStatusError(listRes, '列出备份文件', '拉取');
  }

  const body = await readJsonSafe<unknown>(listRes, '列出备份文件', '拉取');
  if (!Array.isArray(body)) {
    throw new GithubServiceError(
      'GitHub 返回了无法解析的备份列表，请稍后重试',
      true,
      'Github 拉取失败（响应）：备份列表不是数组',
    );
  }
  // AJ-A Q1：列表聚合——分片文件（<组名>.partNNN）按组名合并成一条
  // （name = 组名、size = 各片之和、sha = part001、parts = 片数）；旧
  // 单文件 zip 原样保留（parts 缺省）。分片组与同名单文件 zip 并存时取
  // 分片组（同名冲突检查本就阻止两者并存，此处为防御性兜底）。
  const plainFiles = new Map<string, RemoteFile>();
  const shardGroups = new Map<string, Map<number, { size: number; sha: string }>>();
  for (const entry of body) {
    const e = entry as ContentsEntryJson;
    if (e.type !== 'file') continue; // 目录条目跳过
    if (typeof e.name !== 'string' || typeof e.path !== 'string') continue;
    if (typeof e.size !== 'number' || typeof e.sha !== 'string') continue;
    const shardMatch = SHARD_PART_NAME_RE.exec(e.name);
    if (shardMatch !== null) {
      const groupName = shardMatch[1] as string;
      const partNo = Number(shardMatch[2]);
      if (partNo < 1 || partNo > 999) continue;
      let group = shardGroups.get(groupName);
      if (group === undefined) {
        group = new Map<number, { size: number; sha: string }>();
        shardGroups.set(groupName, group);
      }
      group.set(partNo, { size: e.size, sha: e.sha });
      continue;
    }
    plainFiles.set(e.name, { name: e.name, path: e.path, size: e.size, sha: e.sha });
  }
  const files: RemoteFile[] = [];
  for (const [name, file] of plainFiles) {
    if (shardGroups.has(name)) continue; // 同名时取分片组（防御性兜底）
    files.push(file);
  }
  for (const [groupName, parts] of shardGroups) {
    // 分片必须从 001 连续到 N（推送侧一个 commit 原子落全部分片，缺号只可能
    // 出现在仓库被外部改动的场景）。缺号的组跳过——按序拼接会得到坏包，
    // 恢复侧宁可少列也不给一个必然失败的条目。
    const partNos = [...parts.keys()].sort((a, b) => a - b);
    let contiguous = partNos.length > 0 && (partNos[0] === 1);
    for (let i = 1; i < partNos.length; i++) {
      if ((partNos[i] as number) !== ((partNos[i - 1] as number) + 1)) {
        contiguous = false;
        break;
      }
    }
    if (!contiguous) continue;
    const firstPart = parts.get(1);
    if (firstPart === undefined) continue;
    const totalSize = [...parts.values()].reduce((sum, p) => sum + p.size, 0);
    files.push({
      name: groupName,
      path: `backups/${groupName}`,
      size: totalSize,
      sha: firstPart.sha,
      parts: partNos.length,
    });
  }
  // 按 name 降序（文件名含 UTC 时间戳，字典序 = 时间序），前 20 条。
  files.sort((a, b) => (a.name > b.name ? -1 : a.name < b.name ? 1 : 0));
  return files.slice(0, REMOTE_BACKUPS_LIMIT);
}

/** 从 GET /repos 的 200 响应读 default_branch（缺失回落 'main'）。 */
async function readDefaultBranchOf(res: Response): Promise<string> {
  // W-A 设置2：响应体读取走归类包装（拉取序列）。
  const body = await readJsonSafe<RepoJson>(res, '查询仓库（拉取）', '拉取');
  return typeof body.default_branch === 'string' && body.default_branch.length > 0
    ? body.default_branch
    : 'main';
}

export interface GithubDownloadArgs {
  /** PAT。只进 Authorization 头，绝不进日志 / 错误对象 / 返回值。 */
  token: string;
  owner: string;
  repo: string;
  /** 列表元素里的 path（形如 `backups/sewing-space-backup-….zip`）。 */
  path: string;
  /** 列表元素里的 size（字节）。下载前做 80 MB 前置检查（分片组为各片之和）。 */
  size: number;
  /**
   * AJ-A Q1：分片数（来自列表聚合的 RemoteFile.parts）。> 1 时按
   * `backups/<组名>.part001 … .partNNN` 逐片下载、按序拼接还原 zip；
   * 缺省（旧格式）单文件整包下载。
   */
  parts?: number;
  /** 注入网络层；缺省用全局 fetch。 */
  fetchImpl?: FetchLike;
}

/**
 * §9.6 第 ② 步：下载选中的备份文件，返回 zip Blob。
 * - 下载前检查 size：超过 80 MB 直接拒绝（移动端 Safari 的内存限制，
 *   §9.6「下载前检查 size 字段」）
 * - GET /repos/{owner}/{repo}/contents/{path} 带
 *   `Accept: application/vnd.github.raw`，直接拿二进制字节（不走 base64）
 * - 200 → `await res.arrayBuffer()` 一次性读完字节（§9.6：覆盖阶段不再
 *   回头读网络流），包成 Blob 返回
 * - AJ-A Q1：parts > 1 时逐片下载（每片 ≤10MB，请求体体积与推送侧对齐），
 *   按序号拼接成完整 zip；旧单文件格式（parts 缺省）走原路径，完全兼容。
 * - 其他 → §9.5 分支（verb 用「拉取」）
 * 本函数不写库、不写日志——收尾归 backupService。
 */
export async function downloadBackupZip(args: GithubDownloadArgs): Promise<Blob> {
  const doFetch: FetchLike = args.fetchImpl ?? ((url, init) => fetch(url, init));

  if (args.token === '' || args.owner === '' || args.repo === '') {
    throw new GithubServiceError(
      'GitHub 备份未配置完整，请到设置页填写令牌、用户名与仓库名',
      false,
      'Github 拉取失败（配置）：令牌、用户名或仓库名为空',
    );
  }
  if (args.size > MAX_BACKUP_ZIP_BYTES) {
    throw new GithubServiceError(
      '这个备份文件过大，无法在此设备上下载',
      false,
      `Github 拉取失败（422）：备份包过大（远端 ${args.size} 字节，超过 80 MB 上限）`,
    );
  }

  const rawHeaders = {
    Accept: 'application/vnd.github.raw',
    'X-GitHub-Api-Version': '2022-11-28',
    Authorization: `Bearer ${args.token}`,
  };

  // 逐片下载单片的字节（raw Accept 直读二进制）。任何非 200 走 §9.5 分支。
  const downloadRaw = async (path: string, verb: string): Promise<ArrayBuffer> => {
    const res = await ghFetch(
      doFetch,
      `${API_BASE}/repos/${args.owner}/${args.repo}/contents/${path}`,
      { method: 'GET', headers: rawHeaders },
      GH_UPLOAD_TIMEOUT_MS,
    ).catch((err: unknown) => {
      throw classifyNetworkError(err, '拉取');
    });
    if (res.type === 'opaque') {
      throw new GithubServiceError(
        '网络连接中断，请检查网络后重试',
        true,
        'Github 拉取失败（网络中断）：网络连接中断（不透明响应）',
      );
    }
    if (res.status !== 200) {
      throw await classifyStatusError(res, verb, '拉取');
    }
    // 一次性读完字节（§9.6：parseBackup 拿到的是完整 ArrayBuffer，覆盖阶段
    // 不再碰网络流）。W-A 设置2：读取走归类包装——Safari 弱网下 zip 下载
    // 中途断流正是本次报障「Load failed」的路径，不再直出原生文案。
    return await readArrayBufferSafe(res, '拉取');
  };

  // 分片组：按序号逐片下载、拼接（AJ-A Q1 恢复侧）。
  if (args.parts !== undefined && args.parts > 1) {
    const filename = args.path.replace(/^backups\//, '');
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (let i = 1; i <= args.parts; i++) {
      const buf = await downloadRaw(shardPartPath(filename, i), `下载备份分片（第 ${i} 片）`);
      chunks.push(new Uint8Array(buf));
      total += buf.byteLength;
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new Blob([merged], { type: 'application/zip' });
  }

  // 旧格式：单文件整包下载。
  const buf = await downloadRaw(args.path, '下载备份文件');
  return new Blob([buf], { type: 'application/zip' });
}


// ============================ §12.3 测试连接 ============================

/** §12.3 测试连接四态：成功 / 凭据被拒 / 仓库不存在 / 网络失败。 */
export type GithubConnectionState = 'success' | 'auth_rejected' | 'repo_missing' | 'network';

export interface GithubTestConnectionArgs {
  /** PAT。只进 Authorization 头，绝不进日志 / 错误对象 / 返回值。 */
  token: string;
  owner: string;
  repo: string;
  /** 注入网络层；缺省用全局 fetch。 */
  fetchImpl?: FetchLike;
}

export interface GithubTestConnectionResult {
  state: GithubConnectionState;
  /** HTTP 状态码；请求未达（网络失败）时为 null。 */
  status: number | null;
  /**
   * auth_rejected 细分（AH-A Q7）：'invalid' = 401 令牌无效/已过期；
   * 'forbidden' = 403 权限不足（令牌本身有效但该端点拒绝）。其他 state 为 null。
   * 测试连接只调 GET /repos（读权限即可），读通 ≠ 推送可用（推送还需
   * Contents 写权限与建仓权限）——reason 只用于 UI 文案分流，不改变四态。
   */
  reason: 'invalid' | 'forbidden' | null;
}

/**
 * AH-A Q7：403 权限不足的统一文案（测试连接 / 推送共用）。
 * 同时覆盖 classic PAT（public_repo scope）与 fine-grained PAT
 * （Contents: Read and write 权限）两种令牌类型的自助排查指引。
 */
export const TOKEN_FORBIDDEN_HINT =
  '令牌权限不足：classic PAT 需勾选 repo（或 public_repo）scope；fine-grained PAT 需在该令牌的 Repository permissions 里给 Contents: Read and write 权限（推送备份还需要 Administration: Read and write 用于自动建仓）';

/**
 * §12.3「测试连接」：GET /repos/{owner}/{repo} 验证凭据与仓库可达性。
 * - 200 → success（远端返回可写）
 * - 401 / 403 → auth_rejected（凭据被拒：令牌无效、已过期或权限不足）
 * - 404 → repo_missing（仓库不存在）
 * - opaque / 网络异常 / 超时 / 其余状态码（5xx 等）→ network（请求未达，稍后再试）
 *
 * 只返回分类结果，不写任何设置、不写备份日志（§12.3：测试连接不写入
 * 任何设置，§13.4：测试连接不写日志）。界面文案（成功/错误/警告三色）
 * 由 UI 层按 §12.3 逐字映射，服务层不掺用户文案。
 */
export async function testGithubConnection(
  args: GithubTestConnectionArgs,
): Promise<GithubTestConnectionResult> {
  const doFetch: FetchLike = args.fetchImpl ?? ((url, init) => fetch(url, init));
  try {
    const res = await ghFetch(
      doFetch,
      `${API_BASE}/repos/${args.owner}/${args.repo}`,
      {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          Authorization: `Bearer ${args.token}`,
        },
      },
      GH_TIMEOUT_MS,
    );
    if (res.type === 'opaque') return { state: 'network', status: null, reason: null };
    if (res.status === 200) return { state: 'success', status: 200, reason: null };
    if (res.status === 401 || res.status === 403) {
      return { state: 'auth_rejected', status: res.status, reason: res.status === 403 ? 'forbidden' : 'invalid' };
    }
    if (res.status === 404) return { state: 'repo_missing', status: 404, reason: null };
    // 其余状态码（5xx 等）按 §12.3 三类失败归「网络失败，稍后再试」。
    return { state: 'network', status: res.status, reason: null };
  } catch {
    // 网络异常（TypeError）与超时（AbortError）都属「请求未达」。
    return { state: 'network', status: null, reason: null };
  }
}
