// src/db/schema.ts
import Dexie, { type EntityTable } from 'dexie';
import type {
  Material,
  Garment,
  Task,
  TaskTemplate,
  UsageLog,
  ImageRecord,
  SettingsRecord,
  BackupLog,
} from './types';

export class SewingSpaceDB extends Dexie {
  materials!: EntityTable<Material, 'id'>;
  garments!: EntityTable<Garment, 'id'>;
  tasks!: EntityTable<Task, 'id'>;
  taskTemplates!: EntityTable<TaskTemplate, 'id'>;
  usageLogs!: EntityTable<UsageLog, 'id'>;
  images!: EntityTable<ImageRecord, 'id'>;
  settings!: EntityTable<SettingsRecord, 'key'>;
  backupLogs!: EntityTable<BackupLog, 'id'>;

  constructor() {
    super('SewingSpaceDB');

    // greenfield：从 version(1) 起，不写任何 upgrade()。见 §1.5。
    this.version(1).stores({
      materials:
        '&id, type, name, category, brand, season, forWhom, purchaseDate, rating, used, createdAt, updatedAt, *tags, *suitableFor',
      garments:
        '&id, status, category, forWhom, patternId, completionDate, createdAt, updatedAt, *materialIds, *tags',
      tasks:
        '&id, status, priority, garmentId, templateId, dueDate, completedAt, createdAt, updatedAt, *tags',
      taskTemplates: '&id, name, category, source, createdAt, updatedAt, *tags',
      usageLogs: '&id, materialId, kind, source, garmentId, createdAt',
      images: '&id, entityType, entityId, [entityType+entityId], createdAt',
      settings: '&key',
      backupLogs: '&id, kind, status, createdAt',
    });
  }
}

/** 全局唯一实例。全项目只允许从本模块 import 这一个 db。 */
export const db = new SewingSpaceDB();
