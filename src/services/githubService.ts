// src/services/githubService.ts
//
// GitHub Contents API 接入（架构 v3.0 §9）：只负责「怎么打到 GitHub 上去」。
// 签名里只出现字符串与字节数组，不碰数据库（§9.1 / §9.8）——settings
// 读取、backupLogs 写入、清脏全部归 backupService。本模块的调用形态：
//   - pushBackupZip()：§9.3 完整推送序列（查仓库 → 建仓 → 查同名文件
//     → PUT contents），§9.4 冲突重试（409 三次 / 文件名 -2~-9 八次额度）。
//   - 八类错误分支（§9.5）每类落到 GithubServiceError：中文用户文案 +
//     可重试语义 + 日志文案（「HTTP 状态码 + 一句人话」，不塞响应体）。
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
 */
export class GithubServiceError extends Error {
  readonly retryable: boolean;
  readonly logMessage: string;

  constructor(userMessage: string, retryable: boolean, logMessage: string) {
    super(userMessage);
    this.name = 'GithubServiceError';
    this.retryable = retryable;
    this.logMessage = logMessage;
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
    return new GithubServiceError(
      'GitHub 令牌无效或已过期，请到设置页重新填写',
      false,
      `Github ${verb}失败（401）：令牌无效或已过期（${context}）`,
    );
  }
  if (res.status === 403) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining === '0') {
      return new GithubServiceError(
        'GitHub 请求过于频繁，请稍后再试',
        true,
        `Github ${verb}失败（403）：请求过于频繁（限流剩余 0，${context}）`,
      );
    }
    return new GithubServiceError(
      '令牌权限不足，需要 `public_repo` 权限',
      false,
      `Github ${verb}失败（403）：令牌权限不足（限流剩余 ${remaining ?? '未知'}，${context}）`,
    );
  }
  const detail = firstErrorMessage(body);
  const suffix = detail.length > 0 ? `：${detail.slice(0, 80)}` : '';
  return new GithubServiceError(
    `GitHub 请求失败（${res.status}），请稍后重试`,
    true,
    `Github ${verb}失败（${res.status}）${suffix}`,
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
    );
  }
  if (raw.includes('already exists')) {
    return new GithubServiceError(
      '仓库名已被占用，请换一个名字',
      false,
      `Github 推送失败（422）：仓库名已被占用${raw.length > 0 ? `（${raw.slice(0, 80)}）` : ''}（${context}）`,
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
}

interface RepoJson {
  default_branch?: unknown;
}

interface PutContentsJson {
  commit?: { sha?: unknown };
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

  // ---------- ③→④：409 冲突的完整重试（§9.4，最多 3 次） ----------
  const contentBase64 = bytesToBase64(args.zipBytes);
  const commitMessage = formatCommitMessage(now());

  for (let round = 1; round <= CONFLICT_RETRY_MAX; round++) {
    // ③ 查同名文件：200 → 文件名追加 -2 … -9（额度 8 次，不与 409 共享配额）。
    let filename = args.filename;
    let nameAvailable = false;
    for (let suffix = 1; suffix <= FILENAME_SUFFIX_MAX; suffix++) {
      const check = await ghFetch(
        doFetch,
        `${API_BASE}/repos/${args.owner}/${args.repo}/contents/backups/${filename}`,
        { method: 'GET', headers: authHeaders },
        GH_TIMEOUT_MS,
      ).catch((err: unknown) => {
        throw classifyNetworkError(err);
      });
      if (check.status === 404) {
        nameAvailable = true;
        break;
      }
      if (check.status === 200) {
        if (suffix === FILENAME_SUFFIX_MAX) {
          throw new GithubServiceError(
            '同名备份文件过多，请稍后重试',
            true,
            `Github 推送失败（同名冲突）：同名备份文件过多（已试到 -${FILENAME_SUFFIX_MAX}）`,
          );
        }
        const base = args.filename.replace(/\.zip$/, '');
        filename = `${base}-${suffix + 1}.zip`;
        continue;
      }
      throw await classifyStatusError(check, '查询同名文件');
    }
    if (!nameAvailable) break; // 理论不可达：上面循环要么 break 要么 throw。

    // ④ PUT contents：201 成功；409 → 下一轮完整重试 ③→④；404 → 分支不存在。
    const putRes = await ghFetch(
      doFetch,
      `${API_BASE}/repos/${args.owner}/${args.repo}/contents/backups/${filename}`,
      {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({
          message: commitMessage,
          content: contentBase64,
          branch,
        }),
      },
      GH_UPLOAD_TIMEOUT_MS,
    ).catch((err: unknown) => {
      throw classifyNetworkError(err);
    });
    if (putRes.status === 201) {
      // W-A 设置2：响应体读取走归类包装。
      const body = await readJsonSafe<PutContentsJson>(putRes, '上传备份文件', '推送');
      const sha = body.commit?.sha;
      if (typeof sha !== 'string' || sha.length === 0) {
        throw new GithubServiceError(
          '推送已提交，但 GitHub 未返回提交号，请到仓库确认',
          true,
          'Github 推送失败（响应）：响应里缺少 commit.sha',
        );
      }
      return { branch, commitSha: sha, filename };
    }
    if (putRes.status === 409) {
      if (round === CONFLICT_RETRY_MAX) {
        throw new GithubServiceError(
          '推送冲突，请稍后重试',
          true,
          `Github 推送失败（409）：推送冲突（已重试 ${CONFLICT_RETRY_MAX} 次）`,
        );
      }
      continue;
    }
    if (putRes.status === 404) {
      throw new GithubServiceError(
        '备份仓库的分支不存在，请到设置页重新连接',
        true,
        'Github 推送失败（404）：分支不存在',
      );
    }
    if (putRes.status === 422) {
      throw await classifyUnprocessableEntity(putRes, '上传备份文件');
    }
    throw await classifyStatusError(putRes, '上传备份文件');
  }

  // 循环正常走完仍未 return：只有 409 用尽配额才会到这里（上面 round===MAX 时已 throw，
  // 此行为防御性兜底，语义与 409 用尽一致）。
  throw new GithubServiceError(
    '推送冲突，请稍后重试',
    true,
    `Github 推送失败（409）：推送冲突（已重试 ${CONFLICT_RETRY_MAX} 次）`,
  );
}

// ============================ §9.6 拉取序列（S6-fix P0-1） ============================

/** §9.8：远端备份文件的元数据（只含 name / path / size / sha，不含内容）。 */
export interface RemoteFile {
  name: string;
  path: string;
  size: number;
  sha: string;
}

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
  const files: RemoteFile[] = [];
  for (const entry of body) {
    const e = entry as ContentsEntryJson;
    if (e.type !== 'file') continue; // 目录条目跳过
    if (typeof e.name !== 'string' || typeof e.path !== 'string') continue;
    if (typeof e.size !== 'number' || typeof e.sha !== 'string') continue;
    files.push({ name: e.name, path: e.path, size: e.size, sha: e.sha });
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
  /** 列表元素里的 size（字节）。下载前做 80 MB 前置检查。 */
  size: number;
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

  const res = await ghFetch(
    doFetch,
    `${API_BASE}/repos/${args.owner}/${args.repo}/contents/${args.path}`,
    {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github.raw',
        'X-GitHub-Api-Version': '2022-11-28',
        Authorization: `Bearer ${args.token}`,
      },
    },
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
    throw await classifyStatusError(res, '下载备份文件', '拉取');
  }
  // 一次性读完字节（§9.6：parseBackup 拿到的是完整 ArrayBuffer，覆盖阶段
  // 不再碰网络流）。W-A 设置2：读取走归类包装——Safari 弱网下 zip 下载
  // 中途断流正是本次报障「Load failed」的路径，不再直出原生文案。
  const buf = await readArrayBufferSafe(res, '拉取');
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
}

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
    if (res.type === 'opaque') return { state: 'network', status: null };
    if (res.status === 200) return { state: 'success', status: 200 };
    if (res.status === 401 || res.status === 403) {
      return { state: 'auth_rejected', status: res.status };
    }
    if (res.status === 404) return { state: 'repo_missing', status: 404 };
    // 其余状态码（5xx 等）按 §12.3 三类失败归「网络失败，稍后再试」。
    return { state: 'network', status: res.status };
  } catch {
    // 网络异常（TypeError）与超时（AbortError）都属「请求未达」。
    return { state: 'network', status: null };
  }
}
