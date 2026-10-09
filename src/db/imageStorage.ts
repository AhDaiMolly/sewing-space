// src/db/imageStorage.ts
//
// AC-A：images 表存储适配层（dbcore 中间件）。
//
// 根因背景：WebKit（iOS Safari / iOS 26.x 仍有报告，WebKit Bug 188438 /
// Bug 268037）在把含 Blob 值的记录写入 IndexedDB 时，于「准备 Blob/File
// data」阶段（经网络进程写临时文件）统一失败，报
// `UnknownError: Error preparing Blob/File data to be stored in object store`，
// 表现为 images.bulkPut 246/246 全部失败、其余无 Blob 的表全部成功。
//
// 修复口径：**落库形态改为原始字节（Uint8Array）**——结构化克隆内联序列化，
// 不经过 WebKit 的 Blob 临时文件路径，从根上绕开该缺陷；读出时再按
// mimeType 还原成 Blob，全部既有消费方（URL.createObjectURL(row.blob)、
// exportBackup 的 row.blob.arrayBuffer() 等）零改动。
//
// 实现为一层 dbcore 中间件（写入 mutate / 读取 get·getMany·query 三口全拦），
// 覆盖所有经 db.images 的读写路径（addImage 的 add、adoptOrphans 的 put、
// 迁移导入的 bulkPut、恢复的分片 bulkPut/put，以及 get/toArray/where/
// filter/orderBy 等全部读法）。存量 DB 里已按 Blob 形态落的旧行读出时
// 原样透传（Blob → Blob），向后兼容；备份导出格式不变（zip 内仍是原始
// 图片字节文件）。
//
// 事务安全（AE-A Q2 修正口径）：fake-indexeddb 上事务实现宽松，「中间件内
// await blob.arrayBuffer() 不破坏原子性」的旧实证不能外推到 iOS WebKit——
// WebKit 严格执行 IndexedDB 事务失活规则，事务内等待任意异步 API 后事务
// 已提交，后续请求抛 TransactionInactiveError。AE-A 起**所有写路径改为
// 调用方在事务外预转换**（imageRowToStored 导出供调用方使用），中间件
// mutate 的转换仅作漏网兜底。原子性语义不变（分片写入本就逐片独立事务，
// AC-A 分片 + 逐条降级 + failedIds 计数设计照旧）。
//
// 口径变更记录（不改动数据模型文档本身，详见 ac-a-notes.md）：
//   - images 表 `blob` 字段的**落库形态**由 Blob 改为 Uint8Array（TS 类型
//     `ImageRecord.blob: Blob` 维持不变——它是内存/读出形态，不是落库形态）；
//   - Dexie 索引、表结构、备份 zip 格式（data.json + images/*.jpg|png|webp）
//     均不变。

import type {
  DBCore,
  DBCoreAddRequest,
  DBCoreGetManyRequest,
  DBCoreGetRequest,
  DBCoreMutateRequest,
  DBCorePutRequest,
  DBCoreQueryRequest,
  DBCoreTable,
  Middleware,
} from 'dexie';
import type Dexie from 'dexie';
import type { ImageRecord } from './types';

/** 落库形态：blob 字段为原始字节（Uint8Array）。 */
export type StoredImageRow = Omit<ImageRecord, 'blob'> & { blob: Uint8Array };

/** 任意带 blob 字段的行（中间件层面不做完整 ImageRecord 校验）。 */
interface BlobLikeRow {
  blob?: unknown;
  mimeType?: unknown;
}

function isByteData(v: unknown): v is Uint8Array | ArrayBuffer {
  return v instanceof Uint8Array || v instanceof ArrayBuffer;
}

/**
 * 读出方向：落库字节 → Blob（按行内 mimeType 还原类型）。
 * 存量 Blob 形态旧行原样透传；其余形态（异常数据）也原样透传，
 * 由上层既有校验/孤儿清理逻辑处置，本层不吞不造数据。
 */
