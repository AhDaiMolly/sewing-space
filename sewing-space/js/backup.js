/**
 * backup.js · 一键导出 / 恢复 zip
 * 缝纫空间 M1.5 下半
 *
 * 职责：
 *   - exportToZip()    8 表 JSON + 图片 Blob 打包为 zip
 *   - importFromZip()  解压 zip 并完整恢复数据 + 图片（两阶段：先解析+暂存 → 逐表顺序写入）
 *
 * zip 文件结构：
 *   sewing-space-backup-YYYYMMDD-HHmm.zip
 *     ├── data.json
 *     └── images/
 *         ├── <id>.jpg
 *         ├── <id>.png
 *         └── ...
 *
 * data.json 格式（PRD v6.0 §12.2 口径）：
 *   {
 *     "format": "sewing-space-backup",
 *     "formatVersion": 4,
 *     "exportedAt": "ISO 时间",
 *     "deviceId": "...",
 *     "counts": {...},
 *     "tables": { materials:[], garments:[], tasks:[], taskTemplates:[],
 *                  settings:{}, usageLogs:[], backupLogs:[], images:[meta] },
 *     "images": [{id, entityType, entityId, mimeType, size, createdAt}]
 *   }
 *
 * 约束：
 *   - 零框架；仅 JSZip（vendor/jszip.min.js）+ Dexie
 *   - settings 白名单保护（github_token 等本地指纹字段不会被 zip 覆盖）
 *   - 双阶段恢复：先 fetch+解压到内存（不可见写入），用户确认后逐表事务写入
 */

