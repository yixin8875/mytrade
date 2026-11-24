import type {
  IExternalSaveLoadAdapter,
  StudyTemplateData,
  StudyTemplateMetaInfo,
} from '../../../public/charting_library/charting_library';

/**
 * 库的指标模板默认走 HTTP 存储；本地应用没有这个服务，
 * 请求会退化成 library_path/undefined/undefined/study_templates，
 * 模板列表加载失败后「保存指标模板…」弹不出对话框。
 * 这里用 localStorage 实现 study_templates 所需的几个方法。
 */
const TEMPLATES_KEY = 'mytrade.tv.studyTemplates';
/** 旧版自绘面板的存档，第一次读取时迁移过来 */
const LEGACY_KEY = 'mytrade.studyTemplates:main';

interface StoredTemplate {
  content: string;
  savedAt: number;
}

type TemplateMap = Record<string, StoredTemplate>;

function readMap(): TemplateMap {
  try {
    const raw = window.localStorage.getItem(TEMPLATES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as TemplateMap) : {};
    }
    const legacy = window.localStorage.getItem(LEGACY_KEY);
    if (!legacy) return {};
    const old = JSON.parse(legacy) as Record<
      string,
      { content: unknown; savedAt?: number }
    >;
    const migrated: TemplateMap = {};
    for (const [name, item] of Object.entries(old ?? {})) {
      if (!item || item.content == null) continue;
      migrated[name] = {
        content:
          typeof item.content === 'string' ? item.content : JSON.stringify(item.content),
        savedAt: Number(item.savedAt) || 0,
      };
    }
    writeMap(migrated);
    return migrated;
  } catch {
    return {};
  }
}

function writeMap(map: TemplateMap): void {
  try {
    window.localStorage.setItem(TEMPLATES_KEY, JSON.stringify(map));
  } catch {
    /* 本地存储满/被禁用时不影响图表本身 */
  }
}

export const templateStore = {
  async getAllStudyTemplates(): Promise<StudyTemplateMetaInfo[]> {
    return Object.entries(readMap())
      .sort((a, b) => b[1].savedAt - a[1].savedAt)
      .map(([name]) => ({ name }));
  },

  async saveStudyTemplate(data: StudyTemplateData): Promise<void> {
    const map = readMap();
    map[data.name] = { content: data.content, savedAt: Date.now() };
    writeMap(map);
  },

  async getStudyTemplateContent(info: StudyTemplateMetaInfo): Promise<string> {
    const item = readMap()[info.name];
    if (!item) throw new Error(`模板「${info.name}」不存在`);
    return item.content;
  },

  async removeStudyTemplate(info: StudyTemplateMetaInfo): Promise<void> {
    const map = readMap();
    delete map[info.name];
    writeMap(map);
  },

  // 应用不做图表布局/图表模板/绘图模板的云存储；这些方法只在对应功能打开时才会被调用。
  async getAllCharts(): Promise<never[]> {
    return [];
  },
  async removeChart(): Promise<void> {},
  async saveChart(): Promise<string> {
    // 本应用不保存图表布局；返回一个占位 id，避免库的自动保存流程报错
    return 'local';
  },
  async getChartContent(): Promise<string> {
    return '';
  },
  async getDrawingTemplates(): Promise<string[]> {
    return [];
  },
  async loadDrawingTemplate(): Promise<string> {
    return '';
  },
  async removeDrawingTemplate(): Promise<void> {},
  async saveDrawingTemplate(): Promise<void> {},
  async getChartTemplateContent(): Promise<Record<string, never>> {
    return {};
  },
  async getAllChartTemplates(): Promise<string[]> {
    return [];
  },
  async saveChartTemplate(): Promise<void> {},
  async removeChartTemplate(): Promise<void> {},
  async saveLineToolsAndGroups(): Promise<void> {},
  async loadLineToolsAndGroups(): Promise<null> {
    return null;
  },
} as unknown as IExternalSaveLoadAdapter;