export function imageRowFromStored<T extends BlobLikeRow>(row: T): T {
  const raw = row.blob;
  if (isByteData(raw)) {
    const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw;
    const mimeType = typeof row.mimeType === 'string' ? row.mimeType : 'image/jpeg';
    return { ...row, blob: new Blob([bytes as unknown as BlobPart], { type: mimeType }) };
  }
  return row;
}

/**
 * 写入方向：Blob → 字节副本（返回新对象，不改调用方入参）。
 *
 * AE-A Q2 关键约束：本函数含 `await blob.arrayBuffer()`，**绝不能在 Dexie
 * 事务作用域内被等待**——IndexedDB 事务在没有 pending 请求的间隙会自动提交
 * （Dexie 官方文档：「you MUST NOT call any other async API … within a
 * transaction scope. If you do, you will get a TransactionInactiveError」）。
 * iOS WebKit 严格执行该行为：事务失活后 bulkPut/put 全部失败。这就是用户
 * 真机「255/255 张图片保存失败」而沙箱 fake-indexeddb（事务实现宽松）复现
 * 不出来的根因——详见 ae-a-notes.md Q2 证据链。
 *
 * 因此所有写 images 的调用方（backupService.putImageRowsResilient /
 * imageService.addImage / adoptOrphans / 迁移导入 bulkPut）都必须在进入
 * db 调用**之前**（事务外）用本函数完成预转换；中间件 mutate 里的转换仅作
 * 漏网兜底，主路径不再依赖。
 */
export async function imageRowToStored<T extends BlobLikeRow>(row: T): Promise<T> {
  if (row.blob instanceof Blob) {
    const bytes = new Uint8Array(await row.blob.arrayBuffer());
    return { ...row, blob: bytes };
  }
  return row;
}

function isImageMutateWithBlob(
  req: DBCoreMutateRequest,
): req is DBCoreAddRequest | DBCorePutRequest {
  return (
    (req.type === 'add' || req.type === 'put') &&
    req.values !== undefined &&
    req.values.some((v) => (v as BlobLikeRow | null)?.blob instanceof Blob)
  );
}

/**
 * 在 db 上安装 images 表存储适配中间件。必须在 db 首次打开前调用
 * （SewingSpaceDB 构造器内），保证所有读写都经过适配。
 */
export function installImageStorageAdapter(db: Dexie): void {
  const middleware: Middleware<DBCore> = {
    stack: 'dbcore',
    name: 'ImageStorageAdapter',
    level: 50,
    create(downcore: DBCore) {
      return {
        ...downcore,
        table(tableName: string): DBCoreTable {
          const downTable = downcore.table(tableName);
          if (tableName !== 'images') return downTable;
          return {
            ...downTable,
            mutate(req: DBCoreMutateRequest) {
              if (isImageMutateWithBlob(req)) {
                return Promise.all(
                  req.values.map((v) => imageRowToStored(v as BlobLikeRow)),
                ).then((values) =>
                  downTable.mutate({ ...req, values: values as typeof req.values }),
                );
              }
              return downTable.mutate(req);
            },
            get(req: DBCoreGetRequest) {
              return downTable.get(req).then((row) =>
                row === undefined || row === null
                  ? row
                  : imageRowFromStored(row as BlobLikeRow),
              ) as ReturnType<typeof downTable.get>;
            },
            getMany(req: DBCoreGetManyRequest) {
              return downTable.getMany(req).then((rows) =>
                rows.map((r) =>
                  r === undefined || r === null ? r : imageRowFromStored(r as BlobLikeRow),
                ),
              ) as ReturnType<typeof downTable.getMany>;
            },
            query(req: DBCoreQueryRequest) {
              return downTable.query(req).then((res) => {
                if (!req.values) return res;
                return {
                  ...res,
                  result: res.result.map((r) =>
                    r !== null && typeof r === 'object'
                      ? imageRowFromStored(r as BlobLikeRow)
                      : r,
                  ) as typeof res.result,
                };
              }) as ReturnType<typeof downTable.query>;
            },
          };
        },
      };
    },
  };
  db.use(middleware);
}