(function (global) {
  'use strict';

  const { nanoid, nowIso, log } = global.SS.utils;
  const db = global.SS.db.db;

  const BACKUP_FORMAT = 'sewing-space-backup';
  const BACKUP_FORMAT_VERSION = 4;

  // 恢复时**保留**不覆盖的 settings（设备/账号指纹/标记等不可迁移数据）
  // PRD v6.0 §12.7 — 这些字段保留当前设备的值，不被 zip 覆盖
  const RESTORE_PRESERVE_KEYS = new Set([
    'github_token',
    'github_username',
    'github_repo',
    'pat_expires_at',
    'device_id',
    'user_name',
    'backup_last_success',
    'backup_reminder_last',
    'onboarding_completed',
  ]);

  // 7 张结构表（settings 单独走白名单规则，images 单独走子目录）
  const STRUCT_TABLE_NAMES = [
    'materials', 'garments', 'tasks', 'taskTemplates',
    'usageLogs', 'backupLogs', 'settings',
  ];

  /* ============ 1. 导出 ============ */

  /**
   * 全量导出为 zip Blob。
   * @param {Object} [opts]
   * @param {Function} [opts.onProgress] (stage, ratio, msg) => void
   * @returns {Promise<{blob, fileName, counts, sizeBytes, elapsedMs}>}
   */
  async function exportToZip(opts = {}) {
    const onProgress = opts.onProgress || (() => {});
    if (typeof global.JSZip === 'undefined') {
      throw new Error('JSZip 未加载：vendor/jszip.min.js 缺失');
    }
    const t0 = performance.now();
    const exportedAt = nowIso();
    onProgress('read', 0.05, '正在读取数据…');
    const deviceId = await getDeviceId();

    // 1.1 读 7 张结构表
    const tables = {};
    const counts = {};
    for (let i = 0; i < STRUCT_TABLE_NAMES.length; i++) {
      const t = STRUCT_TABLE_NAMES[i];
      if (t === 'settings') {
        const rows = await db.settings.toArray();
        // github_token 跳过（PRD §12.4 — 凭据不进 zip）
        tables[t] = rowsToSettingsObject(rows);
      } else {
        const rows = await db.table(t).toArray();
        tables[t] = rows;
      }
      counts[t] = tables[t].length;
      onProgress('read', 0.05 + 0.40 * ((i + 1) / STRUCT_TABLE_NAMES.length), `读取 ${t}（${counts[t]} 条）`);
    }

    // 1.2 读 images 表
    const allImages = await db.images.toArray();
    counts.images = allImages.length;
    onProgress('read', 0.50, `读取 images（${allImages.length} 条）`);

    const imagesMeta = allImages.map((img) => ({
      id: img.id,
      entityType: img.entityType,
      entityId: img.entityId,
      mimeType: img.mimeType,
      size: img.size || (img.blob ? img.blob.size : 0),
      originalName: img.originalName || '',
      createdAt: img.createdAt,
    }));

    // 1.3 data.json
    const dataJson = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      exportedAt,
      deviceId,
      counts,
      tables,
      images: imagesMeta,
    };

    // 1.4 JSZip 装
    const zip = new global.JSZip();
    zip.file('data.json', JSON.stringify(dataJson, null, 2));
    // 空 images 容错：仅在有图片时创建 images/ 目录，避免 zip 内残留空目录占位
    const imgFolder = imagesMeta.length > 0 ? zip.folder('images') : null;

    let packedImages = 0;
    let totalImageBytes = 0;
    for (const meta of imagesMeta) {
      const row = allImages.find((r) => r.id === meta.id);
      if (!row || !row.blob || !imgFolder) continue;
      const ext = mimeToExt(meta.mimeType);
      imgFolder.file(`${meta.id}.${ext}`, row.blob);
      packedImages += 1;
      totalImageBytes += (row.blob && row.blob.size) || 0;
      if (packedImages % 16 === 0 || packedImages === imagesMeta.length) {
        onProgress('pack-images', 0.55 + 0.30 * (packedImages / Math.max(1, imagesMeta.length)), `打包图片 ${packedImages}/${imagesMeta.length}`);
        await new Promise((r) => setTimeout(r, 0)); // 让 UI 喘口气
      }
    }

    onProgress('pack-zip', 0.88, '正在生成 zip…');
    const blob = await zip.generateAsync({
      type: 'blob',
      compression: 'STORE', // 图片已 JPEG 压缩，STORE 最快；data.json 占比小
    });

    const elapsedMs = Math.round(performance.now() - t0);
    const stamp = exportedAt.slice(0, 16).replace(/[-:T]/g, '').replace(' ', '-');
    const fileName = `sewing-space-backup-${stamp}.zip`;
    onProgress('done', 1.0, `导出完成 · ${formatBytes(blob.size)} · 用时 ${(elapsedMs / 1000).toFixed(1)}s`);

    return {
      blob,
      fileName,
      counts: { ...counts, totalImages: packedImages, imageBytes: totalImageBytes },
      sizeBytes: blob.size,
      elapsedMs,
    };
  }

  /**
   * settings 行 → 对象（导出时跳过 github_token，符合 PRD §12.4 凭据不进 zip 口径）
   */
  function rowsToSettingsObject(rows) {
    const out = {};
    for (const r of rows) {
      if (!r || !r.key) continue;
      if (r.key === 'github_token') continue;
      out[r.key] = r.value;
    }
    return out;
  }

  function mimeToExt(mime) {
    if (!mime) return 'jpg';
    if (mime.indexOf('jpeg') >= 0 || mime.indexOf('jpg') >= 0) return 'jpg';
    if (mime.indexOf('png') >= 0) return 'png';
    if (mime.indexOf('webp') >= 0) return 'webp';
    if (mime.indexOf('gif') >= 0) return 'gif';
    return 'jpg';
  }

  /* ============ 2. 导入 / 恢复 ============ */

  /**
   * 从 zip File/Blob 完整恢复。两阶段返回：
   *   1) 解析 zip → 暂存数据 + 图片 Blob 到内存（**不写数据库**）
   *   2) 调用 commit() 在用户确认后逐表事务写入
   *
   * @returns {Promise<{preview, counts, elapsedMs, commit: () => Promise<...>}>}
   */
  async function importFromZip(zipFile, opts = {}) {
    const onProgress = opts.onProgress || (() => {});
    if (typeof global.JSZip === 'undefined') {
      throw new Error('JSZip 未加载：vendor/jszip.min.js 缺失');
    }
    const t0 = performance.now();

    onProgress('parse', 0.05, '正在解析 zip…');
    const zip = await global.JSZip.loadAsync(zipFile);

    const dataFile = zip.file('data.json');
    if (!dataFile) throw new Error('zip 缺少 data.json');
    const dataText = await dataFile.async('string');
    let dataJson;
    try {
      dataJson = JSON.parse(dataText);
    } catch (e) {
      throw new Error('data.json 不是合法 JSON：' + e.message);
    }

    if (dataJson.format !== BACKUP_FORMAT) {
      throw new Error(`zip 格式不匹配：期望 ${BACKUP_FORMAT}，实际 ${dataJson.format || '(空)'}`);
    }
    if (typeof dataJson.formatVersion !== 'number' || dataJson.formatVersion < 1 || dataJson.formatVersion > BACKUP_FORMAT_VERSION) {
      throw new Error(`formatVersion 不兼容：期望 1..${BACKUP_FORMAT_VERSION}，实际 ${dataJson.formatVersion}`);
    }
    onProgress('parse', 0.20, '解析 data.json 完成');

    // 阶段 A：图片暂存，同时记录缺失图片（P2② 要素③ 缺失清单数据源）
    const stagedImages = [];
    const missingImages = [];
    const imagesMeta = Array.isArray(dataJson.images) ? dataJson.images : [];
    for (let i = 0; i < imagesMeta.length; i++) {
      const meta = imagesMeta[i];
      const ext = mimeToExt(meta.mimeType);
      const file = zip.file(`images/${meta.id}.${ext}`);
      if (!file) {
        log('[backup] 图片文件缺失:', meta.id);
        missingImages.push({ id: meta.id, entityType: meta.entityType, entityId: meta.entityId, mimeType: meta.mimeType });
        continue;
      }
      const blob = await file.async('blob');
      stagedImages.push({ meta, blob });
      if (i % 16 === 0 || i === imagesMeta.length - 1) {
        onProgress('stage-images', 0.20 + 0.45 * ((i + 1) / Math.max(1, imagesMeta.length)), `暂存图片 ${i + 1}/${imagesMeta.length}`);
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    const preview = {
      counts: dataJson.counts || {},
      formatVersion: dataJson.formatVersion,
      exportedAt: dataJson.exportedAt,
      deviceId: dataJson.deviceId,
      fileSizeBytes: zipFile.size,
      imagesStaged: stagedImages.length,
      missingImagesCount: missingImages.length,
    };

    const elapsedMs = Math.round(performance.now() - t0);
    onProgress('staged', 0.70, `暂存完成 · ${stagedImages.length} 张图片 · 解析用时 ${(elapsedMs / 1000).toFixed(1)}s`);

    return {
      preview,
      counts: preview.counts,
      elapsedMs,
      missingImages,
      staged: {
        tables: dataJson.tables || {},
        images: stagedImages,
      },
      // 阶段 B：用户确认后调用
      commit: () => commitRestore(dataJson.tables || {}, stagedImages, onProgress),
    };
  }

  /**
   * 阶段 B：写入所有 8 张表。
   * 设计要点：
   *   1) 先取本地的 settings 白名单快照；
   *   2) 按表顺序 clear → bulkPut（Dexie 每次操作走隐式事务，避免显式 transaction 的 InactiveTransactionError）；
   *   3) 用本地白名单快照 put 回去覆盖 zip 内同名键（保护本地不可迁移字段）；
   *   4) 最后写一条 backupLogs（kind=restore, status=success）作为痕迹。
   */
  async function commitRestore(tables, stagedImages, onProgress) {
    onProgress('write', 0.72, '正在写入数据…');
    const t0 = performance.now();
    let totalRows = 0;
    let totalImages = 0;

    // 4.1 取本地 settings 白名单快照（在 clear 之前取，避免被覆盖）
    const localPreserve = {};
    for (const k of RESTORE_PRESERVE_KEYS) {
      const cur = await db.settings.get(k);
      if (cur) localPreserve[k] = cur;
    }

    // 4.2 逐表 clear + bulkPut（Dexie 隐式事务；不需显式 db.transaction 调用）
    for (let i = 0; i < STRUCT_TABLE_NAMES.length; i++) {
      const t = STRUCT_TABLE_NAMES[i];
      const tbl = db.table(t);
      await tbl.clear();
      if (t === 'settings') {
        const obj = tables[t] || {};
        const rows = Object.keys(obj).map((k) => ({
          key: k,
          value: obj[k],
          updatedAt: nowIso(),
        }));
        if (rows.length > 0) {
          await tbl.bulkPut(rows);
          totalRows += rows.length;
        }
      } else {
        const rows = Array.isArray(tables[t]) ? tables[t] : [];
        if (rows.length > 0) {
          await tbl.bulkPut(rows);
          totalRows += rows.length;
        }
      }
      onProgress('write', 0.72 + 0.20 * ((i + 1) / STRUCT_TABLE_NAMES.length), `写入 ${t}`);
      // 让出事件循环，确保后续 db 操作拿到最新状态
      await new Promise((r) => setTimeout(r, 0));
    }

    // 4.3 settings 白名单 put 回去（在 settings.bulkPut 之后，本次 put 覆盖 zip 内同名键）
    for (const k of RESTORE_PRESERVE_KEYS) {
      if (localPreserve[k]) {
        await db.settings.put(localPreserve[k]);
      }
    }

    // 4.3b 白名单键本地缺失 → 删除包内值（防 device_id 等本地指纹被 zip 覆写）
    // PRD §12.7 + 产品裁决 P3-4：device_id 继承包内值会破坏 §13 多设备冲突检测前提
    for (const k of RESTORE_PRESERVE_KEYS) {
      if (!localPreserve[k]) {
        await db.settings.delete(k);
      }
    }

    // 4.4 images：先 clear 再按顺序 put
    await db.images.clear();
    for (let i = 0; i < stagedImages.length; i++) {
      const { meta, blob } = stagedImages[i];
      if (!blob) continue;
      await db.images.put({
        id: meta.id,
        blob,
        originalName: meta.originalName || '',
        mimeType: meta.mimeType || blob.type || 'image/jpeg',
        entityType: meta.entityType || '',
        entityId: meta.entityId || '',
        createdAt: meta.createdAt || nowIso(),
      });
      totalImages += 1;
      if (i % 16 === 0 || i === stagedImages.length - 1) {
        onProgress('write-images', 0.92 + 0.07 * ((i + 1) / Math.max(1, stagedImages.length)), `写入图片 ${i + 1}/${stagedImages.length}`);
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    // 4.5 写 backupLogs（不在 8 表内）
    await db.backupLogs.add({
      id: nanoid(12),
      kind: 'restore',
      status: 'success',
      message: `从 zip 恢复（${totalRows} 行数据, ${totalImages} 张图片）`,
      createdAt: nowIso(),
    });

    const elapsedMs = Math.round(performance.now() - t0);
    onProgress('done', 1.0, `恢复完成 · ${totalRows} 行 · ${totalImages} 张图片 · 用时 ${(elapsedMs / 1000).toFixed(1)}s`);
    return { totalRows, totalImages, elapsedMs };
  }

  /* ============ 3. 设备 ID ============ */

  async function getDeviceId() {
    const row = await db.settings.get('device_id');
    if (row && row.value) return row.value;
    const id = nanoid(16);
    await db.settings.put({ key: 'device_id', value: id, updatedAt: nowIso() });
    return id;
  }

  /* ============ 4. 工具 ============ */

  function formatBytes(b) {
    if (b == null) return '?';
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(2) + ' MB';
    return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  /** 触发浏览器下载 zip Blob。 */
  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 200);
  }

  /* ============ 5. 暴露 ============ */

  global.SS = global.SS || {};
  global.SS.backup = {
    BACKUP_FORMAT,
    BACKUP_FORMAT_VERSION,
    RESTORE_PRESERVE_KEYS,
    exportToZip,
    importFromZip,
    commitRestore,
    downloadBlob,
    formatBytes,
  };
})(window);
